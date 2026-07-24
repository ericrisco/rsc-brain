"""Contradiction eval runner + accuracy metric (SPEC-08 G3)."""

from __future__ import annotations

import pytest
from evals.contradiction_eval import PairCase, run_contradiction_eval, score_verdicts

from rsc_brain.knowledge.judge import HeuristicJudge, Verdict


def test_score_verdicts_accuracy() -> None:
    expected = ["contradict", "agree", "unrelated"]
    predicted = [Verdict.CONTRADICT, Verdict.AGREE, Verdict.CONTRADICT]
    report = score_verdicts(expected, predicted)
    assert report.total == 3
    assert report.correct == 2
    assert report.accuracy == pytest.approx(2 / 3)


async def test_runner_scores_controlled_pairs() -> None:
    # A controlled set the deterministic judge resolves correctly (the ≥90% gate over the real
    # ES/EN corpus needs a live NLI/LLM judge — blocked-by-resource).
    pairs = [
        PairCase("neg", "The SLA is 24 hours", "The SLA is not 24 hours", "contradict"),
        PairCase("agree", "The SLA is 24 hours", "Support SLA: 24 hours", "agree"),
        PairCase("unrel", "Vacation policy is 25 days", "PostgreSQL powers the graph", "unrelated"),
    ]
    report = await run_contradiction_eval(HeuristicJudge(), pairs)
    assert report.accuracy == 1.0
