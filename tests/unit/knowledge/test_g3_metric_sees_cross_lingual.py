"""AUDIT-076: G3's metric is one number over a mixed-language set, so it cannot see the failure
mode this product's own language promise makes critical.

Measured on the real host with a live judge — the first time the ≥90% gate ran at all, since the
runner had carried `blocked-by-resource` since it was written:

    aggregate        30/32   93.8%   PASSES the gate
    same language    18/18  100.0%
    cross-lingual    12/14   85.7%   FAILS it

The aggregate passes because a perfect same-language score masks the cross-lingual one. For a
product whose PRD scopes `spa+eng`, cross-lingual is not an edge case — it is the case, and it is
the only place the judge failed.

The two failures, both es/en:

    c7  "La sede está en Andorra."  vs  "The headquarters is in Barcelona."  -> unrelated
    u9  "La metodología es iterativa."  vs  "The premium SLA is 4 hours."    -> contradict

c7 is the dangerous direction: a **missed** contradiction is silent — both claims publish and
nothing is flagged. And it is diagnosable rather than random, because the same judge resolved
`headquarters` ↔ `sede` correctly when the two statements agreed (a1). It links the entity and then
misses the conflict.

The defect recorded here is the metric's, not the model's. A gate that cannot distinguish these two
populations cannot tell an operator whether their configured model is safe for the languages they
actually run.
"""

from __future__ import annotations

import pytest
from evals.contradiction_eval import PairCase, run_contradiction_eval, score_verdicts

from rsc_brain.knowledge.judge import HeuristicJudge, Verdict


def test_the_report_separates_cross_lingual_from_same_language() -> None:
    """One accuracy number over a mixed set hides the population that matters."""
    expected = ["contradict", "contradict"]
    predicted = [Verdict.CONTRADICT, Verdict.UNRELATED]
    report = score_verdicts(expected, predicted, languages=[("en", "en"), ("es", "en")])
    assert report.same_language == (1, 1), "the same-language population is not reported"
    assert report.cross_lingual == (0, 1), "the cross-lingual population is not reported"


def test_a_perfect_same_language_score_cannot_mask_a_failing_cross_lingual_one() -> None:
    """The shape of the real measurement: the aggregate clears 90% while cross-lingual does not."""
    expected = ["agree"] * 18 + ["contradict"] * 14
    predicted = [Verdict.AGREE] * 18 + [Verdict.CONTRADICT] * 12 + [Verdict.UNRELATED] * 2
    languages = [("en", "en")] * 18 + [("es", "en")] * 14
    report = score_verdicts(expected, predicted, languages=languages)
    assert report.accuracy >= 0.90, "the aggregate should pass, which is the whole problem"
    correct, total = report.cross_lingual
    assert correct / total < 0.90, "the cross-lingual population should fail"
    assert not report.passes_gate(0.90), (
        "a gate that only reads the aggregate declares this configuration safe for a product "
        "whose stated languages are Spanish and English"
    )


def test_the_gate_still_passes_when_both_populations_do() -> None:
    expected = ["agree"] * 10
    predicted = [Verdict.AGREE] * 10
    languages = [("en", "en")] * 5 + [("es", "en")] * 5
    assert score_verdicts(expected, predicted, languages=languages).passes_gate(0.90)


def test_languages_stay_optional_for_a_set_that_does_not_carry_them() -> None:
    """The existing callers pass no languages; they must keep working and report the aggregate."""
    report = score_verdicts(["agree"], [Verdict.AGREE])
    assert report.accuracy == 1.0
    assert report.cross_lingual == (0, 0)


async def test_the_runner_carries_each_pair_s_languages_through() -> None:
    pairs = [
        PairCase(
            "same", "The SLA is 24 hours", "The SLA is not 24 hours", "contradict", "en", "en"
        ),
        PairCase(
            "cross", "Vacation policy is 25 days", "PostgreSQL powers it", "unrelated", "es", "en"
        ),
    ]
    report = await run_contradiction_eval(HeuristicJudge(), pairs)
    assert report.same_language[1] == 1, "the runner dropped the pair's languages"
    assert report.cross_lingual[1] == 1
    assert report.accuracy == pytest.approx(1.0)
