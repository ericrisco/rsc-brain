"""The install runbook presented two commands that compute nothing as the calibration step (AUDIT-137).

`docs/INSTALL.md` explains, correctly and at length, that τ is per-install and that an uncalibrated
gate "separates sense from nonsense by hundredths on a quantity whose noise is tenths". Then it gave
two commands and closed with "until you have done this, treat every `found: true` as unverified".

`brain eval` reports the composition of a golden set. `brain calibrate` reports that plus which
threshold the configuration uses. **Neither runs a query and neither computes a threshold** — and
`brain calibrate`'s own JSON payload says so, pointing at `python -m evals.gate_run calibrate`. So an
operator could follow the runbook to completion, believe the sentence that told them to, and be
exactly as uncalibrated as before. The product knew and the runbook did not say.

That instrument was also un-aimable until AUDIT-138: it read this repository's fictional corpus and
nothing else, so the honest command the payload named could not be run on the operator's knowledge.
The two findings are one problem — the runbook can only name a working procedure once one exists.
"""

from __future__ import annotations

from pathlib import Path

import pytest

RUNBOOK = Path(__file__).resolve().parents[2] / "docs" / "INSTALL.md"


@pytest.fixture(scope="module")
def calibration_section() -> str:
    """The τ section alone. A term found three chapters away is not guidance in context."""
    text = RUNBOOK.read_text(encoding="utf-8")
    start = text.index("τ is therefore")
    end = text.index("credible but irrelevant.", start)
    return text[start:end]


def test_the_runbook_names_the_command_that_actually_sweeps(calibration_section: str) -> None:
    assert "evals.gate_run calibrate" in calibration_section
    assert "--corpus" in calibration_section, (
        "naming a sweep that can only read the repository's fictional corpus is not a procedure an "
        "operator can run on their own knowledge (AUDIT-138)"
    )


def test_the_runbook_separates_inspecting_from_measuring(calibration_section: str) -> None:
    """The distinction has to be legible at the command, not inferable from a paragraph."""
    inspect_lines = [line for line in calibration_section.splitlines() if line.startswith("brain ")]
    assert inspect_lines, "the two inspection commands are still the ones an operator reaches first"
    assert all("INSPECTS" in line for line in inspect_lines), inspect_lines
    assert "neither computes a threshold" in calibration_section


def test_the_runbook_says_a_fitted_threshold_inflates_what_it_is_quoted_against(
    calibration_section: str,
) -> None:
    """AUDIT-136 measured this on the product's own corpus; an operator told to sweep needs it too,
    because the first thing they will do is sweep on the set they intend to score."""
    assert "0.085" in calibration_section and "0.325" in calibration_section
    assert "held_out" in calibration_section


def test_the_closing_sentence_points_at_the_measurement_not_the_inspection() -> None:
    """The sentence that tells an operator when they may trust `found: true`. If it credits the
    inspection commands, everything above it is undone by its last line."""
    text = RUNBOOK.read_text(encoding="utf-8")
    closing = text[text.index("Until you have run") : text.index("credible but irrelevant.")]
    assert "sweep" in closing
    assert "not only the two inspection commands" in closing
