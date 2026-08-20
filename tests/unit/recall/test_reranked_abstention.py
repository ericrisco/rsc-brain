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
from typing import cast

import pytest

from rsc_brain.gateway.errors import GatewayError
from rsc_brain.recall.reranker import (
    LlmReranker,
    Reranker,
    RerankerUnavailable,
    abstains,
    decide,
)
from tests.conftest import completion_response


class _Canned:
    """A reranker with a fixed opinion, CONSISTENT per passage.

    AUDIT-104 made answering require the top passage to score the same alone, so a double that keys
    its answers to position rather than to the passage would report a different score for the same
    text and fail for the wrong reason. Keying on the passage is also what a judge is supposed to do:
    a score is a property of the (question, passage) pair. The real 12B model is not consistent this
    way, which is precisely the defect AUDIT-104 exists to absorb.
    """

    version = "canned"

    def __init__(self, *scores: float) -> None:
        self._scores = scores
        self._by_passage: dict[str, float] = {}

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        for passage, score in zip(passages, self._scores, strict=False):
            self._by_passage.setdefault(passage, score)
        return [self._by_passage.get(p, 0.0) for p in passages]


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
    """Silently zipping a short list to the passages mis-attributes every entry after the gap — the
    same defect class as AUDIT-082's positional `languages`.

    AUDIT-100 changed WHERE a missing score is absorbed, not whether mis-attribution is allowed. A
    `Reranker` still owes one entry per passage in order; what is new is that an entry may be `None`,
    so the model omitting a passage no longer shortens the list."""

    class _Short:
        version = "short"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            return [0.9]

    with pytest.raises(ValueError, match="one entry per passage"):
        await abstains(_Short(), "q", ["a", "b", "c"], 0.5)


async def test_an_unscored_passage_is_not_a_zero() -> None:
    """AUDIT-100: `None` means "not judged", which must not drag the maximum down.

    Treating it as 0.0 would manufacture a refusal out of a model's miscounting — moving the defect
    instead of removing it."""

    class _Partial:
        """Scores only "b", whatever list it arrives in — consistent per passage (see `_Canned`)."""

        version = "partial"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            return [0.9 if p == "b" else None for p in passages]

    decision = await decide(_Partial(), "q", ["a", "b", "c"], 0.5)
    assert decision.abstains is False, "a 0.9 among unscored passages must still answer"
    assert decision.degradation is not None, "the operator must learn 2 of 3 were unjudged"
    assert "1 of 3" in decision.degradation


async def test_scoring_nothing_is_still_a_fallback() -> None:
    """All-unscored is indistinguishable from an unavailable reranker: no opinion, and say so."""

    class _Silent:
        version = "silent"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            return [None, None]

    decision = await decide(_Silent(), "q", ["a", "b"], 0.5)
    assert decision.abstains is None
    assert decision.degradation and "none of the 2" in decision.degradation


async def test_the_llm_reranker_scores_through_the_capability(
    gateway_factory: Callable[..., object],
) -> None:
    """It must use Capability.RERANKER — the route every operator is already made to configure,
    and which nothing called until now (AUDIT-077)."""
    seen: dict[str, object] = {}

    async def _completion(**kwargs: object) -> object:
        seen["capability"] = kwargs.get("model")
        return completion_response(
            json.dumps({"scores": [{"index": 1, "score": 0.8}, {"index": 2, "score": 0.2}]})
        )

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
        return completion_response(
            json.dumps({"scores": [{"index": 1, "score": 1.7}, {"index": 2, "score": -0.2}]})
        )

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


async def test_passages_are_labelled_from_one(
    gateway_factory: Callable[..., object],
) -> None:
    """AUDIT-103: zero-based labels invited a one-based answer.

    Measured over 26 golden cases, a 12B model returned `index 10` for a page of 10 twice — answering
    one-based while being asked zero-based. The out-of-range guard refused both judgements, correctly,
    because an index nobody sent is indistinguishable from a hallucination. Removing the `0` removes
    the ambiguity at the source instead of guessing at it on arrival.
    """
    seen: dict[str, str] = {}

    async def _completion(**kwargs: object) -> object:
        messages = cast("list[dict[str, str]]", kwargs.get("messages") or [])
        seen["user"] = " ".join(m.get("content", "") for m in messages if m.get("role") == "user")
        return completion_response(json.dumps({"scores": [{"index": 1, "score": 0.9}]}))

    reranker: Reranker = LlmReranker(gateway_factory(completion=_completion))  # type: ignore[arg-type]
    scores = await reranker.relevance("q", ["only passage"])
    assert "[1]" in seen["user"], f"passages are not labelled from 1: {seen['user'][:120]!r}"
    assert "[0]" not in seen["user"], "a passage 0 is still offered, which is what invited index 10"
    # And the one-based label maps back to position 0.
    assert list(scores) == [0.9]


async def test_a_zero_index_is_refused(
    gateway_factory: Callable[..., object],
) -> None:
    """Nothing is labelled 0 any more, so a 0 is an index nobody sent — the same mis-attribution the
    out-of-range guard exists to refuse."""

    async def _zero(**kwargs: object) -> object:
        return completion_response(json.dumps({"scores": [{"index": 0, "score": 0.9}]}))

    reranker: Reranker = LlmReranker(gateway_factory(completion=_zero))  # type: ignore[arg-type]
    with pytest.raises(RerankerUnavailable, match="outside"):
        await reranker.relevance("q", ["only passage"])


class _ContextDependent:
    """A judge whose batch score is not a property of the passage — measured behaviour, not fiction.

    For "What is Acme's marketing budget?" the real 12B judge scored a deployment-pipeline passage
    1.0 inside a page of 10, reproducibly at temperature 0, and 0.0 when handed the same text alone.
    """

    version = "context-dependent"

    def __init__(self) -> None:
        self.calls: list[int] = []

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        self.calls.append(len(passages))
        if len(passages) == 1:
            return [0.0]
        return [0.0, 0.0, 0.9, 0.0]


async def test_answering_requires_the_winner_to_survive_alone() -> None:
    """AUDIT-104: the gate rests on one passage, so that passage is confirmed by itself.

    Without this, a score the model attached to the wrong index carries an answer — and the indexed
    contract cannot catch that, because the attribution looks perfectly well-formed.
    """
    judge = _ContextDependent()
    decision = await decide(judge, "q", ["a", "b", "c", "d"], 0.5)
    assert decision.abstains is True, "a batch score that does not survive alone must not answer"
    assert decision.degradation and "alone" in decision.degradation
    assert judge.calls == [4, 1], f"expected one batch call then one solo call, got {judge.calls}"


async def test_abstaining_costs_no_second_call() -> None:
    """The conservative direction needs no convincing. A product whose promise is "ask a human
    rather than guess" must not spend a call to talk itself out of refusing."""

    class _AllLow:
        version = "low"

        def __init__(self) -> None:
            self.calls = 0

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            self.calls += 1
            return [0.1] * len(passages)

    judge = _AllLow()
    decision = await decide(judge, "q", ["a", "b"], 0.5)
    assert decision.abstains is True
    assert judge.calls == 1, "abstention triggered a confirmation call it does not need"


async def test_a_confirmed_winner_still_answers() -> None:
    """The fix must not become a blanket refusal: agreement between batch and solo answers."""

    class _Consistent:
        version = "consistent"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            return [0.9] * len(passages)

    decision = await decide(_Consistent(), "q", ["a", "b"], 0.5)
    assert decision.abstains is False
    assert decision.degradation is None


async def test_an_unconfirmable_winner_answers_and_says_so() -> None:
    """If the confirmation call itself fails, the batch verdict stands — refusing on a provider
    outage would turn a degraded model into a product that answers nothing."""

    class _FailsAlone:
        version = "fails-alone"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            if len(passages) == 1:
                raise RerankerUnavailable("provider down")
            return [0.9, 0.1]

    decision = await decide(_FailsAlone(), "q", ["a", "b"], 0.5)
    assert decision.abstains is False
    assert decision.degradation and "could not be confirmed" in decision.degradation
