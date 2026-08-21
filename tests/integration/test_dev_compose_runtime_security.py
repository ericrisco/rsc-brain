"""Real Docker evidence for AUDIT-007's development database boundary."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
IMAGE = "rsc-brain/db:pg16-age-pgvector"
STRONG_PASSWORD = "audit007-integration-strong-password-0000"


def _docker() -> str:
    binary = shutil.which("docker")
    if binary is None:
        pytest.skip("Docker is required for the integration-marked Compose runtime evidence")
    return binary


def _run(
    *args: str,
    env: dict[str, str] | None = None,
    check: bool = True,
    timeout: int = 900,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [_docker(), *args],
        cwd=REPO,
        env=env,
        check=check,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


@pytest.fixture(scope="module")
def built_data_image() -> str:
    env = os.environ | {"POSTGRES_PASSWORD": STRONG_PASSWORD}
    _run("compose", "build", "db", env=env)
    inspected = _run("image", "inspect", IMAGE)
    assert inspected.returncode == 0
    return IMAGE


@pytest.mark.integration
@pytest.mark.parametrize("password", ["", "CHANGE_ME", "short"])
def test_invalid_password_exits_before_postgres_can_be_ready(
    built_data_image: str, password: str
) -> None:
    result = _run(
        "run",
        "--rm",
        "--env",
        f"POSTGRES_PASSWORD={password}",
        built_data_image,
        check=False,
        timeout=30,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "FATAL(entrypoint-guard)" in output
    assert "database system is ready to accept connections" not in output


@pytest.mark.integration
def test_fresh_compose_database_proves_the_complete_runtime_boundary(
    built_data_image: str,
) -> None:
    del built_data_image  # fixture is an executable precondition, not unused setup
    project = f"rscbrain-audit007-{uuid.uuid4().hex[:12]}"
    env = os.environ | {
        "POSTGRES_PASSWORD": STRONG_PASSWORD,
        "RSC_BRAIN_DB_PORT": "0",
    }

    try:
        _run(
            "compose",
            "-p",
            project,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "db",
            env=env,
        )
        container_id = _run("compose", "-p", project, "ps", "-q", "db", env=env).stdout.strip()
        assert container_id, "Compose reported success without a database container"

        inspected = json.loads(_run("inspect", container_id).stdout)[0]
        host = inspected["HostConfig"]
        state = inspected["State"]
        assert state["Running"] is True
        assert state["Health"]["Status"] == "healthy"
        assert host["Privileged"] is False
        assert host["ReadonlyRootfs"] is True
        assert inspected["Config"]["User"] == "999:999"
        assert set(host["CapDrop"]) == {"ALL"}
        assert not host["CapAdd"]
        assert set(host["SecurityOpt"]) == {"no-new-privileges:true"}
        assert set(host["Tmpfs"]) == {
            "/tmp",  # noqa: S108 -- asserted container mount, not host temp data
            "/var/run/postgresql",
        }

        bindings = host["PortBindings"]["5432/tcp"]
        assert bindings and {item["HostIp"] for item in bindings} == {"127.0.0.1"}
        mounts = inspected["Mounts"]
        assert [(mount["Type"], mount["Destination"], mount["RW"]) for mount in mounts] == [
            ("volume", "/var/lib/postgresql/data", True)
        ]

        process = _run(
            "exec",
            "--user",
            "postgres",
            container_id,
            "sh",
            "-c",
            "grep -E '^(Uid|Gid|Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):' /proc/1/status",
        ).stdout
        assert "Uid:\t999\t999\t999\t999" in process
        assert "Gid:\t999\t999\t999\t999" in process
        assert "CapEff:\t0000000000000000" in process
        assert "CapPrm:\t0000000000000000" in process
        assert "CapBnd:\t0000000000000000" in process
        assert "NoNewPrivs:\t1" in process

        write_probe = _run(
            "exec",
            container_id,
            "sh",
            "-c",
            "if touch /etc/audit007-write-probe 2>/dev/null; then exit 9; fi; "
            "touch /tmp/audit007-write-probe; "
            "touch /var/lib/postgresql/data/audit007-write-probe",
        )
        assert write_probe.returncode == 0

        extensions = _run(
            "exec",
            "--user",
            "postgres",
            container_id,
            "psql",
            "-U",
            "rsc_brain",
            "-d",
            "rsc_brain",
            "-Atc",
            "SELECT extname || ':' || extversion FROM pg_extension "
            "WHERE extname IN ('age','vector') ORDER BY extname",
        ).stdout.splitlines()
        assert extensions == ["age:1.6.0", "vector:0.8.5"]

        plperl_count = _run(
            "exec",
            "--user",
            "postgres",
            container_id,
            "psql",
            "-U",
            "rsc_brain",
            "-d",
            "rsc_brain",
            "-Atc",
            "SELECT count(*) FROM pg_available_extensions WHERE name IN ('plperl','plperlu')",
        ).stdout.strip()
        assert plperl_count == "0"
    finally:
        _run(
            "compose",
            "-p",
            project,
            "down",
            "--volumes",
            "--remove-orphans",
            env=env,
            check=False,
            timeout=120,
        )
