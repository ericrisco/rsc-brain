"""Token-budget + embedding-cache collaborators for the gateway (SPEC-22, FR-9.5/9.6).

These are the injectable seams the :class:`ModelGateway` consults when present: a
:class:`UsageRecorder` enforces a per-capability daily token budget and records consumption, and an
:class:`EmbeddingCache` returns already-computed vectors so the same text is never re-embedded. The
Postgres implementations live here; the gateway stays provider-agnostic and works without them.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import CapabilitiesConfig, Capability
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


class BudgetExceededError(RuntimeError):
    """The capability's daily token budget is exhausted (FR-9.5) — no provider call is made."""

    def __init__(self, capability: str) -> None:
        super().__init__(f"daily token budget exhausted for {capability}")
        self.capability = capability


class UsageRecorder(Protocol):
    async def enforce_budget(self, capability: str) -> None: ...
    async def record(self, capability: str, tokens: int) -> None: ...


class EmbeddingCache(Protocol):
    async def get_many(
        self, model: str, dimension: int, hashes: list[str]
    ) -> dict[str, list[float]]: ...
    async def put_many(self, model: str, dimension: int, items: dict[str, list[float]]) -> None: ...


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class PgUsageRecorder:
    """Per-capability/day token counters + budget enforcement, backed by ``token_usage``."""

    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], capabilities: CapabilitiesConfig
    ) -> None:
        self._sm = sessionmaker
        self._caps = capabilities

    async def enforce_budget(self, capability: str) -> None:
        budget = self._caps.get(Capability(capability)).daily_token_budget
        if budget is None:
            return
        if await self._today_tokens(capability) >= budget:
            raise BudgetExceededError(capability)

    async def record(self, capability: str, tokens: int) -> None:
        statement = (
            pg_insert(models.TokenUsage)
            .values(
                id=uuid.uuid4(),
                capability=capability,
                day=dt.datetime.now(dt.UTC).date(),
                tokens=tokens,
                calls=1,
            )
            .on_conflict_do_update(
                index_elements=["capability", "day"],
                set_={
                    "tokens": models.TokenUsage.tokens + tokens,
                    "calls": models.TokenUsage.calls + 1,
                },
            )
        )
        async with session_scope(self._sm) as session:
            await session.execute(statement)

    async def _today_tokens(self, capability: str) -> int:
        async with self._sm() as session:
            total = await session.scalar(
                select(models.TokenUsage.tokens).where(
                    models.TokenUsage.capability == capability,
                    models.TokenUsage.day == dt.datetime.now(dt.UTC).date(),
                )
            )
            return int(total or 0)

    async def usage(self, *, days: int = 7) -> list[dict[str, object]]:
        """Recent per-capability/day usage (for ``brain usage``)."""
        since = dt.datetime.now(dt.UTC).date() - dt.timedelta(days=days)
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.TokenUsage)
                .where(models.TokenUsage.day >= since)
                .order_by(models.TokenUsage.day.desc(), models.TokenUsage.capability)
            )
            return [
                {
                    "capability": r.capability,
                    "day": r.day.isoformat(),
                    "tokens": r.tokens,
                    "calls": r.calls,
                }
                for r in rows
            ]


class PgEmbeddingCache:
    """Text→vector cache keyed by SHA-256(text) + model + dimension (``embedding_cache``)."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def get_many(
        self, model: str, dimension: int, hashes: list[str]
    ) -> dict[str, list[float]]:
        if not hashes:
            return {}
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.EmbeddingCache).where(
                    models.EmbeddingCache.model == model,
                    models.EmbeddingCache.dimension == dimension,
                    models.EmbeddingCache.text_hash.in_(hashes),
                )
            )
            return {r.text_hash: [float(x) for x in r.embedding] for r in rows}

    async def put_many(self, model: str, dimension: int, items: dict[str, list[float]]) -> None:
        if not items:
            return
        statement = pg_insert(models.EmbeddingCache).values(
            [
                {
                    "id": uuid.uuid4(),
                    "text_hash": h,
                    "model": model,
                    "dimension": dimension,
                    "embedding": vector,
                }
                for h, vector in items.items()
            ]
        )
        statement = statement.on_conflict_do_nothing(
            index_elements=["text_hash", "model", "dimension"]
        )
        async with session_scope(self._sm) as session:
            await session.execute(statement)
