"""A swept `tau_rerank` is fitted on cases the gate then reports (AUDIT-135).

`_calibrate` builds its sweep from `golden.yaml` — the same file `_measure` scores. So the threshold
is fitted on evaluation cases, and for one family the overlap is total: every `abstain` case is in the
sweep, and `abstain` is exactly what `_measure` prints as "G4 (abstain family)". A G4 number produced
with a swept threshold is therefore fitted, not held out.

That is not automatically wrong — a threshold sweep needs positives and negatives, and removing the
negatives would leave nothing to sweep. What is wrong is producing the number silently, because a
fitted number reads exactly like a held-out one. So the sweep now names the cases it fitted on and
says `held_out: false`, and this test asserts it keeps saying so.

The bias direction matters too, and the output states it: fitting inflates the fitted families, so
comparing a swept route against one using an unswept default understates that route's advantage. The
cross-encoder measurement in `docs/reference/configuration.md` is that comparison, which is why the
caveat belongs next to it.
"""

from __future__ import annotations

import inspect

from evals.gate_run import _calibrate
from evals.schema import Golden


def _golden() -> Golden:
    from evals.gate_run import _load

    return _load(Golden, "golden.yaml")


def test_every_g4_case_really_is_inside_the_sweep() -> None:
    """The premise of the finding, asserted against the corpus rather than assumed."""
    golden = _golden()
    swept = {
        case.id
        for case in golden.cases
        if case.family in {"hit", "abstain", "qualifier"} and case.surface == "recall"
    }
    g4 = {case.id for case in golden.cases if case.family == "abstain"}
    assert g4, "the abstain family is what G4 reports; an empty one would make the gate vacuous"
    assert g4 <= swept, (
        "if G4's cases ever leave the sweep, this finding is fixed and can be closed"
    )


def test_the_sweep_declares_that_it_is_not_held_out() -> None:
    """The disclosure lives in the calibrate phase's own output, where the number is produced."""
    source = inspect.getsource(_calibrate)
    assert '"held_out": False' in source
    assert "g4_cases_inside_this_sweep" in source
    assert "NOT HELD OUT" in source
    assert "understates" in source, "the bias direction is part of the disclosure, not a footnote"
