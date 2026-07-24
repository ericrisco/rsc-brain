"""Alembic async environment. DSN comes from the environment (12-factor), never the ini."""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from rsc_brain.stores.relational.database import resolve_dsn
from rsc_brain.stores.relational.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", resolve_dsn())
target_metadata = Base.metadata


# Migration-only objects (created in a migration, not declared on the models) that must be
# excluded from autogenerate/check comparison so they don't register as drift.
_MIGRATION_ONLY_INDEXES = {"ix_chunks_embedding_hnsw", "ix_claims_embedding_hnsw"}


def _include_object(obj, name, type_, reflected, compare_to):
    if type_ == "index" and name in _MIGRATION_ONLY_INDEXES:
        return False
    # procrastinate owns its own tables/indexes (applied by migration 0003 from its packaged
    # schema); they are not SQLAlchemy models, so exclude them from drift comparison.
    if name is not None and name.startswith("procrastinate"):
        return False
    return True


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        include_object=_include_object,
    )


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_migrations(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    connectable = async_engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(_do_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
