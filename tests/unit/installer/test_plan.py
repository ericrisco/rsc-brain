"""The install phase catalog + `brain plan` model (SPEC-16, E8.1, AC#1/#4, D8)."""

from __future__ import annotations

import pytest

from rsc_brain.installer.plan import (
    PHASE_IDS,
    ActionKind,
    ForbiddenActionError,
    build_plan,
    make_action,
)

ALL_FREE = {8000: True, 5432: True}


def test_forbidden_action_kind_is_rejected_at_construction() -> None:
    # D8: only container/config/migration ops exist — a host action can't even be built.
    for bad in ("host_apt", "gpu_driver", "shell", "systemctl"):
        with pytest.raises(ForbiddenActionError):
            make_action(bad, "install a host package")
    # The three allowed kinds build fine.
    for good in ("compose", "config", "migration"):
        assert make_action(good, "ok").kind == ActionKind(good)


def test_every_catalog_action_is_container_config_or_migration() -> None:
    # AC#4: audit the whole catalog (both profiles) — no action escapes the D8 allow-list.
    for profile in ("cpu_only", "workstation"):
        plan = build_plan(profile=profile, docker=True, free_ports=ALL_FREE)
        for phase in plan.phases:
            for action in (*phase.actions, *phase.rollback):
                assert action.kind in set(ActionKind)


def test_phase_order_is_stable_and_migrate_is_its_own_phase() -> None:
    plan = build_plan(profile="cpu_only", docker=True, free_ports=ALL_FREE)
    ids = [p.id for p in plan.phases]
    assert ids == list(PHASE_IDS)
    # AUDIT-052 moved `migrate` ahead of `inference` (2026-08-13). The old order was not merely
    # a preference: with `migrate` fourth, the phases before it gated on `brain verify`, which
    # demands the schema at head — so a clean host could never reach the phase that creates it.
    # A real install on a rented box stopped exactly there.
    assert ids == ["preflight", "config", "data_service", "migrate", "inference", "verify"]
    # 12-factor: migrate is a distinct phase, before the terminal verify.
    assert ids.index("migrate") < ids.index("verify")


def test_inference_backend_follows_the_hardware_profile() -> None:
    # G5: vLLM needs a GPU (workstation); Ollama runs on cpu_only.
    ws = build_plan(profile="workstation", docker=True, free_ports=ALL_FREE)
    cpu = build_plan(profile="cpu_only", docker=True, free_ports=ALL_FREE)
    ws_inf = next(p for p in ws.phases if p.id == "inference")
    cpu_inf = next(p for p in cpu.phases if p.id == "inference")
    assert "vllm" in ws_inf.actions[0].command
    assert "ollama" in cpu_inf.actions[0].command


def test_unmet_host_preconditions_become_blockers_not_actions() -> None:
    # AC#1: plan still lists phases, but declares blockers it never tries to resolve (D8).
    no_docker = build_plan(profile="cpu_only", docker=False, free_ports={5432: True, 8000: True})
    assert no_docker.blocked
    assert any(b.id == "docker" for b in no_docker.blockers)
    assert no_docker.phases  # phases are still planned

    busy_port = build_plan(profile="cpu_only", docker=True, free_ports={5432: False, 8000: True})
    assert any(b.id == "port-5432" for b in busy_port.blockers)

    healthy = build_plan(profile="cpu_only", docker=True, free_ports=ALL_FREE)
    assert not healthy.blocked


def test_plan_to_dict_is_a_stable_agent_contract() -> None:
    payload = build_plan(profile="cpu_only", docker=True, free_ports=ALL_FREE).to_dict()
    assert set(payload) == {"profile", "blocked", "blockers", "phases"}
    phase = payload["phases"][0]  # type: ignore[index]
    assert set(phase) == {
        "id",
        "title",
        "precondition",
        "actions",
        "verify",
        "rollback",
        "destructive",
    }


# --- Regressions from the real-host install run (2026-08-13) ---------------------------------
# A clean host stopped at `data_service` because the catalog asked for a schema that only a
# later phase creates, and the phase before it reported success while leaving an unusable
# password. Both were observed on a rented box, not theorised.


def test_migrate_never_depends_on_the_schema_it_creates() -> None:
    """AUDIT-052: `brain verify` requires the schema AT HEAD, so no phase at or before
    `migrate` may use it as a gate — that is a deadlock: the phase that creates the schema
    cannot require the schema to already exist."""
    plan = build_plan(profile="cpu_only", docker=True, free_ports={8000: True, 5432: True})
    ids = [p.id for p in plan.phases]
    migrate_at = ids.index("migrate")
    for phase in plan.phases[: migrate_at + 1]:
        gates = (phase.precondition.command, phase.verify.command)
        for command in gates:
            assert tuple(command[:2]) != ("brain", "verify"), (
                f"phase {phase.id!r} gates on `brain verify`, which demands the schema at head, "
                f"but it runs at or before `migrate` (position {ids.index(phase.id)} of {ids})"
            )


def test_data_service_precedes_migrate_which_precedes_the_final_verify() -> None:
    """The only ordering that can succeed on a fresh database."""
    ids = [p.id for p in build_plan(profile="cpu_only", docker=True, free_ports={}).phases]
    assert ids.index("data_service") < ids.index("migrate") < ids.index("verify")


def test_config_phase_produces_usable_secrets_not_a_blank_template() -> None:
    """AUDIT-051: the phase used to run `cp -n .env.example .env` and verify with
    `test -f .env` — reporting success while leaving `POSTGRES_PASSWORD=` empty, which the
    next phase refuses. A phase that succeeds must leave the install one step better off."""
    plan = build_plan(profile="cpu_only", docker=True, free_ports={})
    config = next(p for p in plan.phases if p.id == "config")
    assert config.actions, "config must do something"
    action = config.actions[0]
    assert tuple(action.command[:1]) != ("cp",), (
        "copying the template cannot be the whole action: it leaves the password blank"
    )
    assert tuple(config.verify.command) != ("test", "-f", ".env"), (
        "existence of .env does not prove the secrets inside it are usable"
    )


def test_every_brain_command_a_phase_invokes_actually_exists() -> None:
    """The catalog is executable, so a phase that calls a command the CLI does not expose is a
    broken install — and the unit suite must catch it, not the rented host. It did not: the first
    fix shipped a `config` phase calling `brain init-env` while the command was registered into a
    frozen contract list the registrar filters, so it never reached the app."""
    from typer.main import get_command

    from rsc_brain.cli.main import app

    registered = set(get_command(app).commands)  # type: ignore[attr-defined]
    plan = build_plan(profile="cpu_only", docker=True, free_ports={})
    for phase in plan.phases:
        commands = [phase.precondition.command, phase.verify.command]
        commands.extend(action.command for action in phase.actions)
        for command in commands:
            if not command or command[0] != "brain":
                continue
            assert command[1] in registered, (
                f"phase {phase.id!r} invokes `brain {command[1]}`, which the CLI does not expose "
                f"(registered: {sorted(registered)})"
            )


def test_config_phase_leaves_an_application_configuration_behind() -> None:
    """AUDIT-053: `brain migrate` loads full Settings, which require `capabilities` — so with no
    `config.yaml` the migration phase dies on a model-configuration error while trying to create
    database tables. Whatever one thinks of that coupling, the install cannot finish unless the
    config phase produces an application configuration too."""
    plan = build_plan(profile="cpu_only", docker=True, free_ports={})
    config = next(p for p in plan.phases if p.id == "config")
    described = " ".join(a.description for a in config.actions).lower()
    assert "config.yaml" in described or "application configuration" in described, (
        "the config phase must materialise an application configuration, not only .env: "
        f"actions say {described!r}"
    )


def test_no_phase_verifies_with_a_command_that_cannot_fail() -> None:
    """`docker compose ps <svc>` exits 0 whether or not the container exists, so using it as a
    verify made the phase unconditionally 'satisfied' — on a host with nothing running at all.
    A check that cannot fail is not a check."""
    plan = build_plan(profile="cpu_only", docker=True, free_ports={})
    for phase in plan.phases:
        for command in (phase.precondition.command, phase.verify.command):
            assert tuple(command[:3]) != ("docker", "compose", "ps"), (
                f"phase {phase.id!r} gates on `docker compose ps`, which exits 0 even when the "
                "service does not exist"
            )
