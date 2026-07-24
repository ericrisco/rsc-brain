"""Data-layer CLI commands (SPEC-03): migrate · backup · restore · forget --document."""

from __future__ import annotations

import asyncio
import os
import subprocess
import uuid
from pathlib import Path

import typer
from sqlalchemy import text
from sqlalchemy.engine import make_url

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import (
    make_engine,
    make_sessionmaker,
    resolve_dsn,
    session_scope,
)
from rsc_brain.stores.relational.migrations import upgrade_to_head
from rsc_brain.stores.relational.store import PgRelationalStore


def migrate(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Apply pending database migrations to head. Idempotent (re-run = no-op)."""
    upgrade_to_head()
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "migrate", "target": "head"},
        "brain migrate: database is at head.",
    )


def _libpq(dsn: str) -> tuple[dict[str, str], str]:
    """Return (env, password-less libpq URL) so the secret never appears on the argv."""
    url = make_url(dsn)
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = url.password
    libpq_url = f"postgresql://{url.username}@{url.host}:{url.port}/{url.database}"
    return env, libpq_url


def backup(
    ctx: typer.Context,
    output: Path = typer.Option(..., "--output", "-o", help="Destination dump file."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Back up the database to a single pg_dump custom-format artifact (embeddings included)."""
    env, url = _libpq(resolve_dsn())
    subprocess.run(
        ["pg_dump", "--format=custom", "--no-owner", "--file", str(output), url],
        env=env,
        check=True,
    )
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "backup", "output": str(output)},
        f"brain backup: wrote {output}.",
    )


def restore(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="Dump file produced by `brain backup`."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Restore a dump, apply migrations, and verify the database (extensions + schema head)."""
    env, url = _libpq(resolve_dsn())
    subprocess.run(
        ["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", url, str(file)],
        env=env,
        check=True,
    )
    upgrade_to_head()
    verified = asyncio.run(_verify_database())
    if not verified:
        raise typer.Exit(code=1)
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "restore", "verified": True},
        f"brain restore: restored {file} and verified.",
    )


async def _verify_database() -> bool:
    engine = make_engine()
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            extensions = await session.scalar(
                text("SELECT count(*) FROM pg_extension WHERE extname IN ('age', 'vector')")
            )
            head = await session.scalar(text("SELECT count(*) FROM alembic_version"))
        return extensions == 2 and bool(head)
    finally:
        await engine.dispose()


def forget(
    ctx: typer.Context,
    document: str = typer.Option(..., "--document", help="Document id to hard-delete."),
    project: str = typer.Option(..., "--project", help="Project id the document belongs to."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Hard-delete a document (chunks/claims/embeddings cascade) and tombstone its graph nodes."""
    result = asyncio.run(_forget_document(project, document))
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "forget", "document": document, **result},
        f"brain forget: document {document} — deleted={result['deleted']}, "
        f"tombstoned={result['tombstoned']}.",
    )


async def _forget_document(project_id: str, document_id: str) -> dict[str, int]:
    engine = make_engine()
    sessionmaker = make_sessionmaker(engine)
    try:
        scope = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(project_id)
        deleted = await PgRelationalStore(sessionmaker).knowledge().hard_delete_document(
            scope, document_id
        )
        tombstoned = await AgeGraphStore(sessionmaker).tombstone_document(scope, document_id)
        async with session_scope(sessionmaker) as session:
            session.add(
                models.AuditLog(
                    project_id=uuid.UUID(project_id),
                    action="forget_document",
                    tool="cli",
                    principal_type="human",
                    principal_id="cli",
                    denied=False,
                )
            )
        return {"deleted": deleted, "tombstoned": tombstoned}
    finally:
        await engine.dispose()
