"""The deterministic HeuristicJudge (drives the contradiction pipeline in tests) + LlmJudge."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.knowledge.judge import HeuristicJudge, LlmJudge, Verdict


async def test_heuristic_detects_negation_contradiction() -> None:
    judge = HeuristicJudge()
    result = await judge.judge("The support SLA is 24 hours", "The support SLA is not 24 hours")
    assert result.verdict is Verdict.CONTRADICT


async def test_heuristic_detects_number_contradiction() -> None:
    judge = HeuristicJudge()
    result = await judge.judge("The price is 100 euros", "The price is 200 euros")
    assert result.verdict is Verdict.CONTRADICT


async def test_heuristic_agrees_on_strong_overlap_same_polarity() -> None:
    judge = HeuristicJudge()
    result = await judge.judge(
        "The support SLA is 24 hours", "Support SLA: 24 hours for all customers"
    )
    assert result.verdict is Verdict.AGREE


async def test_heuristic_unrelated_on_low_overlap() -> None:
    judge = HeuristicJudge()
    result = await judge.judge("The vacation policy is 25 days", "PostgreSQL powers the graph")
    assert result.verdict is Verdict.UNRELATED


async def test_llm_judge_uses_gateway(
    gateway_factory: Callable[..., ModelGateway], make_completion: Callable[..., Any]
) -> None:
    # The judge capability returns a structured contradiction verdict.
    completion = make_completion()

    async def _verdict(**kwargs: Any) -> Any:
        from types import SimpleNamespace

        schema = kwargs.get("response_format")
        if getattr(schema, "__name__", "") == "_VerdictOut":
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content='{"verdict": "contradict", "confidence": 0.9}'
                        )
                    )
                ]
            )
        return await completion(**kwargs)

    gateway = gateway_factory(completion=_verdict)
    result = await LlmJudge(gateway).judge("A is 24h", "A is 48h")
    assert result.verdict is Verdict.CONTRADICT
    assert result.confidence == pytest.approx(0.9)
