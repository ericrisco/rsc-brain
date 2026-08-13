"""Declarative install phase catalog + ``brain plan`` model (SPEC-16, E8.1, FR-11.3 / D8).

The installer is data-first: an ordered catalog of **phases**, each with a precondition, a set of
**actions**, a post-verification, and a per-phase rollback. **D8 is enforced at construction** — an
action may only be a container/compose op, a config write, or a database migration; any other kind
(a host package, a GPU driver, an ``apt`` call) is rejected the moment it is built, so no code path
can ever mutate the host. :func:`build_plan` turns a ``brain doctor`` report into the concrete plan
``brain apply`` would run, listing unmet host preconditions as **blockers** it never tries to fix.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum

from rsc_brain.config.models import HardwareProfile

# Ports the stack needs free on the host (API + Postgres) — a busy port is a declared blocker.
REQUIRED_PORTS = (8000, 5432)


class ActionKind(StrEnum):
    """The ONLY action kinds an install phase may perform (D8). Nothing here touches the host."""

    COMPOSE = "compose"  # docker compose up/stop/... — containers only
    CONFIG = "config"  # write a local config/env file
    MIGRATION = "migration"  # brain migrate — schema, not services


class ForbiddenActionError(ValueError):
    """Raised when a phase action falls outside D8's container/config/migration allow-list."""


@dataclass(frozen=True, slots=True)
class PhaseAction:
    kind: ActionKind
    description: str
    command: tuple[str, ...] = ()


def make_action(kind: str, description: str, command: Sequence[str] = ()) -> PhaseAction:
    """Build a phase action, rejecting any kind outside D8 at construction time (FR-11.3 / D8)."""
    try:
        resolved = ActionKind(kind)
    except ValueError as exc:
        raise ForbiddenActionError(
            f"action kind {kind!r} violates D8 — only {[k.value for k in ActionKind]} are allowed "
            "(the installer never touches the host)"
        ) from exc
    return PhaseAction(kind=resolved, description=description, command=tuple(command))


@dataclass(frozen=True, slots=True)
class Check:
    """A phase precondition / success criterion — a human-readable claim plus the mechanical
    command an agent runs to evaluate it over ``--json`` (never ambiguous prose, FR-11.4)."""

    description: str
    command: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Phase:
    id: str
    title: str
    precondition: Check
    actions: tuple[PhaseAction, ...]
    verify: Check
    rollback: tuple[PhaseAction, ...] = ()
    destructive: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "title": self.title,
            "precondition": {
                "criterion": self.precondition.description,
                "command": list(self.precondition.command),
            },
            "actions": [
                {"kind": a.kind.value, "description": a.description, "command": list(a.command)}
                for a in self.actions
            ],
            "verify": {"criterion": self.verify.description, "command": list(self.verify.command)},
            "rollback": [
                {"kind": a.kind.value, "description": a.description, "command": list(a.command)}
                for a in self.rollback
            ],
            "destructive": self.destructive,
        }


@dataclass(frozen=True, slots=True)
class Blocker:
    id: str
    detail: str
    remediation: str

    def to_dict(self) -> dict[str, object]:
        return {"id": self.id, "detail": self.detail, "remediation": self.remediation}


@dataclass(frozen=True, slots=True)
class InstallPlan:
    profile: str
    phases: tuple[Phase, ...]
    blockers: tuple[Blocker, ...]

    @property
    def blocked(self) -> bool:
        return bool(self.blockers)

    def to_dict(self) -> dict[str, object]:
        return {
            "profile": self.profile,
            "blocked": self.blocked,
            "blockers": [b.to_dict() for b in self.blockers],
            "phases": [p.to_dict() for p in self.phases],
        }


def _inference_backend(profile: str) -> str:
    """The local-inference compose profile for a hardware profile: vLLM needs a GPU
    (``workstation``), Ollama runs anywhere (``cpu_only``) — G5."""
    return "vllm" if profile == HardwareProfile.WORKSTATION.value else "ollama"


def _host_blockers(*, docker: bool, free_ports: Mapping[int, bool]) -> tuple[Blocker, ...]:
    blockers: list[Blocker] = []
    if not docker:
        blockers.append(
            Blocker(
                id="docker",
                detail="Docker daemon is not reachable.",
                remediation="Install Docker and start the daemon, then re-run `brain plan`. "
                "The installer never installs Docker for you (host precondition, D8).",
            )
        )
    for port in REQUIRED_PORTS:
        if free_ports.get(port) is False:
            blockers.append(
                Blocker(
                    id=f"port-{port}",
                    detail=f"Port {port} is already in use.",
                    remediation=f"Free port {port} (stop the process using it) and re-run `brain plan`.",
                )
            )
    return tuple(blockers)


def build_plan(*, profile: str, docker: bool, free_ports: Mapping[int, bool]) -> InstallPlan:
    """Materialise the concrete install plan from a ``brain doctor`` report. Pure + side-effect
    free — this is exactly what ``brain apply`` would execute, so ``brain plan`` is a true dry-run."""
    backend = _inference_backend(profile)
    phases: tuple[Phase, ...] = (
        Phase(
            id="preflight",
            title="Verify host preconditions",
            precondition=Check(
                "Docker daemon reachable and required ports free", ("brain", "doctor", "--json")
            ),
            actions=(),  # verify-only: the installer never provisions the host (D8)
            verify=Check(
                "doctor reports docker=true and no busy required port",
                ("brain", "doctor", "--json"),
            ),
        ),
        Phase(
            id="config",
            title="Prepare configuration",
            precondition=Check(
                "a .env template exists to materialise from", ("test", "-f", ".env.example")
            ),
            actions=(
                make_action(
                    "config",
                    "Materialise configuration: .env with generated secrets + config.yaml (idempotent)",
                    ("brain", "init-env"),
                ),
            ),
            # AUDIT-051: existence of the file never proved the secrets inside it were usable.
            verify=Check(
                "every required secret is set (not blank, not a placeholder)",
                ("brain", "init-env", "--check"),
            ),
        ),
        Phase(
            id="data_service",
            title="Start the data service (Postgres 16 + AGE + pgvector)",
            precondition=Check("Docker is available", ("brain", "doctor", "--json")),
            actions=(
                make_action(
                    "compose",
                    "Start the db service and wait for health",
                    ("docker", "compose", "up", "-d", "--wait", "db"),
                ),
            ),
            # AUDIT-052: this used to gate on `brain verify`, which demands the schema AT HEAD —
            # a schema the later `migrate` phase is what creates. The compose action already
            # waits for the container's own healthcheck, so that is what can honestly be asserted
            # here; the full check (extensions + head + capabilities) is the terminal phase's job.
            # `docker compose ps db` exits 0 even when no container exists, so it verified
            # nothing. `pg_isready` inside the service fails when the container is absent, not
            # running, or not yet accepting connections — which is the property this phase claims.
            verify=Check(
                "the db container is running and accepting connections",
                ("docker", "compose", "exec", "-T", "db", "pg_isready", "-q"),
            ),
            rollback=(
                make_action("compose", "Stop the db service", ("docker", "compose", "stop", "db")),
            ),
        ),
        Phase(
            id="migrate",
            title="Apply database migrations",
            precondition=Check(
                "the db container is accepting connections",
                ("docker", "compose", "exec", "-T", "db", "pg_isready", "-q"),
            ),
            actions=(
                make_action(
                    "migration",
                    "Apply all pending migrations to head (idempotent)",
                    ("brain", "migrate"),
                ),
            ),
            verify=Check(
                "schema at head (migrate is a no-op on a migrated DB)", ("brain", "migrate")
            ),
        ),
        Phase(
            id="inference",
            title=f"Start the local inference backend ({backend})",
            precondition=Check(
                "the db container is accepting connections",
                ("docker", "compose", "exec", "-T", "db", "pg_isready", "-q"),
            ),
            actions=(
                make_action(
                    "compose",
                    f"Start the {backend} backend",
                    ("docker", "compose", "--profile", backend, "up", "-d"),
                ),
            ),
            # Same trap as data_service: `ps` exits 0 for a service that was never started.
            # `exec` into the container fails unless it is actually up.
            verify=Check(
                f"the {backend} container is running",
                ("docker", "compose", "exec", "-T", backend, "true"),
            ),
            rollback=(
                make_action(
                    "compose",
                    f"Stop the {backend} backend",
                    ("docker", "compose", "--profile", backend, "stop"),
                ),
            ),
        ),
        Phase(
            id="verify",
            title="Verify the installation",
            precondition=Check("Services started and migrated", ("brain", "verify", "--json")),
            actions=(),  # terminal check: the success gate, not a mutation
            verify=Check("brain verify reports every check green", ("brain", "verify", "--json")),
        ),
    )
    return InstallPlan(
        profile=profile,
        phases=phases,
        blockers=_host_blockers(docker=docker, free_ports=free_ports),
    )


# The ordered phase ids — the runbook lint asserts docs/INSTALL.md documents exactly these.
PHASE_IDS: tuple[str, ...] = tuple(
    p.id for p in build_plan(profile="cpu_only", docker=True, free_ports={}).phases
)
