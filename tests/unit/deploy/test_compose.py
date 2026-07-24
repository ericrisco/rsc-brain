"""Deploy compose lint (SPEC-18, E15.1/E15.2, AC#5): the canonical prod topology is complete and
each PaaS overlay is a thin, non-forking delta on it (principle D18). Pure YAML — no docker."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

_DEPLOY = Path(__file__).resolve().parents[3] / "deploy"
_CANONICAL = _DEPLOY / "docker-compose.prod.yml"
_OVERLAYS = (_DEPLOY / "docker-compose.coolify.yml", _DEPLOY / "docker-compose.dokploy.yml")

_REQUIRED_SERVICES = {"db", "migrate", "api", "worker", "console", "caddy"}
_REQUIRED_VOLUMES = {"db_data", "inbox", "model_cache"}


def _load(path: Path) -> dict[str, Any]:
    doc: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    return doc


def _services(doc: dict[str, Any]) -> dict[str, Any]:
    services: dict[str, Any] = doc.get("services", {}) or {}
    return services


def test_canonical_declares_the_full_production_topology() -> None:
    doc = _load(_CANONICAL)
    services = _services(doc)
    assert set(services) >= _REQUIRED_SERVICES
    assert set(doc.get("volumes", {})) >= _REQUIRED_VOLUMES


def test_migrate_is_a_one_shot_brain_init_gating_api_and_worker() -> None:
    services = _services(_load(_CANONICAL))
    assert services["migrate"]["command"] == ["brain", "init"]
    assert services["migrate"]["restart"] == "no"  # one-shot, not a long-running service
    for dependent in ("api", "worker"):
        cond = services[dependent]["depends_on"]["migrate"]["condition"]
        assert cond == "service_completed_successfully"  # migrate-on-boot (NFR-8)


def test_api_healthcheck_reuses_brain_verify() -> None:
    healthcheck = _services(_load(_CANONICAL))["api"]["healthcheck"]
    assert "verify" in " ".join(healthcheck["test"])  # FR-11.2


def test_caddy_provides_tls_in_the_canonical() -> None:
    caddy = _services(_load(_CANONICAL))["caddy"]
    assert "profiles" not in caddy  # runs by default (raw prod baseline)
    ports = " ".join(str(p) for p in caddy["ports"])
    assert "443" in ports  # HTTPS


@pytest.mark.parametrize("overlay_path", _OVERLAYS, ids=lambda p: p.stem)
def test_overlay_is_a_thin_non_forking_delta(overlay_path: Path) -> None:
    canonical = _services(_load(_CANONICAL))
    overlay = _services(_load(overlay_path))
    # Every overlay service must exist in the canonical — overlays never introduce services.
    assert set(overlay) <= set(canonical), f"{overlay_path.name} adds services not in the canonical"
    # No overlay may re-declare build/image (that would fork the definition, violating D18).
    for name, spec in overlay.items():
        spec = spec or {}
        assert "build" not in spec, f"{overlay_path.name}:{name} forks the build"
        assert "image" not in spec, f"{overlay_path.name}:{name} forks the image"


@pytest.mark.parametrize("overlay_path", _OVERLAYS, ids=lambda p: p.stem)
def test_overlay_drops_caddy_for_the_paas_proxy(overlay_path: Path) -> None:
    caddy = _services(_load(overlay_path)).get("caddy", {})
    # The PaaS proxy terminates TLS, so our Caddy is disabled via a never-activated profile.
    assert "donotstart" in caddy.get("profiles", []), f"{overlay_path.name} must disable caddy"
