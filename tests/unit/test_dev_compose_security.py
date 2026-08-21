"""AUDIT-007 policy for the development Compose and data-image supply chain."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "docker-compose.yml"
DB_DOCKERFILE = REPO / "docker" / "db.Dockerfile"


def _services() -> dict[str, dict[str, Any]]:
    parsed = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    services = parsed.get("services")
    assert isinstance(services, dict)
    return services


def _default_host(port: object) -> str:
    rendered = str(port)
    interpolated = re.match(r"^\$\{[^:}]+:-([^}]+)\}:", rendered)
    return interpolated.group(1) if interpolated else rendered.split(":", 1)[0]


def test_every_development_port_defaults_to_loopback() -> None:
    checked: list[str] = []
    for service_name, service in _services().items():
        for port in service.get("ports") or []:
            checked.append(f"{service_name}:{port}")
            assert _default_host(port) == "127.0.0.1", (
                f"{service_name} publishes {port!r} beyond loopback by default"
            )
    assert checked, "no development ports were inspected; the loopback check is vacuous"


def test_every_prebuilt_development_image_is_pinned_by_tag_and_manifest_digest() -> None:
    checked: list[str] = []
    image_pattern = re.compile(r"^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$")
    for service_name, service in _services().items():
        if service.get("build") is not None:
            continue
        image = service.get("image")
        assert isinstance(image, str), f"{service_name} has no reviewed image identity"
        checked.append(image)
        assert image_pattern.fullmatch(image), (
            f"{service_name} image {image!r} needs a readable tag plus immutable manifest digest"
        )
    assert checked, "no prebuilt images were inspected; the immutable-image check is vacuous"


def test_database_runtime_has_an_explicit_minimal_writable_and_capability_set() -> None:
    database = _services()["db"]
    assert database.get("read_only") is True
    assert database.get("user") == "999:999"
    assert set(database.get("cap_drop") or []) == {"ALL"}
    assert not database.get("cap_add")
    assert set(database.get("security_opt") or []) == {"no-new-privileges:true"}

    tmpfs = {str(value).split(":", 1)[0] for value in (database.get("tmpfs") or [])}
    assert tmpfs == {"/tmp", "/var/run/postgresql"}  # noqa: S108 -- asserted container mount

    writable_volumes = [
        str(value) for value in (database.get("volumes") or []) if not str(value).endswith(":ro")
    ]
    assert writable_volumes == ["db_data:/var/lib/postgresql/data"]


def test_database_build_inputs_are_immutable_and_portable() -> None:
    dockerfile = DB_DOCKERFILE.read_text(encoding="utf-8")
    assert re.search(r"^FROM\s+apache/age@sha256:[0-9a-f]{64}$", dockerfile, re.MULTILINE)
    pgvector = re.search(r"^ARG PGVECTOR_SHA=([0-9a-f]{40})$", dockerfile, re.MULTILINE)
    assert pgvector, "pgvector source is not pinned to a full Git commit"
    assert 'test "$(git rev-parse HEAD)" = "${PGVECTOR_SHA}"' in dockerfile
    assert 'make OPTFLAGS=""' in dockerfile
    assert "apt-get upgrade -y" in dockerfile
    assert "rm -f /usr/local/bin/gosu" in dockerfile
    assert "dirmngr gnupg gnupg-l10n gpg gpg-agent gpgconf gpgsm" in dockerfile
    assert re.search(r"^USER 999:999$", dockerfile, re.MULTILINE)


def test_copy_ready_environment_has_no_password_value() -> None:
    env_example = (REPO / ".env.example").read_text(encoding="utf-8")
    value = next(
        line.split("=", 1)[1]
        for line in env_example.splitlines()
        if line.startswith("POSTGRES_PASSWORD=")
    )
    assert value == ""
