"""Data-layer CLI commands (SPEC-03): migrate · backup · restore · forget --document."""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import typer
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from rsc_brain.cli._common import JSON_OPTION, emit_result, json_enabled
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


def preflight(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Report data that would block a migration — cross-project references (AUDIT-039 / R17).

    Read-only. Run it BEFORE ``brain migrate`` when upgrading an instance that predates
    project-qualified references: a violation means two tenants disagree about who owns a row, and
    deciding that is an operator's call. Nothing here reassigns or deletes anything.
    """
    from sqlalchemy import create_engine

    from rsc_brain.stores.relational.tenant_integrity import (
        cross_project_violations,
        violation_report,
    )

    engine = create_engine(resolve_dsn().replace("+asyncpg", "+psycopg"))
    try:
        with engine.connect() as connection:
            violations = cross_project_violations(connection)
    finally:
        engine.dispose()
    human = (
        "brain preflight: no cross-project references; the schema upgrade is safe to apply."
        if not violations
        else violation_report(violations)
    )
    emit_result(
        ctx,
        json_output,
        {"status": "ok" if not violations else "blocked", "violations": violations},
        human,
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
    output: Path = typer.Option(..., "--output", "-o", help="Destination snapshot directory."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Back up the whole instance: the database AND the stored source documents (R40).

    This used to write one ``pg_dump`` file. The database carries the graph and the vectors — both live
    in Postgres — but not the originals, so a backup was silently partial: restoring it produced a corpus
    whose every source document was missing while the rows still pointed at paths that no longer existed.
    And nothing recorded what a backup contained, so there was no way to find that out before needing it.

    The output is a directory with a manifest listing every component's size and SHA-256, which is what
    ``brain restore`` verifies before it activates anything.
    """
    from rsc_brain.deploy.snapshot import BLOBS_DIR, DATABASE_NAME, build_manifest, write_manifest

    output.mkdir(parents=True, exist_ok=True)
    env, url = _libpq(resolve_dsn())
    subprocess.run(
        [
            "pg_dump",
            "--format=custom",
            "--no-owner",
            "--file",
            str(output / DATABASE_NAME),
            url,
        ],
        env=env,
        check=True,
    )
    blobs_source = Path(_data_dir()) / "blobs"
    if blobs_source.exists():
        shutil.copytree(blobs_source, output / BLOBS_DIR, dirs_exist_ok=True)
    manifest = build_manifest(output, created_at=dt.datetime.now(dt.UTC).isoformat())
    write_manifest(output, manifest)
    emit_result(
        ctx,
        json_output,
        {
            "status": "ok",
            "action": "backup",
            "output": str(output),
            "components": len(manifest.components),
            "blobs": manifest.blob_count,
        },
        f"brain backup: wrote {output} ({len(manifest.components)} components, "
        f"{manifest.blob_count} stored documents).",
    )


def restore(
    ctx: typer.Context,
    snapshot: Path = typer.Argument(..., help="Snapshot directory produced by `brain backup`."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Restore a verified snapshot — and nothing else (R41).

    The snapshot is verified BEFORE anything is touched: format, completeness, sizes and SHA-256 of
    every component including each stored document. A snapshot that does not verify is refused with the
    reasons, and the existing target is left exactly as it was — a failed restore must not cost the
    operator the environment they still had.

    ``pg_restore --clean`` reports non-zero when it cannot DROP/recreate objects owned by the Apache AGE
    extension (its per-graph label tables resist a plain dump/restore), so its exit code alone is not the
    gate. But it is no longer ignored either: its output is surfaced, and the gate is the snapshot's own
    verification plus the post-restore database check (extensions + schema head).
    """
    from rsc_brain.deploy.snapshot import BLOBS_DIR, DATABASE_NAME, verify_snapshot

    verification = verify_snapshot(snapshot)
    if not verification.ok:
        typer.echo(f"brain restore: refusing to restore — {verification.explain()}", err=True)
        emit_result(
            ctx,
            json_output,
            {"status": "failed", "action": "restore", "problems": list(verification.problems)},
            "brain restore: snapshot did not verify; nothing was changed.",
        )
        raise typer.Exit(code=1)

    env, url = _libpq(resolve_dsn())
    result = subprocess.run(
        [
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--dbname",
            url,
            str(snapshot / DATABASE_NAME),
        ],
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
    # The originals are restored only after the database is verified: a half-restored data directory
    # beside an unusable database is the partial state this finding is about.
    restored_blobs = 0
    source = snapshot / BLOBS_DIR
    if source.exists():
        destination = Path(_data_dir()) / "blobs"
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, destination, dirs_exist_ok=True)
        restored_blobs = sum(1 for p in source.rglob("*") if p.is_file())
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "restore", "verified": True, "blobs": restored_blobs},
        f"brain restore: restored {snapshot} ({restored_blobs} stored documents) and verified.",
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


def _data_dir() -> str:
    """The configured data directory, so a deletion can reach the stored originals (R42/R44)."""
    from rsc_brain.config import load_settings

    return load_settings().ingest.data_dir


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
            await hard_delete_project(sessionmaker, scope, data_dir=_data_dir())
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


async def _export_rdf(sessionmaker: object, scope: ProjectScope) -> str:
    """Serialize the project's live entities to Turtle (FR-17.6): anchored ones link to their
    ``ontology_uri`` via owl:sameAs, unanchored ones are minted under the active ontology's
    ``uri_base``. Round-trips through rdflib. Read-only; respects the exporter's scope."""
    from rsc_brain.ontology.rdf_export import ExportEntity, export_turtle

    async with sessionmaker() as session:  # type: ignore[operator]
        rows = list(
            await session.execute(
                select(models.Entity.id, models.Entity.name, models.Entity.ontology_uri).where(
                    models.Entity.project_id == uuid.UUID(scope.project_id),
                    models.Entity.merged_into.is_(None),
                )
            )
        )
        uri_base = await session.scalar(
            select(models.Ontology.uri_base).where(
                models.Ontology.project_id == uuid.UUID(scope.project_id),
                models.Ontology.active.is_(True),
                models.Ontology.uri_base.is_not(None),
            )
        )
    entities = [ExportEntity(id=str(eid), name=name, ontology_uri=uri) for eid, name, uri in rows]
    return export_turtle(entities, uri_base=uri_base)


def export(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug/id to export."),
    okf: bool = typer.Option(True, "--okf/--no-okf", help="Export as an OKF bundle (FR-10.6)."),
    rdf: bool = typer.Option(
        False, "--rdf", help="Export the entity graph as RDF/Turtle (FR-17.6)."
    ),
    output: Path | None = typer.Option(None, "--output", "-o", help="Write the bundle to a file."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Export a project's active claims + skills as an OKF bundle (FR-10.6/12.7) or, with --rdf, the
    anchored entity graph as RDF/Turtle (FR-17.6). Respects the exporter's permissions. Read-only."""
    import json as _json

    from rsc_brain.export.okf import export_okf_bundle

    if rdf:
        _export_rdf_command(ctx, project, output, json_output)
        return

    if not okf:  # OKF and RDF are the supported open formats.
        typer.echo("export: pass --okf (default) or --rdf", err=True)
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


def _export_rdf_command(
    ctx: typer.Context, project: str, output: Path | None, json_output: bool
) -> None:
    async def _run() -> str | None:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project(sessionmaker, project)
            if project_id is None:
                return None
            scope = await _all_topics_scope(sessionmaker, project_id)
            return await _export_rdf(sessionmaker, scope)
        finally:
            await engine.dispose()

    turtle = asyncio.run(_run())
    if turtle is None:
        emit_result(
            ctx, json_output, {"error": "not_found", "project": project}, "project not found"
        )
        raise typer.Exit(code=1)
    if output is not None:
        output.write_text(turtle, encoding="utf-8")
    elif not json_enabled(ctx, json_output):
        typer.echo(turtle)
    emit_result(
        ctx,
        json_output,
        {
            "status": "ok",
            "action": "export",
            "format": "rdf",
            "written": str(output) if output else None,
            "turtle": turtle,
        },
        "brain export: RDF/Turtle" + (f" → {output}" if output else " (stdout above)"),
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
