"""Every shipped build service must pass the build args its Dockerfile requires (AUDIT-133).

Measured by following `deploy/README.md` on a clean checkout:

    failed to solve: process "/bin/sh -c test -n \"${RSC_BRAIN_BUILD_IDENTITY}\" || { echo ... }"
    did not complete successfully: exit code: 1

The Dockerfile refuses an empty build identity — deliberately, so a build cannot produce an image that
lies about which commit it is. `release.yml` passes it. The Compose topology, which is the path
`deploy/README.md` documents and which defaults to `build:`, did not — so **the published install
runbook could not build**, on any machine, while CI stayed green because CI takes the other path.

Same family as AUDIT-093 (a topology naming an image nobody publishes) one step earlier: this one
cannot even build.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO / "Dockerfile"
COMPOSE = (
    REPO / "deploy" / "docker-compose.prod.yml",
    REPO / "deploy" / "docker-compose.version.yml",
)


def _required_build_args() -> set[str]:
    """Build args the Dockerfile refuses to proceed without."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    declared = set(re.findall(r"^ARG\s+([A-Z0-9_]+)", text, re.M))
    # `test -n "${NAME}" || exit 1` is how this Dockerfile states "required".
    required = set(re.findall(r'test -n\s+\\?"\$\{([A-Z0-9_]+)\}\\?"', text))
    return required & declared


def _services_building_the_app() -> list[tuple[Path, str, dict[str, object]]]:
    found: list[tuple[Path, str, dict[str, object]]] = []
    for path in COMPOSE:
        if not path.is_file():
            continue
        compose = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for name, service in (compose.get("services") or {}).items():
            build = service.get("build")
            if not isinstance(build, dict):
                continue
            # Resolve context + dockerfile: the console service also says `dockerfile: Dockerfile`,
            # and it is a DIFFERENT file (apps/admin/Dockerfile) with different requirements. Matching
            # on the bare name flagged it — a check that names the wrong file is worse than none.
            resolved = (
                path.parent
                / str(build.get("context", "."))
                / str(build.get("dockerfile", "Dockerfile"))
            ).resolve()
            if resolved == DOCKERFILE.resolve():
                found.append((path, name, build))
    return found


def test_the_dockerfile_states_a_required_identity() -> None:
    """If this stops being required, the rest of this file is measuring nothing."""
    assert "RSC_BRAIN_BUILD_IDENTITY" in _required_build_args()


def test_every_app_build_service_passes_the_required_args() -> None:
    required = _required_build_args()
    services = _services_building_the_app()
    assert services, "no shipped Compose service builds the application image"

    missing: list[str] = []
    for path, name, build in services:
        args = build.get("args") or {}
        supplied = set(args) if isinstance(args, dict) else set()
        for arg in required - supplied:
            missing.append(f"{path.name}:{name} does not pass {arg}")

    assert not missing, (
        f"the documented `docker compose build` / `up --build` cannot run without these: {missing}"
    )


def test_the_identity_default_cannot_be_mistaken_for_a_release() -> None:
    """A default is only acceptable if it is honest. `source-build` is unparseable as a version, so
    `identity_release` reports `<version>+source-build` rather than claiming the release."""
    from rsc_brain.identity_release import resolve

    identity = resolve("source-build")

    assert identity.is_published is False
    assert identity.full.endswith("+source-build")
