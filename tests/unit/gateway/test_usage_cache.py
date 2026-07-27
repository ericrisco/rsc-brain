"""Token budgets + embedding cache at the gateway boundary (SPEC-22, FR-9.5/9.6)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.gateway.usage import Attempt, BudgetExceededError
from tests.conftest import _fake_capabilities, deterministic_embedding

PROJECT = "11111111-1111-1111-1111-111111111111"


class FakeCache:
    """A cache that honours the project dimension (AUDIT-022).

    Keyed with the project like the real one: a fake that ignored it would let these checks pass while the
    product's isolation was broken, which is the only thing this dimension exists for.
    """

    def __init__(self) -> None:
        self.store: dict[tuple[str, int, str, str | None], list[float]] = {}

    async def get_many(
        self, model: str, dimension: int, hashes: list[str], *, project_id: str | None = None
    ) -> dict[str, list[float]]:
        if project_id is None:
            return {}
        return {
            h: self.store[(model, dimension, h, project_id)]
            for h in hashes
            if (model, dimension, h, project_id) in self.store
        }

    async def put_many(
        self,
        model: str,
        dimension: int,
        items: dict[str, list[float]],
        *,
        project_id: str | None = None,
    ) -> None:
        if project_id is None:
            return
        for h, vector in items.items():
            self.store[(model, dimension, h, project_id)] = vector


class FakeRecorder:
    """A recorder that implements the reserve/settle pair the gateway uses (R29).

    ``reserve`` is how an attempt holds budget across the provider call and settles on the way out; the
    gateway no longer checks and records separately, because the gap between those two was the finding.
    """

    def __init__(self, *, over: bool = False, project_id: str | None = None) -> None:
        self.records: list[tuple[str, int]] = []
        self._over = over
        self.project_id = project_id

    def for_project(self, project_id: str) -> FakeRecorder:
        """Bind the project, as the real recorder does (R12).

        The gateway reads the project from HERE for the cache too (AUDIT-022) — one binding, not two — so a
        fake without it would leave the gateway unbound and quietly cacheless, and the reuse checks below
        would fail for a reason that has nothing to do with reuse.
        """
        bound = FakeRecorder(over=self._over, project_id=project_id)
        bound.records = self.records
        return bound

    async def enforce_budget(self, capability: str) -> None:
        if self._over:
            raise BudgetExceededError(capability)

    async def record(self, capability: str, tokens: int) -> None:
        self.records.append((capability, tokens))

    @asynccontextmanager
    async def reserve(self, capability: str) -> AsyncIterator[Attempt]:
        if self._over:
            raise BudgetExceededError(capability)
        attempt = Attempt()
        try:
            yield attempt
        finally:
            self.records.append((capability, attempt.spent))


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
    gw = ModelGateway(
        _fake_capabilities(),
        embedding_fn=fn,
        embedding_cache=FakeCache(),
        usage_recorder=FakeRecorder(),
    ).for_project(PROJECT)
    first = await gw.embed(["A", "B"])
    assert seen == ["A", "B"]
    second = await gw.embed(["A"])  # cached → no new provider call
    assert seen == ["A", "B"]
    assert first[0] == second[0]


async def test_embed_dedups_within_a_batch_and_preserves_order() -> None:
    fn, seen = _counting_embedding_fn()
    gw = ModelGateway(
        _fake_capabilities(),
        embedding_fn=fn,
        embedding_cache=FakeCache(),
        usage_recorder=FakeRecorder(),
    ).for_project(PROJECT)
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
