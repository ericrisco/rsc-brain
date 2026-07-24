"""Async SQLAlchemy engine + session factory (12-factor: DSN from config/env).

The DSN is a secret and is resolved from configuration (``RSC_BRAIN_DATABASE__DSN``), never
hard-coded. Nothing here holds local state beyond the connection pool.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import Engine, create_engine
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import Session, sessionmaker

DSN_ENV_VAR = "RSC_BRAIN_DATABASE__DSN"


class DatabaseNotConfiguredError(RuntimeError):
    """Raised when no database DSN is available in configuration or the environment."""


def resolve_dsn(dsn: str | None = None) -> str:
    """Return the async DSN: explicit arg, then the env var, then the app config.

    The env var is checked before the full app config so migrations/tooling need only a DSN,
    not the whole capability configuration.
    """
    if dsn is not None:
        return dsn
    env_dsn = os.environ.get(DSN_ENV_VAR)
    if env_dsn:
        return env_dsn
    # Fall back to the full application config (imported lazily to avoid a hard dependency).
    from rsc_brain.config import load_settings

    secret = load_settings().database.dsn
    if secret is None:
        raise DatabaseNotConfiguredError(
            f"No database DSN configured. Set {DSN_ENV_VAR} "
            "(e.g. postgresql+asyncpg://user:pass@host:5432/rsc_brain)."
        )
    return secret.get_secret_value()


def make_engine(dsn: str | None = None, *, echo: bool = False) -> AsyncEngine:
    """Create an async engine. Caller owns disposal (`await engine.dispose()`)."""
    return create_async_engine(resolve_dsn(dsn), echo=echo, pool_pre_ping=True)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


def sync_dsn(dsn: str | None = None) -> str:
    """The synchronous (psycopg) form of the DSN — Authlib's authorization server (SPEC-10) is
    sync, so its callbacks run over a sync engine. Swaps the asyncpg driver for psycopg."""
    resolved = resolve_dsn(dsn)
    return resolved.replace("+asyncpg", "+psycopg").replace(
        "postgresql://", "postgresql+psycopg://"
    )


def make_sync_engine(dsn: str | None = None, *, echo: bool = False) -> Engine:
    """Create a synchronous engine (psycopg) for the OAuth authorization server. Caller owns
    disposal (`engine.dispose()`)."""
    return create_engine(sync_dsn(dsn), echo=echo, pool_pre_ping=True)


def make_sync_sessionmaker(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


@asynccontextmanager
async def session_scope(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Transactional scope: commit on success, roll back on error."""
    async with sessionmaker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
