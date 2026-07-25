"""Token-budget + embedding-cache collaborators for the gateway (SPEC-22, FR-9.5/9.6).

These are the injectable seams the :class:`ModelGateway` consults when present: a
:class:`UsageRecorder` enforces a per-capability daily token budget and records consumption, and an
:class:`EmbeddingCache` returns already-computed vectors so the same text is never re-embedded. The
Postgres implementations live here; the gateway stays provider-agnostic and works without them.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import CapabilitiesConfig, Capability
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

_log = logging.getLogger(__name__)


class BudgetExceededError(RuntimeError):
    """The capability's daily token budget is exhausted (FR-9.5) — no provider call is made."""

    def __init__(self, capability: str) -> None:
        super().__init__(f"daily token budget exhausted for {capability}")
        self.capability = capability


@dataclass(slots=True)
class Attempt:
    """One provider attempt's accounting handle (R29).

    ``held`` is what the attempt reserved before the call; ``spent`` is what the provider reported.
    Settlement is the difference, applied when the reservation's scope exits — including on failure,
    because a failed request is not free and an unsettled reservation would leak budget.
    """

    held: int = 0
    spent: int = 0


class UsageRecorder(Protocol):
    async def enforce_budget(self, capability: str) -> None: ...
    async def record(self, capability: str, tokens: int) -> None: ...
    def reserve(self, capability: str) -> AbstractAsyncContextManager[Attempt]: ...


class EmbeddingCache(Protocol):
    async def get_many(
        self, model: str, dimension: int, hashes: list[str]
    ) -> dict[str, list[float]]: ...
    async def put_many(self, model: str, dimension: int, items: dict[str, list[float]]) -> None: ...


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


#: What one attempt reserves before the provider is called, in tokens. The real cost is unknown until
#: the response arrives, so the reservation is a deliberate over-estimate of a small call: it makes the
#: ceiling hold under concurrency, and `record` settles the difference immediately afterwards.
_RESERVATION_TOKENS = 1000


class PgUsageRecorder:
    """Per-project/capability/day token counters + budget enforcement (``token_usage``).

    R12: a recorder is bound to ONE project, because that is the unit an attempt is attributable to
    and a budget is evaluated against. An unbound recorder is what the process holds before it knows
    whose work it is doing; bind it with :meth:`for_project` at the boundary where the scope is
    known (see :meth:`rsc_brain.gateway.model_gateway.ModelGateway.for_project`). An unbound
    recorder still records — dropping accounting would be a worse failure than an unattributed row —
    but it logs the omission and its row belongs to no project's report.
    """

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        capabilities: CapabilitiesConfig,
        *,
        project_id: str | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._caps = capabilities
        self._project_id = project_id

    def for_project(self, project_id: str) -> PgUsageRecorder:
        """This recorder, bound to ``project_id`` — every count and budget decision is that
        project's own."""
        return PgUsageRecorder(self._sm, self._caps, project_id=project_id)

    @property
    def project_id(self) -> str | None:
        return self._project_id

    def _pid(self) -> uuid.UUID | None:
        return uuid.UUID(self._project_id) if self._project_id else None

    async def enforce_budget(self, capability: str) -> None:
        """Refuse the attempt when THIS project has spent its daily budget for ``capability``.

        Another project's traffic cannot exhaust it: the counter it reads is the bound project's.

        A READ, and advisory by construction: it answers "is this project already over" without
        holding anything. An attempt that intends to spend must go through :meth:`reserve` — R29 is
        about the gap between asking and spending, and a check that reserved nothing is exactly that
        gap. Kept because reporting and preflight paths legitimately want to ask.
        """
        _reservation, budget = self._reservation(capability)
        if budget is None:
            return
        if await self._today_tokens(capability) >= budget:
            raise BudgetExceededError(capability)

    @asynccontextmanager
    async def reserve(self, capability: str) -> AsyncIterator[Attempt]:
        """Hold budget for ONE attempt, then settle it with what the attempt actually spent (R29).

        The hold is applied in the same statement that reads the counter, so concurrent attempts cannot
        all pass one check and spend anyway — which is how a daily budget used to be exceeded by as many
        attempts as happened to be in flight. Settlement runs in a ``finally``, so a provider failure
        still costs what it cost and never leaves a reservation outstanding.

        The hold never exceeds the budget itself, or the first attempt of the day against a small
        budget would be refused before spending anything.
        """
        reservation, budget = self._reservation(capability)
        if budget is not None:
            total = await self._add(capability, reservation, calls=0)
            # `total - reservation` is what the day had spent BEFORE this attempt: the ratified
            # semantics (refuse an attempt that starts already at or over the ceiling), now atomic.
            if total - reservation >= budget:
                await self._add(capability, -reservation, calls=0)
                raise BudgetExceededError(capability)
        attempt = Attempt(held=reservation if budget is not None else 0)
        try:
            yield attempt
        finally:
            await self._add(capability, attempt.spent - attempt.held, calls=1)

    async def record(self, capability: str, tokens: int) -> None:
        """Record what an attempt spent, for a caller that is not using :meth:`reserve`.

        Called once per ATTEMPT — including a repair round, a fallback attempt and a failure — because
        each one costs the provider's tokens whatever the outcome was. Recording only successes made a
        failing extraction free, which is exactly backwards: a capability that keeps failing is the one
        spending most.
        """
        if self._project_id is None:
            _log.warning(
                "usage_unattributed",
                extra={"capability": capability, "tokens": tokens},
            )
        await self._add(capability, tokens, calls=1)

    def _reservation(self, capability: str) -> tuple[int, int | None]:
        """``(tokens to reserve, daily budget)`` for ``capability``; budget ``None`` means unlimited.

        The reservation never exceeds the budget itself: a 1000-token hold against a 200-token budget
        would refuse the first attempt of the day. A capability name outside the configured set (a
        caller's own label) has no budget and reserves nothing — accounting still records it, because
        dropping the row would be a worse failure than an unbudgeted one.
        """
        try:
            budget = self._caps.get(Capability(capability)).daily_token_budget
        except (ValueError, AttributeError, KeyError):
            return 0, None
        if budget is None:
            return 0, None
        return min(_RESERVATION_TOKENS, budget), budget

    async def _add(self, capability: str, tokens: int, *, calls: int) -> int:
        """Add ``tokens`` to today's counter for this project and return the new total.

        One statement: the read and the increment cannot be interleaved, which is what makes a budget
        hold under concurrency.
        """
        statement = (
            pg_insert(models.TokenUsage)
            .values(
                id=uuid.uuid4(),
                project_id=self._pid(),
                capability=capability,
                day=dt.datetime.now(dt.UTC).date(),
                tokens=tokens,
                calls=calls,
            )
            .on_conflict_do_update(
                index_elements=["project_id", "capability", "day"],
                set_={
                    "tokens": models.TokenUsage.tokens + tokens,
                    "calls": models.TokenUsage.calls + calls,
                },
            )
            .returning(models.TokenUsage.tokens)
        )
        async with session_scope(self._sm) as session:
            total = await session.scalar(statement)
        return int(total or 0)

    async def _today_tokens(self, capability: str) -> int:
        async with self._sm() as session:
            total = await session.scalar(
                select(func.coalesce(func.sum(models.TokenUsage.tokens), 0)).where(
                    models.TokenUsage.capability == capability,
                    models.TokenUsage.day == dt.datetime.now(dt.UTC).date(),
                    _project_condition(self._pid()),
                )
            )
            return int(total or 0)

    async def usage(self, *, days: int = 7) -> list[dict[str, object]]:
        """This project's recent per-capability/day usage (for ``brain usage``)."""
        return await usage_by_day(self._sm, days=days, project_id=self._project_id)


def _project_condition(pid: uuid.UUID | None) -> ColumnElement[bool]:
    """Match exactly the bound project's rows — or exactly the unattributed ones when unbound.

    Written as an explicit predicate because ``= NULL`` never matches: without it an unbound
    recorder would read the whole instance's counter, which is the pooling R12 removes.
    """
    if pid is None:
        return models.TokenUsage.project_id.is_(None)
    return models.TokenUsage.project_id == pid


async def usage_by_day(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    days: int = 7,
    project_id: str | None = None,
) -> list[dict[str, object]]:
    """Recent per-capability/day token + call usage for ONE project (R12).

    The single source of truth shared by ``brain usage`` (CLI) and the console usage view
    (SPEC-26 FR-13.7), so the two always agree. ``project_id=None`` reads the unattributed rows
    only — never the instance-wide pool, which is what made every tenant read the same total.
    """
    since = dt.datetime.now(dt.UTC).date() - dt.timedelta(days=days)
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(models.TokenUsage)
            .where(
                models.TokenUsage.day >= since,
                _project_condition(uuid.UUID(project_id) if project_id else None),
            )
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


async def usage_all_projects(
    sessionmaker: async_sessionmaker[AsyncSession], *, days: int = 7
) -> list[dict[str, object]]:
    """Instance-wide usage per capability/day — the OPERATOR view (R10/R12).

    Deliberately a separate function from :func:`usage_by_day`: the pooled total is a legitimate
    cost/capacity signal for whoever runs the instance, and an illegitimate answer to "what did my
    project spend?". Keeping them apart is what stops one from being served as the other, which is
    exactly how R12 happened.
    """
    since = dt.datetime.now(dt.UTC).date() - dt.timedelta(days=days)
    async with sessionmaker() as session:
        rows = await session.execute(
            select(
                models.TokenUsage.capability,
                models.TokenUsage.day,
                func.sum(models.TokenUsage.tokens),
                func.sum(models.TokenUsage.calls),
            )
            .where(models.TokenUsage.day >= since)
            .group_by(models.TokenUsage.capability, models.TokenUsage.day)
            .order_by(models.TokenUsage.day.desc(), models.TokenUsage.capability)
        )
        return [
            {
                "capability": capability,
                "day": day.isoformat(),
                "tokens": int(tokens or 0),
                "calls": int(calls or 0),
            }
            for capability, day, tokens, calls in rows.all()
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
