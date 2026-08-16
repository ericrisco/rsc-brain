"""AUDIT-082: the stratified G3 gate failed open in four ways.

An adversarial review built the truth table and ran it. Every row it flagged is a test here.

    aggregate shape, 2 failures undeclared   gate90=True   <- the failures vanish from the gate
    nothing declared                         gate90=True   <- collapses to the pre-fix behaviour
    languages list shorter than pairs         gate90=True   <- silent mis-attribution
    empty run (0 pairs)                       gate90=True   <- green at any threshold

Every one of those is the most likely way for the metadata to be wrong, which is the worst possible
thing to fail open on. And `as_dict` serialised an unmeasured population as `accuracy: 1.0`, which
manufactures exactly the confidence this whole branch exists to remove.
"""

from __future__ import annotations

import pytest
from evals.contradiction_eval import PairCase, score_verdicts

from rsc_brain.knowledge.judge import Verdict

THRESHOLD = 0.90


def _shape(
    same: int, same_ok: int, cross: int, cross_ok: int
) -> tuple[list[str], list[Verdict], list[tuple[str | None, str | None]]]:
    expected = ["agree"] * (same + cross)
    predicted = (
        [Verdict.AGREE] * same_ok
        + [Verdict.CONTRADICT] * (same - same_ok)
        + [Verdict.AGREE] * cross_ok
        + [Verdict.CONTRADICT] * (cross - cross_ok)
    )
    languages: list[tuple[str | None, str | None]] = [
        *[("en", "en")] * same,
        *[("es", "en")] * cross,
    ]
    return expected, predicted, languages


def test_an_empty_run_is_not_a_green_run() -> None:
    """`accuracy` returns 1.0 for zero cases, so a judge that never ran passed at any threshold —
    the provider unreachable, the pairs file empty, a filter that removed everything."""
    assert not score_verdicts([], [], []).passes_gate(THRESHOLD)
    assert not score_verdicts([], [], []).passes_gate(1.0)


def test_a_set_with_no_declared_languages_cannot_pass() -> None:
    """This is the pre-fix gate, silently. The stratification must not be optional in effect."""
    expected, predicted, _ = _shape(18, 18, 14, 12)
    report = score_verdicts(expected, predicted)
    assert report.accuracy >= THRESHOLD, "the aggregate passes, which is the whole problem"
    assert not report.passes_gate(THRESHOLD), (
        "a set that declares no languages collapsed the gate back to the aggregate"
    )


def test_failures_cannot_escape_the_gate_by_losing_their_languages() -> None:
    """The exact scenario: someone adds cross-lingual pairs and forgets `lang_b`. The two that fail
    are dropped from both populations, still counted in the aggregate, and the gate goes green on
    the identical number AUDIT-076 exists to reject."""
    expected = ["agree"] * 32
    predicted = [Verdict.AGREE] * 30 + [Verdict.CONTRADICT] * 2
    languages: list[tuple[str | None, str | None]] = (
        [("en", "en")] * 18 + [("es", "en")] * 12 + [(None, None)] * 2
    )
    report = score_verdicts(expected, predicted, languages)
    assert report.unclassified == 2, "the escaped pairs are not counted anywhere"
    assert not report.passes_gate(THRESHOLD), (
        "two failures escaped classification and the gate passed anyway"
    )


def test_a_misaligned_languages_list_is_refused_rather_than_mis_attributed() -> None:
    """`expected`/`predicted` got `strict=True`; the axis that decides the gate got a silent skip,
    so a caller filtering one list shifted every later pair into the wrong population."""
    expected, predicted, languages = _shape(2, 2, 2, 0)
    with pytest.raises(ValueError, match="languages"):
        score_verdicts(expected, predicted, languages[:-1])
    with pytest.raises(ValueError, match="languages"):
        score_verdicts(expected, predicted, [*languages, ("en", "en")])


def test_an_unmeasured_population_serialises_as_null_not_as_perfect() -> None:
    expected, predicted, languages = _shape(10, 10, 0, 0)
    payload = score_verdicts(expected, predicted, languages).as_dict()
    assert payload["cross_lingual"] == {"correct": 0, "total": 0, "accuracy": None}, payload
    assert payload["same_language"]["accuracy"] == 1.0  # type: ignore[index]


def test_a_fully_measured_and_passing_run_still_passes() -> None:
    """The repair must not make the gate unpassable."""
    expected, predicted, languages = _shape(10, 10, 10, 10)
    assert score_verdicts(expected, predicted, languages).passes_gate(THRESHOLD)


def test_the_real_measurement_still_fails_the_gate() -> None:
    """30/32 aggregate, 18/18 same-language, 12/14 cross-lingual — measured on the host."""
    expected, predicted, languages = _shape(18, 18, 14, 12)
    report = score_verdicts(expected, predicted, languages)
    assert report.accuracy == pytest.approx(30 / 32)
    assert not report.passes_gate(THRESHOLD)


def test_the_dataclass_property_and_the_scorer_agree_on_what_cross_lingual_means() -> None:
    """`PairCase.is_cross_lingual` had no caller and documented the opposite classification from the
    one `score_verdicts` implements. Two semantics for one concept, one unreachable."""
    for lang_a, lang_b, expected_cross in (
        ("es", "en", True),
        ("en", "en", False),
        (None, "en", False),
        (None, None, False),
    ):
        pair = PairCase("x", "a", "b", "agree", lang_a, lang_b)
        assert pair.is_cross_lingual is expected_cross
        report = score_verdicts(["agree"], [Verdict.AGREE], [(lang_a, lang_b)])
        assert (report.cross_lingual[1] == 1) is expected_cross, (
            f"{lang_a}/{lang_b}: the property and the scorer disagree"
        )
