"""PgUsageRecorder + PgEmbeddingCache against the real container (SPEC-22, FR-9.5/9.6).

Verifies migration ``f1a2b3c4d5e6`` applied, per-capability/day counters + budget enforcement, the
text→vector cache round-trip, and that the gateway with the Pg cache embeds a repeated text once.
"""

from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest

from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.gateway.usage import (
    BudgetExceededError,
    PgEmbeddingCache,
    PgUsageRecorder,
    text_hash,
)
from tests.conftest import _fake_capabilities, deterministic_embedding

from .conftest import Harness

pytestmark = pytest.mark.integration


def _caps(*, embedder_budget: int | None = None) -> CapabilitiesConfig:
    cap = CapabilityConfig(provider="none", model="none")
    embedder = CapabilityConfig(provider="none", model="none", daily_token_budget=embedder_budget)
    return CapabilitiesConfig(
        extractor=cap, judge=cap, topicalizer=cap, embedder=embedder, reranker=cap
    )


async def test_counters_sum_and_report(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    recorder = PgUsageRecorder(harness.sm, _caps())
    await recorder.record("extractor", 5)
    await recorder.record("extractor", 7)
    rows = await recorder.usage(days=1)
    extractor = next(r for r in rows if r["capability"] == "extractor")
    assert extractor["tokens"] == 12 and extractor["calls"] == 2


async def test_budget_enforced(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    recorder = PgUsageRecorder(harness.sm, _caps(embedder_budget=3))
    await recorder.enforce_budget("embedder")  # under budget → fine
    await recorder.record("embedder", 5)  # now over
    with pytest.raises(BudgetExceededError):
        await recorder.enforce_budget("embedder")


async def test_embedding_cache_round_trip(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    cache = PgEmbeddingCache(harness.sm)
    vector = [0.1, 0.2, 0.3]
    await cache.put_many("m", 3, {"h1": vector})
    got = await cache.get_many("m", 3, ["h1", "missing"])
    assert got == {"h1": vector}


async def test_gateway_caches_embeddings_in_postgres(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    seen: list[str] = []

    def fn(**kwargs: Any) -> Any:
        texts = list(kwargs["input"])
        seen.extend(texts)

        async def _call() -> SimpleNamespace:
            return SimpleNamespace(data=[{"embedding": deterministic_embedding(t)} for t in texts])

        return _call()

    gw = ModelGateway(
        _fake_capabilities(), embedding_fn=fn, embedding_cache=PgEmbeddingCache(harness.sm)
    )
    unique = f"cache-me-{text_hash('seed')[:8]}"
    await gw.embed([unique])
    await gw.embed([unique])  # second time served from Postgres
    assert seen == [unique]  # the provider was hit exactly once
