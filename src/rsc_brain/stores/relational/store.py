"""Concrete ``RelationalStore`` over Postgres (async SQLAlchemy), implementing the frozen
protocol from SPEC-01. ``migrate`` is a step separate from boot (12-factor, D18)."""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.migrations import upgrade_to_head
from rsc_brain.stores.relational.repositories import KnowledgeRepository, UserRepository


class PgRelationalStore:
    """Async Postgres relational store. Hands out project-scoped knowledge repositories."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    @classmethod
    def from_dsn(cls, dsn: str | None = None) -> tuple[PgRelationalStore, AsyncEngine]:
        """Build a store from a DSN (env/config if omitted). Caller disposes the engine."""
        engine = make_engine(dsn)
        return cls(make_sessionmaker(engine)), engine

    async def migrate(self) -> None:
        # Alembic's async env uses asyncio.run() internally; run it off this loop.
        await asyncio.to_thread(upgrade_to_head)

    def knowledge(self) -> KnowledgeRepository:
        return KnowledgeRepository(self._sessionmaker)

    def users(self) -> UserRepository:
        return UserRepository(self._sessionmaker)
