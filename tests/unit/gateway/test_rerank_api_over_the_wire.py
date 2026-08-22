"""The `rerank_api` route reaches a real HTTP rerank endpoint (AUDIT-128/130).

AUDIT-130 added the adapter, and its unit tests inject the rerank function directly
(`tests/unit/gateway/test_rerank_api.py`). Everything from litellm's provider routing outward was
therefore never exercised: the URL it builds from `api_base`, the payload it posts, the response
fields it reads back, and our by-index mapping *over the wire*. AUDIT-129 is the reminder of what
that gap costs — `config.example.yaml` named a reranker that nothing could serve, and it looked
perfectly fine right up until someone tried it.

So this drives `ModelGateway.rerank()` through litellm at a real HTTP server on a real socket,
speaking the Cohere-shaped response an Infinity deployment returns. The server deliberately answers
**out of order**, which is the point: a rerank API sorts by score and may truncate to `top_n`, so a
positional read would attribute the wrong score to every document. That is AUDIT-100's finding, and
until now nothing proved our end of it across a network boundary.

What this proves is the wire contract and our mapping. It does **not** prove any vendor's ranking
quality, which is not ours to test, and it is not a substitute for pointing the product at a real
cross-encoder once — the open point AUDIT-128 keeps.

It lives in the default gate rather than behind a marker on purpose. This repository's markers name
an *infrastructure* dependency — `integration` means a real Postgres container, `e2e` means Docker for
the edge proxy — and this test needs neither: it binds a loopback port and serves three requests in
well under a second. Marking it would claim a dependency it does not have and hide it from the fast
gate, which is where a litellm upgrade silently changing this wire contract should be caught.
"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import AsyncIterator
from typing import Any

import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig, ModelEgressConfig
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway

DOCUMENTS = [
    "the rate is 120 EUR per hour",
    "Globex is in Andorra",
    "contracts need 30 days notice",
]
QUERY = "what is the hourly rate"


class _Endpoint:
    """A rerank server that records what it was asked and answers in score order, not input order."""

    def __init__(self, results: list[dict[str, Any]]) -> None:
        self.results = results
        self.paths: list[str] = []
        self.payloads: list[dict[str, Any]] = []

    async def rerank(self, request: Request) -> JSONResponse:
        self.paths.append(request.url.path)
        self.payloads.append(await request.json())
        return JSONResponse(
            {
                "id": "rr-1",
                "results": self.results,
                "usage": {"prompt_tokens": 11, "total_tokens": 13},
            }
        )

    def app(self) -> Starlette:
        return Starlette(routes=[Route("/rerank", self.rerank, methods=["POST"])])


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def _serve(endpoint: _Endpoint, port: int) -> AsyncIterator[None]:
    server = uvicorn.Server(
        uvicorn.Config(endpoint.app(), host="127.0.0.1", port=port, log_level="error")
    )
    task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            if task.done():  # pragma: no cover - the server failed to bind
                await task
            await asyncio.sleep(0.02)
        yield
    finally:
        server.should_exit = True
        await task


def _gateway(port: int) -> ModelGateway:
    """The product's own configuration path: `provider/model` routing plus a self-hosted base URL."""
    reranker = CapabilityConfig(
        provider="infinity",
        model="BAAI/bge-reranker-base",
        api_base=f"http://127.0.0.1:{port}",
        # A self-hosted reranker on loopback is exactly the deployment this route exists for, and the
        # egress boundary makes that an explicit configuration decision rather than a default.
        egress=ModelEgressConfig(allow_http=True, allow_private_network=True),
    )
    chat = CapabilityConfig(
        provider="ollama",
        model="chat-model",
        api_base=f"http://127.0.0.1:{port}",
        egress=ModelEgressConfig(allow_http=True, allow_private_network=True),
    )
    return ModelGateway(
        CapabilitiesConfig(
            extractor=chat, judge=chat, topicalizer=chat, embedder=chat, reranker=reranker
        )
    )


async def test_scores_survive_the_wire_against_their_own_index() -> None:
    """The answer is document 0; the server returns it first because it sorts by score."""
    endpoint = _Endpoint(
        [
            {"index": 0, "relevance_score": 0.91, "document": DOCUMENTS[0]},
            {"index": 2, "relevance_score": 0.12, "document": DOCUMENTS[2]},
            {"index": 1, "relevance_score": 0.04, "document": DOCUMENTS[1]},
        ]
    )
    port = _free_port()
    async for _ in _serve(endpoint, port):
        scores = await _gateway(port).rerank(QUERY, DOCUMENTS)

    # Input order, not response order: 0.12 belongs to document 2 even though it came back second.
    assert scores == [0.91, 0.04, 0.12]
    assert endpoint.paths == ["/rerank"], "litellm builds the endpoint from api_base"
    payload = endpoint.payloads[0]
    assert payload["query"] == QUERY
    assert payload["documents"] == DOCUMENTS
    assert payload["model"] == "BAAI/bge-reranker-base", (
        "the provider prefix is routing, not a model"
    )


async def test_a_truncated_response_leaves_the_rest_unscored() -> None:
    """A provider that honours `top_n` returns fewer results; the others are unjudged, not zero."""
    endpoint = _Endpoint([{"index": 1, "relevance_score": 0.77, "document": DOCUMENTS[1]}])
    port = _free_port()
    async for _ in _serve(endpoint, port):
        scores = await _gateway(port).rerank(QUERY, DOCUMENTS)

    assert scores == [None, 0.77, None], "'not judged' and 'irrelevant' are different facts"


async def test_a_server_error_crosses_as_a_typed_failure() -> None:
    """A 500 from the reranker is the product's typed error, not an httpx exception escaping."""

    async def _fail(request: Request) -> JSONResponse:
        return JSONResponse({"detail": "model not loaded"}, status_code=500)

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(
            Starlette(routes=[Route("/rerank", _fail, methods=["POST"])]),
            host="127.0.0.1",
            port=port,
            log_level="error",
        )
    )
    task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            await asyncio.sleep(0.02)
        with pytest.raises(GatewayError):
            await _gateway(port).rerank(QUERY, DOCUMENTS)
    finally:
        server.should_exit = True
        await task
