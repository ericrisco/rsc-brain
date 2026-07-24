"""Token budgets + embedding cache at the gateway boundary (SPEC-22, FR-9.5/9.6)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.gateway.usage import BudgetExceededError
from tests.conftest import _fake_capabilities, deterministic_embedding


class FakeCache:
    def __init__(self) -> None:
        self.store: dict[tuple[str, int, str], list[float]] = {}

    async def get_many(
        self, model: str, dimension: int, hashes: list[str]
    ) -> dict[str, list[float]]:
        return {
            h: self.store[(model, dimension, h)]
            for h in hashes
            if (model, dimension, h) in self.store
        }

    async def put_many(self, model: str, dimension: int, items: dict[str, list[float]]) -> None:
        for h, vector in items.items():
            self.store[(model, dimension, h)] = vector


class FakeRecorder:
    def __init__(self, *, over: bool = False) -> None:
        self.records: list[tuple[str, int]] = []
        self._over = over

    async def enforce_budget(self, capability: str) -> None:
        if self._over:
            raise BudgetExceededError(capability)

    async def record(self, capability: str, tokens: int) -> None:
        self.records.append((capability, tokens))


def _counting_embedding_fn() -> tuple[Any, list[str]]:
    seen: list[str] = []

    def fn(**kwargs: Any) -> Any:
        texts = list(kwargs["input"])
        seen.extend(texts)

        async def _call() -> SimpleNamespace:
            return SimpleNamespace(data=[{"embedding": deterministic_embedding(t)} for t in texts])

        return _call()

    return fn, seen


async def test_embedding_cache_avoids_reembedding() -> None:
    fn, seen = _counting_embedding_fn()
    gw = ModelGateway(_fake_capabilities(), embedding_fn=fn, embedding_cache=FakeCache())
    first = await gw.embed(["A", "B"])
    assert seen == ["A", "B"]
    second = await gw.embed(["A"])  # cached → no new provider call
    assert seen == ["A", "B"]
    assert first[0] == second[0]


async def test_embed_dedups_within_a_batch_and_preserves_order() -> None:
    fn, seen = _counting_embedding_fn()
    gw = ModelGateway(_fake_capabilities(), embedding_fn=fn, embedding_cache=FakeCache())
    out = await gw.embed(["A", "B", "A"])
    assert seen == ["A", "B"]  # "A" embedded once
    assert out[0] == out[2] and out[0] != out[1]  # order preserved


async def test_budget_exhausted_blocks_before_the_provider() -> None:
    fn, seen = _counting_embedding_fn()
    gw = ModelGateway(_fake_capabilities(), embedding_fn=fn, usage_recorder=FakeRecorder(over=True))
    with pytest.raises(BudgetExceededError):
        await gw.embed(["A"])
    assert seen == []  # no provider call was made


async def test_embedding_usage_is_recorded() -> None:
    recorder = FakeRecorder()
    fn, _ = _counting_embedding_fn()
    gw = ModelGateway(_fake_capabilities(), embedding_fn=fn, usage_recorder=recorder)
    await gw.embed(["A", "B"])
    assert recorder.records and recorder.records[0][0] == "embedder"
