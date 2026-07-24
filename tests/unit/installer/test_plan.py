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
    assert ids == ["preflight", "config", "data_service", "inference", "migrate", "verify"]
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
