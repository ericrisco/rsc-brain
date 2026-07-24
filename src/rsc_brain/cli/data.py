"""Data-layer CLI commands (SPEC-03): migrate · backup · restore · forget --document."""

from __future__ import annotations

import asyncio
import os
import subprocess
import uuid
from pathlib import Path

import typer
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
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
    """Restore a dump, apply migrations, and verify the database (extensions + schema head).

    ``pg_restore --clean`` reports non-zero when it cannot DROP/recreate objects owned by the
    Apache AGE extension (its per-graph label tables and the extension itself resist a plain
    dump/restore) — those errors are **non-fatal**: the data restores regardless. So the
    post-restore **verification** (extensions present + schema at head), not pg_restore's exit
    code, is the gate."""
    env, url = _libpq(resolve_dsn())
    result = subprocess.run(
        ["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", url, str(file)],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    upgrade_to_head()
    verified = asyncio.run(_verify_database())
    if not verified:
        typer.echo(result.stderr, err=True)
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
    project: str = typer.Option(..., "--project", help="Project id the target belongs to."),
    document: str | None = typer.Option(None, "--document", help="Document id to hard-delete."),
    entity: str | None = typer.Option(
        None, "--entity", help="Entity name to erase (GDPR, FR-4.6)."
    ),
    whole_project: bool = typer.Option(
        False, "--whole-project", help="Hard-delete the ENTIRE project (FR-12.7, double-confirm)."
    ),
    yes: bool = typer.Option(False, "--yes", help="First confirmation for a whole-project wipe."),
    confirm_slug: str | None = typer.Option(
        None, "--confirm-slug", help="Second confirmation: re-type the project slug."
    ),
    json_output: bool = JSON_OPTION,
) -> None:
    """Hard-delete a document, erase an entity (GDPR), or wipe a whole project (FR-12.7). A
    whole-project wipe needs double confirmation: --yes AND --confirm-slug matching the project."""
    if sum([bool(document), bool(entity), whole_project]) != 1:
        typer.echo("forget: pass exactly one of --document, --entity, or --whole-project", err=True)
        raise typer.Exit(code=2)
    if whole_project:
        _forget_project_cmd(
            ctx, project, yes=yes, confirm_slug=confirm_slug, json_output=json_output
        )
        return
    if entity is not None:
        _forget_entity_cmd(ctx, project, entity, json_output)
        return
    result = asyncio.run(_forget_document(project, str(document)))
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
        deleted = (
            await PgRelationalStore(sessionmaker)
            .knowledge()
            .hard_delete_document(scope, document_id)
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


def _forget_entity_cmd(ctx: typer.Context, project_id: str, name: str, json_output: bool) -> None:
    from rsc_brain.knowledge.gdpr import forget_entity

    async def _run() -> dict[str, int]:
        engine = make_engine()
        try:
            scope = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(
                project_id
            )
            return await forget_entity(make_sessionmaker(engine), scope, name)
        finally:
            await engine.dispose()

    result = asyncio.run(_run())
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "forget", "entity": name, **result},
        f"brain forget: entity {name!r} — deleted={result['deleted_entities']}, "
        f"tombstoned={result['tombstoned']}.",
    )


async def _resolve_project(sessionmaker: object, slug_or_id: str) -> str | None:
    """Resolve a project slug (or accept an id) to its id, or None if absent."""
    async with sessionmaker() as session:  # type: ignore[operator]
        pid = await session.scalar(
            select(models.Project.id).where(models.Project.slug == slug_or_id)
        )
    return str(pid) if pid else slug_or_id if _looks_like_uuid(slug_or_id) else None


def _looks_like_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _forget_project_cmd(
    ctx: typer.Context, project: str, *, yes: bool, confirm_slug: str | None, json_output: bool
) -> None:
    from rsc_brain.knowledge.gdpr import hard_delete_project

    if project == "default":
        typer.echo("forget: the 'default' project cannot be deleted", err=True)
        raise typer.Exit(code=2)
    if not (yes and confirm_slug == project):
        typer.echo(
            "forget --whole-project needs --yes AND --confirm-slug matching the project", err=True
        )
        raise typer.Exit(code=2)

    async def _run() -> bool:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project(sessionmaker, project)
            if project_id is None:
                return False
            scope = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(
                project_id
            )
            await hard_delete_project(sessionmaker, scope)
            return True
        finally:
            await engine.dispose()

    if not asyncio.run(_run()):
        emit_result(
            ctx, json_output, {"error": "not_found", "project": project}, "project not found"
        )
        raise typer.Exit(code=1)
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "forget_project", "project": project},
        f"brain forget: project {project!r} wiped.",
    )


async def _all_topics_scope(sessionmaker: object, project_id: str) -> ProjectScope:
    """A CLI curator scope that can see every topic in the project (for full-project export)."""
    async with sessionmaker() as session:  # type: ignore[operator]
        slugs = list(
            await session.scalars(
                select(models.Topic.slug).where(models.Topic.project_id == uuid.UUID(project_id))
            )
        )
    return Principal(
        id="cli", type=PrincipalType.HUMAN, allowed_topics=frozenset(slugs), can_curate=True
    ).scope_for(project_id)


def export(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug/id to export."),
    okf: bool = typer.Option(True, "--okf/--no-okf", help="Export as an OKF bundle (FR-10.6)."),
    output: Path | None = typer.Option(None, "--output", "-o", help="Write the bundle to a file."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Export a project's active claims + skills as an OKF bundle (FR-10.6/12.7), respecting the
    exporter's permissions. Read-only."""
    import json as _json

    from rsc_brain.export.okf import export_okf_bundle

    if not okf:  # OKF is the only supported open format today (RDF export lands in SPEC-24)
        typer.echo("export: only --okf is supported in this release", err=True)
        raise typer.Exit(code=2)

    async def _run() -> dict[str, object] | None:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project(sessionmaker, project)
            if project_id is None:
                return None
            scope = await _all_topics_scope(sessionmaker, project_id)
            return await export_okf_bundle(sessionmaker, scope)
        finally:
            await engine.dispose()

    bundle = asyncio.run(_run())
    if bundle is None:
        emit_result(
            ctx, json_output, {"error": "not_found", "project": project}, "project not found"
        )
        raise typer.Exit(code=1)
    if output is not None:
        output.write_text(_json.dumps(bundle, indent=2) + "\n", encoding="utf-8")
    n_claims = len(bundle.get("rsc_brain_claims", []))  # type: ignore[arg-type]
    emit_result(
        ctx,
        json_output,
        {
            "status": "ok",
            "action": "export",
            "written": str(output) if output else None,
            "bundle": bundle,
        },
        f"brain export: {n_claims} claims + skills as OKF"
        + (f" → {output}" if output else " (stdout)"),
    )


def demo(
    ctx: typer.Context,
    reset: bool = typer.Option(False, "--reset", help="Remove the demo company completely."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Seed a fictional company end-to-end (FR-10.7); --reset removes it."""
    from rsc_brain.demo import reset_demo, seed_demo

    async def _run() -> dict[str, object]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            return await (reset_demo(sessionmaker) if reset else seed_demo(sessionmaker))
        finally:
            await engine.dispose()

    result = asyncio.run(_run())
    emit_result(ctx, json_output, result, f"brain demo: {result['status']} ({result['slug']})")
