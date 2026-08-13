"""Runbook lint (SPEC-16, E8.2, AC#5): docs/INSTALL.md stays complete and in sync with the CLI.

Every catalog phase is documented with the five mandatory fields; the three guardrails are present;
and every `brain <subcommand>` the runbook cites actually exists in the CLI (introspected from the
Click command tree, so it can't drift from the real surface).
"""

from __future__ import annotations

import re
from pathlib import Path

import typer

from rsc_brain.cli.main import app
from rsc_brain.installer.plan import PHASE_IDS

_RUNBOOK = Path(__file__).resolve().parents[3] / "docs" / "INSTALL.md"
_TEXT = _RUNBOOK.read_text(encoding="utf-8")

_MANDATORY_FIELDS = (
    "Precondition:",
    "Verify command:",
    "Success criterion:",
    "Corrective action:",
    "Rollback:",
)


def _phase_sections() -> dict[str, str]:
    """Split the runbook into per-phase sections keyed by phase id (### Phase `<id>` — ...)."""
    parts = re.split(r"^### Phase `([a-z_]+)`", _TEXT, flags=re.MULTILINE)
    # parts = [preamble, id1, body1, id2, body2, ...]
    return dict(zip(parts[1::2], parts[2::2], strict=True))


def test_runbook_exists() -> None:
    assert _RUNBOOK.is_file()


def test_every_phase_is_documented_with_all_five_fields() -> None:
    sections = _phase_sections()
    for phase_id in PHASE_IDS:
        assert phase_id in sections, f"phase {phase_id} missing from docs/INSTALL.md"
        body = sections[phase_id]
        for field in _MANDATORY_FIELDS:
            assert field in body, f"phase {phase_id} missing field {field!r}"


def test_the_three_guardrails_are_present() -> None:
    lowered = _TEXT.lower()
    assert "never read the brain" in lowered
    assert "never hardcode secrets" in lowered
    assert "human confirmation before" in lowered


def test_every_cited_brain_command_exists() -> None:
    root = typer.main.get_command(app)
    known = set(root.commands)  # type: ignore[attr-defined]
    # Hyphenated names are real commands (`wait-for-schema`, `init-env`); the old pattern
    # stopped at the hyphen and compared a fragment, so it both missed typos in the tail
    # and reported false ones for the head.
    cited = set(re.findall(r"`brain ([a-z][a-z-]*)", _TEXT))
    assert cited, "runbook cites no brain commands — did the flow section change?"
    missing = cited - known
    assert not missing, f"runbook cites non-existent brain commands: {sorted(missing)}"
