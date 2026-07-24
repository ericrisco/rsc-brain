"""Contradiction eval runner (SPEC-08 G3): run the SPEC-02 ES/EN pairs through a Judge and score
resolution accuracy against the expected verdicts. The ≥90% CI gate requires a real NLI/LLM judge
(blocked-by-resource); the runner + metric are real and exercised in CI with a controlled set.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from rsc_brain.knowledge.judge import Judge, Verdict


@dataclass(frozen=True, slots=True)
class PairCase:
    id: str
    a: str
    b: str
    expected: str  # agree | contradict | unrelated


@dataclass(frozen=True, slots=True)
class ContradictionReport:
    total: int
    correct: int

    @property
    def accuracy(self) -> float:
        return self.correct / self.total if self.total else 1.0

    def as_dict(self) -> dict[str, object]:
        return {"total": self.total, "correct": self.correct, "accuracy": round(self.accuracy, 4)}


def score_verdicts(expected: Sequence[str], predicted: Sequence[Verdict]) -> ContradictionReport:
    """Pure accuracy of predicted verdicts vs expected labels."""
    correct = sum(1 for e, p in zip(expected, predicted, strict=True) if e == p.value)
    return ContradictionReport(total=len(expected), correct=correct)


async def run_contradiction_eval(judge: Judge, pairs: Sequence[PairCase]) -> ContradictionReport:
    """Judge every pair and score against the expected verdicts."""
    predicted: list[Verdict] = []
    expected: list[str] = []
    for pair in pairs:
        result = await judge.judge(pair.a, pair.b)
        predicted.append(result.verdict)
        expected.append(pair.expected)
    return score_verdicts(expected, predicted)
