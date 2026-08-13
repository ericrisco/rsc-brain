"""``brain apply`` — the phased, idempotent, resumable install executor (SPEC-16, E8.1, FR-11.3).

Runs an :class:`~rsc_brain.installer.plan.InstallPlan` phase by phase. Each phase is **skipped**
when it is already done (checkpointed, or its postcondition already holds — idempotence); otherwise
its actions run and its post-verification decides the outcome. A failed post-verification **rolls
back that phase only** — never a prior verified phase — and stops with an actionable report. A
checkpoint is persisted after every verified phase, so a re-run of a complete install is a no-op
and a resumed install continues from the last checkpoint without repeating work.

The runner + verifier are injectable :class:`Protocol`s: a fake drives the idempotence / rollback /
resume tests deterministically, while the real :class:`SubprocessActionRunner` shells out to
``docker compose`` / ``brain`` (the live-container path is exercised by the agent-native VM test,
E8.3 — blocked-by-resource). Human confirmation gates the start and every destructive action
(FR-11.4); ``assume_yes`` bypasses it and is documented as unsafe / CI-only.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from rsc_brain.installer.plan import InstallPlan, Phase, PhaseAction

DEFAULT_STATE_PATH = Path(".rsc/install-state.json")

Confirm = Callable[[str], bool]


class ActionRunner(Protocol):
    def run(self, action: PhaseAction) -> tuple[bool, str]:
        """Execute an action. Returns ``(ok, detail)``; ``ok=False`` triggers the phase rollback."""
        ...


class Verifier(Protocol):
    def check(self, phase: Phase) -> bool:
        """True iff the phase's postcondition currently holds (drives idempotent skips)."""
        ...


@dataclass
class CheckpointStore:
    """Install-local checkpoint state (gitignored ``.rsc/``); the only state the installer keeps —
    the services themselves stay 12-factor (SPEC-01)."""

    path: Path = DEFAULT_STATE_PATH

    def completed(self) -> set[str]:
        if not self.path.is_file():
            return set()
        data = json.loads(self.path.read_text(encoding="utf-8"))
        return {str(x) for x in data.get("completed", [])}

    def mark(self, phase_id: str) -> None:
        done = self.completed()
        done.add(phase_id)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({"completed": sorted(done)}, indent=2) + "\n", encoding="utf-8"
        )

    def reset(self) -> None:
        self.path.unlink(missing_ok=True)


@dataclass(frozen=True, slots=True)
class PhaseResult:
    id: str
    status: str  # skipped | applied | rolled_back | blocked
    detail: str = ""

    def to_dict(self) -> dict[str, object]:
        return {"id": self.id, "status": self.status, "detail": self.detail}


@dataclass(frozen=True, slots=True)
class ApplyReport:
    ok: bool
    results: tuple[PhaseResult, ...]

    def to_dict(self) -> dict[str, object]:
        return {"ok": self.ok, "phases": [r.to_dict() for r in self.results]}


def _declined(phase_id: str, detail: str) -> ApplyReport:
    return ApplyReport(ok=False, results=(PhaseResult(phase_id, "blocked", detail),))


def apply_plan(
    plan: InstallPlan,
    *,
    runner: ActionRunner,
    verifier: Verifier,
    checkpoints: CheckpointStore,
    confirm: Confirm | None = None,
    assume_yes: bool = False,
) -> ApplyReport:
    """Execute ``plan`` idempotently with per-phase checkpoints + rollback. See the module docstring
    for the full contract."""
    # A blocked plan (unmet host precondition, D8) never runs — the human resolves it first.
    if plan.blocked:
        detail = "; ".join(b.detail for b in plan.blockers)
        return _declined("preflight", f"host preconditions unmet: {detail}")

    # Guardrail (FR-11.4): human confirmation before any apply.
    if not assume_yes and not _ask(
        confirm, f"Apply {len(plan.phases)} phases to install rsc-brain ({plan.profile})?"
    ):
        return _declined("apply", "human confirmation declined")

    done = checkpoints.completed()
    results: list[PhaseResult] = []
    for phase in plan.phases:
        # AUDIT-054: a checkpoint records that a phase RAN; what decides a skip is whether its
        # postcondition still HOLDS. Trusting the checkpoint alone made a phase skipped forever
        # once it had run — so an operator who deleted their `.env` and re-ran `apply` was told
        # "config: checkpointed", watched it skip, and hit a failure three phases later with
        # nothing pointing back at the cause. Idempotent has to mean convergent, not merely
        # resumable.
        if verifier.check(phase):  # postcondition holds → nothing to do (checkpointed or not)
            checkpoints.mark(phase.id)
            detail = "checkpointed" if phase.id in done else "already satisfied"
            results.append(PhaseResult(phase.id, "skipped", detail))
            continue

        # Guardrail (FR-11.4): confirm every destructive action before running it.
        if (
            phase.destructive
            and not assume_yes
            and not _ask(confirm, f"Phase '{phase.id}' runs DESTRUCTIVE actions. Proceed?")
        ):
            results.append(PhaseResult(phase.id, "blocked", "destructive action declined"))
            return ApplyReport(ok=False, results=tuple(results))

        failure: str | None = None
        for action in phase.actions:
            ok, detail = runner.run(action)
            if not ok:
                failure = detail or f"action failed: {action.description}"
                break

        if failure is None and verifier.check(phase):
            checkpoints.mark(phase.id)
            results.append(PhaseResult(phase.id, "applied", "verified"))
            continue

        # Failure → roll back THIS phase only (prior verified phases are untouched).
        for action in phase.rollback:
            runner.run(action)
        results.append(PhaseResult(phase.id, "rolled_back", failure or "post-verification failed"))
        return ApplyReport(ok=False, results=tuple(results))

    return ApplyReport(ok=True, results=tuple(results))


def _ask(confirm: Confirm | None, prompt: str) -> bool:
    return bool(confirm(prompt)) if confirm is not None else False


# --- live runner + verifier (blocked-by-resource: exercised by the E8.3 VM test) ---------------


class SubprocessActionRunner:
    """Runs an action's command as a subprocess. Only ever runs container/config/migration commands
    (the plan guarantees the kind; D8). ``brain`` commands run through the same interpreter."""

    def __init__(self, *, cwd: Path | None = None, timeout: int = 600) -> None:
        self._cwd = cwd
        self._timeout = timeout

    def run(self, action: PhaseAction) -> tuple[bool, str]:  # pragma: no cover - needs docker
        if not action.command:
            return True, "no-op"
        try:
            # from a request. The installer's job is to run declared steps; refusing to shell out would
            # be refusing to install.
            result = subprocess.run(  # noqa: S603
                list(action.command),
                cwd=self._cwd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, str(exc)
        detail = (result.stderr or result.stdout or "").strip()[:500]
        return result.returncode == 0, detail


class CommandVerifier:
    """Verifies a phase by running its verify command; exit 0 ⇒ the postcondition holds."""

    def __init__(self, *, cwd: Path | None = None, timeout: int = 120) -> None:
        self._cwd = cwd
        self._timeout = timeout

    def check(self, phase: Phase) -> bool:  # pragma: no cover - needs docker / running services
        command = phase.verify.command
        if not command:
            return True
        try:
            result = subprocess.run(  # noqa: S603
                list(command),
                cwd=self._cwd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return result.returncode == 0
