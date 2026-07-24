"""The `brain apply` executor: idempotence, per-phase rollback, resume, guardrails (SPEC-16, E8.1).

Driven by an in-memory fake so the deterministic phase logic is proven without real docker (that
live path is the E8.3 VM test). AC#2 (idempotent + resumable), AC#3 (rollback the failing phase
only), AC#6 (human confirmation).
"""

from __future__ import annotations

from pathlib import Path

from rsc_brain.installer.apply import CheckpointStore, apply_plan
from rsc_brain.installer.plan import (
    Check,
    InstallPlan,
    Phase,
    PhaseAction,
    build_plan,
    make_action,
)

ALL_FREE = {8000: True, 5432: True}


class FakeInstaller:
    """Implements both ActionRunner and Verifier. A phase's postcondition holds once its actions
    have run; verify-only phases (no actions) start satisfied (the host is fine). A named phase can
    be made to fail its action."""

    def __init__(self, plan: InstallPlan, *, fail_phase: str | None = None) -> None:
        self._action_phase = {a: p.id for p in plan.phases for a in p.actions}
        self._rollback = {a for p in plan.phases for a in p.rollback}
        self.fail_phase = fail_phase
        self.satisfied: set[str] = {p.id for p in plan.phases if not p.actions}
        self.runs: list[str] = []

    def run(self, action: PhaseAction) -> tuple[bool, str]:
        self.runs.append(action.description)
        if action in self._rollback:
            return True, "rolled back"
        phase_id = self._action_phase[action]
        if phase_id == self.fail_phase:
            return False, "injected failure"
        self.satisfied.add(phase_id)
        return True, "ran"

    def check(self, phase: Phase) -> bool:
        return phase.id in self.satisfied


def _plan() -> InstallPlan:
    return build_plan(profile="cpu_only", docker=True, free_ports=ALL_FREE)


def _cp(tmp_path: Path) -> CheckpointStore:
    return CheckpointStore(path=tmp_path / "install-state.json")


def test_apply_then_reapply_is_a_no_op(tmp_path: Path) -> None:
    plan, cp = _plan(), _cp(tmp_path)
    first = apply_plan(
        plan, runner=(f := FakeInstaller(plan)), verifier=f, checkpoints=cp, assume_yes=True
    )
    assert first.ok
    assert {r.id: r.status for r in first.results}["config"] == "applied"

    again = FakeInstaller(plan)
    second = apply_plan(plan, runner=again, verifier=again, checkpoints=cp, assume_yes=True)
    assert second.ok
    assert all(r.status == "skipped" for r in second.results)  # every phase already done
    assert again.runs == []  # AC#2: no work repeated


def test_mid_phase_failure_rolls_back_only_that_phase(tmp_path: Path) -> None:
    plan, cp = _plan(), _cp(tmp_path)
    fake = FakeInstaller(plan, fail_phase="data_service")
    report = apply_plan(plan, runner=fake, verifier=fake, checkpoints=cp, assume_yes=True)

    assert not report.ok
    statuses = {r.id: r.status for r in report.results}
    assert statuses["data_service"] == "rolled_back"  # AC#3
    assert statuses["preflight"] == "skipped" and statuses["config"] == "applied"  # priors intact
    assert "inference" not in statuses and "verify" not in statuses  # stopped, not attempted
    assert any("Stop the db service" in desc for desc in fake.runs)  # the phase rollback ran
    assert cp.completed() == {"preflight", "config"}  # the failed phase is NOT checkpointed


def test_interrupted_apply_resumes_from_checkpoint(tmp_path: Path) -> None:
    plan, cp = _plan(), _cp(tmp_path)
    first = FakeInstaller(plan, fail_phase="data_service")
    assert not apply_plan(plan, runner=first, verifier=first, checkpoints=cp, assume_yes=True).ok
    assert cp.completed() == {"preflight", "config"}

    resumed = FakeInstaller(plan)  # the operator fixed the cause; re-run
    report = apply_plan(plan, runner=resumed, verifier=resumed, checkpoints=cp, assume_yes=True)
    assert report.ok
    statuses = {r.id: r.status for r in report.results}
    assert statuses["preflight"] == "skipped" and statuses["config"] == "skipped"  # checkpointed
    assert statuses["data_service"] == "applied"  # ran on resume
    assert "Start the db service and wait for health" in resumed.runs  # work not skipped this time


def test_apply_requires_human_confirmation(tmp_path: Path) -> None:
    plan, cp = _plan(), _cp(tmp_path)
    fake = FakeInstaller(plan)
    report = apply_plan(
        plan, runner=fake, verifier=fake, checkpoints=cp, confirm=lambda _prompt: False
    )
    assert not report.ok  # AC#6
    assert report.results[0].status == "blocked"
    assert fake.runs == []  # nothing ran without consent


def test_destructive_action_needs_its_own_confirmation(tmp_path: Path) -> None:
    wipe = Phase(
        id="wipe",
        title="Wipe volumes",
        precondition=Check("volumes exist"),
        actions=(make_action("compose", "remove volumes", ("docker", "compose", "down", "-v")),),
        verify=Check("volumes gone"),
        destructive=True,
    )
    plan = InstallPlan(profile="cpu_only", phases=(wipe,), blockers=())
    fake = FakeInstaller(plan)
    # Approve the start prompt, decline the destructive one.
    report = apply_plan(
        plan,
        runner=fake,
        verifier=fake,
        checkpoints=_cp(tmp_path),
        confirm=lambda prompt: "DESTRUCTIVE" not in prompt,
    )
    assert not report.ok
    assert report.results[-1].id == "wipe" and report.results[-1].status == "blocked"
    assert fake.runs == []  # the destructive action never ran


def test_blocked_plan_never_runs(tmp_path: Path) -> None:
    blocked = build_plan(profile="cpu_only", docker=False, free_ports={})
    fake = FakeInstaller(blocked)
    report = apply_plan(
        blocked, runner=fake, verifier=fake, checkpoints=_cp(tmp_path), assume_yes=True
    )
    assert not report.ok
    assert report.results[0].status == "blocked"
    assert "host preconditions" in report.results[0].detail
    assert fake.runs == []
