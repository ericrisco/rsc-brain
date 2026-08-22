"""The gateway can call a real rerank API, not only a chat model (AUDIT-130).

`LlmReranker` asks a chat model to return JSON scores. That works and it is expensive: a 12B model per
query, ~10-35 s, and it cannot run at all on `cpu_only` (AUDIT-100/128) — which is why a cpu_only
install cannot refuse anything.

A cross-encoder is the right tool and could not be reached: `config.example.yaml` named one and the
seam could not call it (AUDIT-129). litellm exposes `arerank` with exactly the needed shape, and its
results are already **indexed** — `{index, relevance_score}` — which is the contract AUDIT-100 had to
impose on the chat path by hand.
"""

from __future__ import annotations

from typing import Any

import pytest

from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig, ModelEgressConfig
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway

DOCUMENTS = [
    "the rate is 120 EUR per hour",
    "Globex is in Andorra",
    "contracts need 30 days notice",
]


class _Resolver:
    """A public address for the test host: the egress boundary resolves DNS, and it should — this
    injects the answer rather than weakening the check (AUDIT-005)."""

    async def __call__(self, host: str, port: int) -> list[str]:
        return ["8.8.8.8"]  # a genuinely globally-routable answer; no connection is made


def _gateway(rerank: Any) -> ModelGateway:
    route = CapabilityConfig(
        provider="cohere",
        model="rerank-v3.5",
        api_base="https://api.cohere.example",
        egress=ModelEgressConfig(),
    )
    chat = CapabilityConfig(
        provider="ollama",
        model="chat-model",
        api_base="http://127.0.0.1:11434",
        egress=ModelEgressConfig(allow_http=True, allow_private_network=True),
    )
    return ModelGateway(
        CapabilitiesConfig(
            extractor=chat, judge=chat, topicalizer=chat, embedder=chat, reranker=route
        ),
        rerank=rerank,
        endpoint_resolver=_Resolver(),
    )


def _response(results: list[dict[str, Any]]) -> Any:
    return {"id": "r1", "results": results, "meta": {}}


async def test_scores_come_back_against_their_own_index() -> None:
    """The API may reorder; a positional read would attribute the wrong score to every document."""

    async def rerank(**kwargs: Any) -> Any:
        assert kwargs["query"] == "what is the rate?"
        assert kwargs["documents"] == DOCUMENTS
        return _response(
            [
                {"index": 2, "relevance_score": 0.10},
                {"index": 0, "relevance_score": 0.94},
                {"index": 1, "relevance_score": 0.20},
            ]
        )

    scores = await _gateway(rerank).rerank("what is the rate?", DOCUMENTS)

    assert scores == [0.94, 0.20, 0.10]


async def test_an_omitted_document_is_unscored_not_zero() -> None:
    """A rerank API truncates to `top_n`. An absent score is "not judged", which AUDIT-100 established
    is a different fact from "irrelevant" — inventing a zero manufactures a refusal."""

    async def rerank(**kwargs: Any) -> Any:
        return _response([{"index": 0, "relevance_score": 0.9}])

    scores = await _gateway(rerank).rerank("q", DOCUMENTS)

    assert scores == [0.9, None, None]


async def test_an_index_outside_the_request_is_refused() -> None:
    async def rerank(**kwargs: Any) -> Any:
        return _response([{"index": 7, "relevance_score": 0.9}])

    with pytest.raises(GatewayError):
        await _gateway(rerank).rerank("q", DOCUMENTS)


async def test_a_repeated_index_is_refused() -> None:
    """Two scores for one document means the mapping is not a mapping."""

    async def rerank(**kwargs: Any) -> Any:
        return _response(
            [{"index": 1, "relevance_score": 0.9}, {"index": 1, "relevance_score": 0.1}]
        )

    with pytest.raises(GatewayError):
        await _gateway(rerank).rerank("q", DOCUMENTS)


async def test_a_provider_failure_is_a_typed_error() -> None:
    async def rerank(**kwargs: Any) -> Any:
        raise RuntimeError("connection reset")

    with pytest.raises(GatewayError):
        await _gateway(rerank).rerank("q", DOCUMENTS)


async def test_no_documents_costs_no_call() -> None:
    called = False

    async def rerank(**kwargs: Any) -> Any:
        nonlocal called
        called = True
        return _response([])

    assert await _gateway(rerank).rerank("q", []) == []
    assert not called
