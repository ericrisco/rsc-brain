"""Platform-specific invariants for the production Compose overlays."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_DEPLOY = _ROOT / "deploy"


def _load(name: str) -> dict[str, Any]:
    document: dict[str, Any] = yaml.safe_load((_DEPLOY / name).read_text(encoding="utf-8"))
    return document


def _labels(service: dict[str, Any]) -> dict[str, str]:
    labels: dict[str, str] = {}
    for raw_label in service.get("labels") or []:
        key, separator, value = str(raw_label).partition("=")
        if separator:
            labels[key] = value
    return labels


def test_coolify_routes_api_and_console_through_one_explicit_origin() -> None:
    services = _load("docker-compose.coolify.yml")["services"]

    generated_origins = {
        f"{service_name}.{key}"
        for service_name, service in services.items()
        for key in (service.get("environment") or {})
        if str(key).startswith("SERVICE_FQDN_")
    }
    assert not generated_origins, (
        "each Coolify SERVICE_FQDN identifier can create a different public origin; "
        f"found {sorted(generated_origins)}"
    )

    api_labels = _labels(services["api"])
    console_labels = _labels(services["console"])
    namespace = "${COMPOSE_PROJECT_NAME}"
    host = "Host(`${RSC_BRAIN_DOMAIN}`)"
    api_rule = api_labels[f"traefik.http.routers.{namespace}-api.rule"]
    console_rule = console_labels[f"traefik.http.routers.{namespace}-console.rule"]

    assert host in api_rule
    assert console_rule == host
    assert int(api_labels[f"traefik.http.routers.{namespace}-api.priority"]) > int(
        console_labels[f"traefik.http.routers.{namespace}-console.priority"]
    )


def test_coolify_namespaces_traefik_objects_per_compose_project() -> None:
    services = _load("docker-compose.coolify.yml")["services"]
    placeholder = "${COMPOSE_PROJECT_NAME}"

    object_keys = {
        raw_label.partition("=")[0]
        for service_name in ("api", "console")
        for raw_label in services[service_name].get("labels") or []
        if ".routers." in str(raw_label) or ".services." in str(raw_label)
    }

    assert object_keys
    assert all(placeholder in key for key in object_keys)
    alpha = {key.replace(placeholder, "alpha") for key in object_keys}
    beta = {key.replace(placeholder, "beta") for key in object_keys}
    assert alpha.isdisjoint(beta)


def test_dokploy_exposed_services_join_its_proxy_and_internal_networks() -> None:
    compose = _load("docker-compose.dokploy.yml")
    assert compose.get("networks", {}).get("dokploy-network") == {"external": True}

    for service_name in ("api", "console"):
        service = compose["services"][service_name]
        networks = service.get("networks") or []
        assert "dokploy-network" in networks, f"{service_name} is invisible to Dokploy's Traefik"
        assert "default" in networks, f"{service_name} lost the canonical internal network"
        labels = _labels(service)
        assert labels.get("traefik.docker.network") == "dokploy-network", (
            f"{service_name} belongs to multiple networks but does not pin Traefik to its proxy "
            "network, so backend selection can be nondeterministic"
        )
