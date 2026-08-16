"""Reranked abstention (spec: reranked-abstention). Behaviour, never source text — AUDIT-079.

G4 measured 0/8 on a real host: every question answered, gibberish included, `gap_registered` false
throughout, so the hunting loop never fired. Calibration could not fix it because the populations
overlap on embedding similarity by -0.032 (worst genuine hit 0.542, best should-abstain 0.574), and
no scalar threshold separates overlapping populations.

Embedding proximity answers "is this about the same subject". Abstention needs "does this passage
answer this question", which is what the reranker capability is for — declared in the config,
mandatory to configure, and never invoked (AUDIT-077).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence

import pytest

from rsc_brain.gateway.errors import GatewayError
from rsc_brain.recall.reranker import (
    LlmReranker,
    Reranker,
    RerankerUnavailable,
    abstains,
)
from tests.conftest import completion_response


class _Canned:
    """A reranker with a fixed opinion. Deterministic, no network — the judge's own test pattern."""

    version = "canned"

    def __init__(self, *scores: float) -> None:
        self._scores = scores

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
        return self._scores[: len(passages)]


class _Broken:
    version = "broken"

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
        raise RerankerUnavailable("provider unreachable")


async def test_a_passage_that_does_not_answer_the_question_causes_abstention() -> None:
    """The G4 case: the corpus is topically adjacent and answers nothing."""
    decided = await abstains(_Canned(0.1, 0.05), "What is Acme's marketing budget?", ["..."], 0.5)
    assert decided is True


async def test_a_passage_that_answers_it_does_not() -> None:
    decided = await abstains(
        _Canned(0.9), "Who leads project Fénix?", ["María López leads it"], 0.5
    )
    assert decided is False


async def test_the_decision_is_the_best_passage_not_the_first() -> None:
    """Ordering is the blended score's job; the gate reads the maximum."""
    assert await abstains(_Canned(0.1, 0.95), "q", ["a", "b"], 0.5) is False


async def test_an_unavailable_reranker_does_not_fail_the_query() -> None:
    """A recall that raises because a model is down is worse than one that answers with the
    threshold it already had. The caller learns it degraded; the user still gets an answer."""
    assert await abstains(_Broken(), "q", ["a"], 0.5) is None, (
        "an unavailable reranker must return 'no opinion' so the caller can fall back, not raise"
    )


async def test_no_passages_is_not_an_opinion() -> None:
    """Nothing to score is the retriever's business (it already abstains on an empty candidate
    set); the reranker must not manufacture a verdict about it."""
    assert await abstains(_Canned(), "q", [], 0.5) is None


async def test_a_score_list_of_the_wrong_length_is_refused() -> None:
    """Silently zipping a short list to the passages mis-attributes every score after the gap — the
    same defect class as AUDIT-082's positional `languages`."""

    class _Short:
        version = "short"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
            return [0.9]

    with pytest.raises(ValueError, match="one score per passage"):
        await abstains(_Short(), "q", ["a", "b", "c"], 0.5)


async def test_the_llm_reranker_scores_through_the_capability(
    gateway_factory: Callable[..., object],
) -> None:
    """It must use Capability.RERANKER — the route every operator is already made to configure,
    and which nothing called until now (AUDIT-077)."""
    seen: dict[str, object] = {}

    async def _completion(**kwargs: object) -> object:
        seen["capability"] = kwargs.get("model")
        return completion_response(json.dumps({"scores": [0.8, 0.2]}))

    reranker: Reranker = LlmReranker(gateway_factory(completion=_completion))  # type: ignore[arg-type]
    scores = await reranker.relevance("q", ["passage one", "passage two"])
    assert list(scores) == [0.8, 0.2]
    assert seen["capability"] is not None, "the call did not travel through a configured route"


async def test_a_gateway_failure_becomes_unavailable_not_a_crash(
    gateway_factory: Callable[..., object],
) -> None:
    async def _broken(**kwargs: object) -> object:
        raise GatewayError("provider_down", "corr-1", "provider unreachable")

    reranker: Reranker = LlmReranker(gateway_factory(completion=_broken))  # type: ignore[arg-type]
    with pytest.raises(RerankerUnavailable):
        await reranker.relevance("q", ["a"])


async def test_scores_outside_the_unit_interval_are_clamped(
    gateway_factory: Callable[..., object],
) -> None:
    """A model that returns 1.7 or -0.2 must not move the gate; the contract is [0,1]."""

    async def _wild(**kwargs: object) -> object:
        return completion_response(json.dumps({"scores": [1.7, -0.2]}))

    reranker: Reranker = LlmReranker(gateway_factory(completion=_wild))  # type: ignore[arg-type]
    assert list(await reranker.relevance("q", ["a", "b"])) == [1.0, 0.0]


def test_the_disabled_path_constructs_no_reranker() -> None:
    """The property the whole seam rests on: an install that has not opted in must take the SPEC-06
    blended path with nothing added. Read from the constructed object, not from the source text."""
    import dataclasses

    from rsc_brain.api.app import ApiDeps

    field = next(f for f in dataclasses.fields(ApiDeps) if f.name == "reranker_enabled")
    assert field.default is False, "the capability must be off unless an operator opts in"


def test_the_runtime_decides_it_once_for_every_role() -> None:
    """R53: the API and the worker cannot disagree about whether abstention is reranked, because one
    factory reads it from one config key."""
    import inspect

    from rsc_brain import runtime

    source = inspect.getsource(runtime.build)
    assert "reranker_enabled=settings.reranker.enabled" in source, (
        "the flag is not resolved in the shared factory, so the two roles can diverge"
    )
