"""Contradiction eval runner (SPEC-08 G3): run the SPEC-02 ES/EN pairs through a Judge and score
resolution accuracy against the expected verdicts.

AUDIT-076: the gate used to be a single accuracy number over a mixed-language set, and the first
real run showed why that is not enough. Measured on a rented host with a live judge:

    aggregate        30/32   93.8%   passes the >=90% gate
    same language    18/18  100.0%
    cross-lingual    12/14   85.7%   does not

The aggregate passed because a perfect same-language score masked the cross-lingual one — and for a
product whose PRD scopes `spa+eng`, cross-lingual is not an edge case. Both failures were es/en, and
one of them was the silent direction: a missed contradiction publishes both claims and flags nothing.

So the report now carries the two populations and the gate reads both.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from rsc_brain.knowledge.judge import Judge, Verdict


@dataclass(frozen=True, slots=True)
class PairCase:
    id: str
    a: str
    b: str
    expected: str  # agree | contradict | unrelated
    lang_a: str | None = None
    lang_b: str | None = None

    @property
    def is_cross_lingual(self) -> bool:
        """Unknown languages are not cross-lingual: a set that does not declare them is scored as
        one population rather than silently counted into the stricter one."""
        return bool(self.lang_a and self.lang_b and self.lang_a != self.lang_b)


@dataclass(frozen=True, slots=True)
class ContradictionReport:
    total: int
    correct: int
    #: (correct, total) per language population — AUDIT-076.
    same_language: tuple[int, int] = field(default=(0, 0))
    cross_lingual: tuple[int, int] = field(default=(0, 0))

    @property
    def accuracy(self) -> float:
        return self.correct / self.total if self.total else 1.0

    @property
    def cross_lingual_accuracy(self) -> float | None:
        """``None`` when the population was never measured — AUDIT-082.

        This used to return 1.0 for an empty population, so a set whose language metadata was
        missing reported "cross-lingual: 100%" for something nobody had checked, and the gate
        silently collapsed back to the aggregate. Not-measured and measured-perfect are different
        facts and must not share an encoding.
        """
        correct, total = self.cross_lingual
        return correct / total if total else None

    @property
    def same_language_accuracy(self) -> float | None:
        correct, total = self.same_language
        return correct / total if total else None

    @property
    def unclassified(self) -> int:
        """Pairs counted in the aggregate but in neither population (AUDIT-082)."""
        return self.total - self.same_language[1] - self.cross_lingual[1]

    def passes_gate(self, threshold: float) -> bool:
        """Both populations must clear the threshold, and both must have been measured.

        AUDIT-082: the previous version failed OPEN in four ways an adversarial review enumerated —
        an empty run scored 1.0 and passed at any threshold; a set with no declared languages
        collapsed the gate to the aggregate, i.e. exactly the pre-fix behaviour; and pairs whose
        languages went missing were dropped from both populations while still counting toward the
        aggregate, so the very failures the gate exists to catch could vanish from it. Every one of
        those is the most likely way for the metadata to be wrong, which is the worst possible thing
        to fail open on.

        A gate that cannot say it measured something must not say it passed.
        """
        if not self.total:
            return False  # nothing was judged; an empty run is not a green one
        if self.unclassified:
            return False  # some pair escaped classification: the gate cannot speak for it
        for measured in (self.same_language_accuracy, self.cross_lingual_accuracy):
            if measured is None or measured < threshold:
                return False
        return self.accuracy >= threshold

    def as_dict(self) -> dict[str, object]:
        return {
            "total": self.total,
            "correct": self.correct,
            "accuracy": round(self.accuracy, 4),
            # AUDIT-082: `null`, never 1.0, for a population that was never measured — any consumer
            # reading "accuracy: 1.0" for zero cases is being handed manufactured confidence.
            "same_language": _population(self.same_language, self.same_language_accuracy),
            "cross_lingual": _population(self.cross_lingual, self.cross_lingual_accuracy),
            "unclassified": self.unclassified,
        }


def _population(counts: tuple[int, int], accuracy: float | None) -> dict[str, object]:
    return {
        "correct": counts[0],
        "total": counts[1],
        "accuracy": None if accuracy is None else round(accuracy, 4),
    }


def score_verdicts(
    expected: Sequence[str],
    predicted: Sequence[Verdict],
    languages: Sequence[tuple[str | None, str | None]] | None = None,
) -> ContradictionReport:
    """Accuracy of predicted verdicts vs expected labels, split by language population.

    ``languages`` is optional so a set that does not declare them still scores; those pairs land in
    neither population rather than being counted as same-language, which would flatter the gate.
    """
    # AUDIT-082: `languages` got no length check while `expected`/`predicted` got `strict=True`, so
    # a caller building it from a filtered source shifted every later pair into the WRONG population
    # and the report looked entirely normal. Inconsistent strictness on the axis that decides the
    # gate is worse than no stratification at all.
    if languages is not None and len(languages) != len(expected):
        raise ValueError(
            f"languages has {len(languages)} entries for {len(expected)} pairs; a positional "
            "mismatch silently attributes results to the wrong language population"
        )
    pairs = list(zip(expected, predicted, strict=True))
    correct = sum(1 for e, p in pairs if e == p.value)
    same_correct = same_total = cross_correct = cross_total = 0
    for index, (e, p) in enumerate(pairs):
        if languages is None or index >= len(languages):
            continue
        lang_a, lang_b = languages[index]
        if not (lang_a and lang_b):
            continue
        hit = int(e == p.value)
        if lang_a != lang_b:
            cross_total += 1
            cross_correct += hit
        else:
            same_total += 1
            same_correct += hit
    return ContradictionReport(
        total=len(pairs),
        correct=correct,
        same_language=(same_correct, same_total),
        cross_lingual=(cross_correct, cross_total),
    )


async def run_contradiction_eval(judge: Judge, pairs: Sequence[PairCase]) -> ContradictionReport:
    """Judge every pair and score against the expected verdicts, keeping each pair's languages."""
    predicted: list[Verdict] = []
    expected: list[str] = []
    languages: list[tuple[str | None, str | None]] = []
    for pair in pairs:
        result = await judge.judge(pair.a, pair.b)
        predicted.append(result.verdict)
        expected.append(pair.expected)
        languages.append((pair.lang_a, pair.lang_b))
    return score_verdicts(expected, predicted, languages)
