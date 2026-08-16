"""The drift guard's instructions must not disarm the guard.

When the install-by-version topology joined the guard, the **error path** was updated to re-record
both files and the **header comment** was not. For one commit the script's own documentation told an
operator to run:

    shasum -a 256 deploy/docker-compose.prod.yml > deploy/helm/COMPOSE_SOURCE.sha256

which drops the second file from the record entirely — silently un-guarding the very topology the
change had just brought under protection. Following the printed fix would have broken the thing the
fix exists to restore.

The shape is the one this project keeps meeting: a sentence that stops being true while still
reading as authoritative. It survived because a guard has **two** copies of its instruction, the
loud one people see when it fails and the quiet one at the top, and only the loud one was corrected.

These tests bind both copies to the record they are supposed to reproduce, so the instruction can
never name fewer files than the guard actually checks.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / "deploy" / "helm" / "check-parity.sh"
RECORD = REPO / "deploy" / "helm" / "COMPOSE_SOURCE.sha256"


def _guarded_files() -> set[str]:
    """Every path the guard actually verifies, read from the record it verifies against."""
    return {
        line.split(maxsplit=1)[1].strip()
        for line in RECORD.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


def _rerecord_instructions() -> list[str]:
    """Every `shasum … > …RECORD` the script prints or documents — comments included.

    Comments are deliberately in scope. The stale one was a comment, and an operator reading the
    top of the script cannot tell a comment from a command that has stopped being right.
    """
    # `shasum -a 256 <paths> > <record>` WRITES the record; `shasum -a 256 -c <record>` VERIFIES it.
    # Only the first is an instruction to an operator. Two narrowings were needed to get here: the
    # record is spelled literally in the header and as `$RECORD` in the failure message, so matching
    # only the literal missed the loud copy — and matching any `shasum` with a `>` swept in the two
    # verification lines, whose `>` comes from `>/dev/null` and `>&2`.
    return [
        line
        for line in GUARD.read_text(encoding="utf-8").splitlines()
        if re.search(r"shasum\s+-a\s+256\s+(?!-c\b)[^|]*>\s*\$?[\w/.]*(RECORD|COMPOSE_SOURCE)", line)
    ]


def test_the_guard_actually_guards_more_than_one_file() -> None:
    """Precondition for everything below; also the state that made the drift possible."""
    assert len(_guarded_files()) >= 2, (
        "only one file is under the guard, so this test proves nothing yet — and the install-by-"
        "version topology is unreconciled"
    )


def test_every_instruction_names_every_guarded_file() -> None:
    """The regression itself. One instruction naming fewer files than the guard checks is an
    instruction that disarms it."""
    instructions = _rerecord_instructions()
    assert instructions, "the guard documents no way to re-record, which is worse than a wrong one"

    guarded = _guarded_files()
    for instruction in instructions:
        missing = {path for path in guarded if path not in instruction}
        assert not missing, (
            f"this instruction drops {sorted(missing)} from the record, silently removing them "
            f"from the guard:\n    {instruction.strip()}"
        )


def test_the_quiet_copy_and_the_loud_copy_agree() -> None:
    """The header and the failure message are two copies of one fact. They drifted once."""
    text = GUARD.read_text(encoding="utf-8")
    quiet = [line for line in _rerecord_instructions() if line.lstrip().startswith("#")]
    loud = [line for line in _rerecord_instructions() if not line.lstrip().startswith("#")]
    assert quiet, "the header no longer documents how to re-record"
    assert loud, "the failure path no longer tells the operator how to re-record"

    def _paths(line: str) -> set[str]:
        return set(re.findall(r"deploy/[\w./-]+\.ya?ml", line))

    assert _paths(quiet[0]) == _paths(loud[0]), (
        f"the header and the failure message name different files — header {sorted(_paths(quiet[0]))}, "
        f"failure {sorted(_paths(loud[0]))}. They drifted once already, in that direction."
    )
    assert "exit 1" in text, "the guard no longer fails the build"
