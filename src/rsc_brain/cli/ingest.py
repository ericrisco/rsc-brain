"""Ingestion CLI (SPEC-05): ``brain ingest`` · ``brain status`` · ``brain docs`` · ``brain sources``.

The CLI acts as a local ``cli`` principal scoped to an explicit ``--project`` slug; the project id
is resolved from the slug in the database (never trusted from the client as a knowledge scope,
FR-12.3). Commands that publish (``ingest``, ``docs approve``) build the model gateway from
configuration; read/lifecycle commands do not need it.
"""

from __future__ import annotations

import asyncio
import glob
from collections.abc import Awaitable, Callable, Coroutine
from pathlib import Path
from typing import Any

import typer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.ingest.service import IngestService
from rsc_brain.ingest.sources import SourceService
from rsc_brain.ingest.types import DocStatus
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.ingest_repository import IngestRepository


class _ProjectNotFoundError(RuntimeError):
    pass


async def _resolve_project_id(sessionmaker: async_sessionmaker[AsyncSession], slug: str) -> str:
    async with sessionmaker() as session:
        pid = await session.scalar(select(models.Project.id).where(models.Project.slug == slug))
    if pid is None:
        raise _ProjectNotFoundError(slug)
    return str(pid)


#: The topic authority a local CLI invocation carries. It is empty on purpose: R01/AUDIT-020 —
#: no role, and no amount of shell access, implies authority over a topic. Granting the CLI
#: blanket topic authority would make the box's root account a universal reader.
_CLI_TOPICS: frozenset[str] = frozenset()


def _cli_scope(project_id: str) -> ProjectScope:
    return Principal(
        id="cli", type=PrincipalType.HUMAN, can_curate=True, allowed_topics=_CLI_TOPICS
    ).scope_for(project_id)


def _empty_queue_message() -> str:
    """AUDIT-089: "review queue empty" was a claim about the world; the truth was about the caller.

    `list_documents_by_status` filters the approval queue by the caller's topic authority in-query
    (R01 — the queue's titles and proposed tags *are* topic-scoped content). The CLI principal holds
    no grants, so every document that carries a topic is invisible to it, and the command reported
    that as an empty queue.

    Measured on a real host: the API listed one document `pending_approval` in project `globex`
    while `brain docs review --project globex` printed "review queue empty" — for a **prompt-
    injection document the topicalizer had correctly tagged `hr` + `payroll`**, sitting in the human
    approval gate. An operator working from the CLI would have concluded there was nothing to
    review, about the single document that most needed a human.

    The fix is not to widen the CLI's authority — that would void R01 and hand the box's root
    account universal read. It is to stop the command asserting emptiness it cannot know. The
    message states a fact about the *caller*, which leaks nothing about the corpus and so keeps
    FR-4.3 (denied ≡ non-existent) intact: it never says whether anything is hidden.
    """
    if not _CLI_TOPICS:
        return (
            "no documents awaiting approval that this caller may see — the CLI principal holds no "
            "topic grants, so any pending document carrying a topic is filtered out (R01). Use a "
            "project-scoped token for a member with the relevant topics to review those."
        )
    return "no documents awaiting approval that this caller may see"


def _run_with_repo[T](slug: str, fn: Callable[[IngestRepository, ProjectScope], Awaitable[T]]) -> T:
    async def _inner() -> T:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, slug)
            return await fn(IngestRepository(sessionmaker), _cli_scope(project_id))
        finally:
            await engine.dispose()

    return _dispatch(_inner())


def _run_with_service[T](slug: str, fn: Callable[[IngestService, ProjectScope], Awaitable[T]]) -> T:
    async def _inner() -> T:
        from rsc_brain import runtime

        # AUDIT-112 / R53: this used to assemble its own graph — a bare `ModelGateway` with no usage
        # recorder and no embedding cache, and a pipeline with no contradiction resolver. So a
        # document put in with `brain ingest` spent tokens nobody recorded, re-embedded text the API
        # would have reused, and was never checked against the corpus for contradictions. The CLI is
        # a third role, and it gets the same graph as the other two.
        dependencies = runtime.build("cli")
        try:
            sessionmaker = dependencies.sessionmaker
            project_id = await _resolve_project_id(sessionmaker, slug)
            repo = IngestRepository(sessionmaker)
            pipeline = runtime.build_pipeline(dependencies)
            service = IngestService(repo, pipeline, data_dir=dependencies.data_dir)
            return await fn(service, _cli_scope(project_id))
        finally:
            await dependencies.dispose()

    return _dispatch(_inner())


def _dispatch[T](coro: Coroutine[Any, Any, T]) -> T:
    try:
        return asyncio.run(coro)
    except _ProjectNotFoundError as exc:
        typer.echo(f"project not found: {exc}", err=True)
        raise typer.Exit(code=2) from exc


def _expand(path: str) -> list[Path]:
    if any(ch in path for ch in "*?["):
        # A user-supplied glob (possibly recursive **) is exactly glob's job; splitting it into a
        # pathlib base+pattern is error-prone for absolute/recursive patterns.
        matches = glob.glob(path, recursive=True)  # noqa: PTH207
        return [Path(p) for p in sorted(matches) if Path(p).is_file()]
    target = Path(path)
    if target.is_dir():
        return [p for p in sorted(target.rglob("*")) if p.is_file()]
    return [target]


# --- brain ingest -----------------------------------------------------------


def ingest(
    ctx: typer.Context,
    path: str = typer.Argument(..., help="File, directory, or glob to ingest."),
    project: str = typer.Option(..., "--project", help="Target project slug."),
    source: str | None = typer.Option(None, "--source", help="Source name (default if omitted)."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Ingest PDFs/markdown into a project (dedup by checksum; D13 approval gate)."""
    files = _expand(path)
    if not files:
        typer.echo(f"no files matched: {path}", err=True)
        raise typer.Exit(code=2)

    async def _do(service: IngestService, scope: ProjectScope) -> list[dict[str, object]]:
        results: list[dict[str, object]] = []
        for file in files:
            outcome = await service.ingest_path(scope, file, source=source)
            results.append(
                {
                    "file": str(file),
                    "document_id": outcome.document_id,
                    "status": outcome.status,
                    "duplicate": outcome.duplicate,
                }
            )
        return results

    results = _run_with_service(project, _do)
    human = "\n".join(
        f"{r['file']}: {r['status']}" + (" (duplicate no-op)" if r["duplicate"] else "")
        for r in results
    )
    emit_result(ctx, json_output, {"ingested": results}, human)


# --- brain status -----------------------------------------------------------


def status(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Show per-document ingestion runs: phase, stages, claims, errors (FR-1.12)."""

    async def _do(repo: IngestRepository, scope: ProjectScope) -> list[dict[str, object]]:
        runs = await repo.list_run_statuses(scope)
        return [
            {
                "document_id": r.document_id,
                "phase": r.phase,
                "completed_stages": list(r.completed_stages),
                "chunks_created": r.chunks_created,
                "claims_generated": r.claims_generated,
                "tables_converted": r.tables_converted,
                "tables_needs_review": r.tables_needs_review,
                "discarded_chunks": r.discarded_chunks,
                "error": r.error,
            }
            for r in runs
        ]

    runs = _run_with_repo(project, _do)
    human = "\n".join(
        f"{r['document_id']}: {r['phase']} "
        f"(chunks={r['chunks_created']}, claims={r['claims_generated']}, "
        f"discarded={r['discarded_chunks']})"
        for r in runs
    )
    emit_result(ctx, json_output, {"runs": runs}, human or "no ingestion runs")


# --- brain docs (review/approve/reject) -------------------------------------

docs_app = typer.Typer(
    help="Review, approve, and reject ingested documents (D13).", no_args_is_help=True
)


@docs_app.command("review")
def docs_review(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List documents awaiting approval, with proposed tags."""

    async def _do(repo: IngestRepository, scope: ProjectScope) -> list[dict[str, object]]:
        pending = await repo.list_documents_by_status(scope, "pending_approval")
        return [
            {"document_id": d.id, "title": d.title, "proposed_tags": list(d.doc_tags)}
            for d in pending
        ]

    pending = _run_with_repo(project, _do)
    human = "\n".join(f"{d['document_id']}: {d['proposed_tags']}" for d in pending)
    emit_result(
        ctx,
        json_output,
        {"pending": pending, "topic_authority": sorted(_CLI_TOPICS)},
        human or _empty_queue_message(),
    )


@docs_app.command("approve")
def docs_approve(
    ctx: typer.Context,
    document_id: str = typer.Argument(..., help="Document id to approve."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    tags: list[str] | None = typer.Option(None, "--tags", help="Corrected tags (repeatable)."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Approve a pending document (optionally correcting tags) and publish it."""

    async def _do(service: IngestService, scope: ProjectScope) -> dict[str, object]:
        run = await service.approve(scope, document_id, tags=tags or None, approver="cli")
        return {"document_id": document_id, "phase": run.phase, "claims": run.claims_generated}

    result = _run_with_service(project, _do)
    emit_result(ctx, json_output, {"status": "ok", **result}, f"approved {document_id}")


@docs_app.command("reject")
def docs_reject(
    ctx: typer.Context,
    document_id: str = typer.Argument(..., help="Document id to reject."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    reason: str = typer.Option(..., "--reason", help="Reason (kept, auditable)."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Reject a document: keep the file + reason, ingest nothing.

    T022 re-audit: this used to write the status directly, so it could reject an ALREADY PUBLISHED
    document — the record saying refused while its claims stayed live and recallable, which is exactly
    what R31 forbids through the service. Two routes to one decision, answering differently depending on
    which one the operator reached for. It goes through the same conditional transition now.
    """

    async def _do(repo: IngestRepository, scope: ProjectScope) -> bool:
        return await repo.transition_status(
            scope,
            document_id,
            expected=[
                DocStatus.RECEIVED.value,
                DocStatus.PARSED.value,
                DocStatus.PENDING_APPROVAL.value,
                DocStatus.AUTO_APPROVED.value,
                DocStatus.REJECTED.value,
            ],
            status=DocStatus.REJECTED.value,
            reject_reason=reason,
        )

    if not _run_with_repo(project, _do):
        typer.echo(
            f"docs reject: {document_id} can no longer be rejected (it is published or absent)",
            err=True,
        )
        raise typer.Exit(code=1)
    emit_result(
        ctx, json_output, {"status": "ok", "rejected": document_id}, f"rejected {document_id}"
    )


# --- brain sources ----------------------------------------------------------

sources_app = typer.Typer(
    help="Manage ingestion sources and their D13 policy.", no_args_is_help=True
)


@sources_app.command("create")
def sources_create(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Source name."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    type_: str = typer.Option("folder", "--type", help="folder|api|connector."),
    policy: str = typer.Option("llm", "--policy", help="manual|source_tags|llm|llm_review."),
    tags: list[str] | None = typer.Option(None, "--tag", help="Default tag (repeatable)."),
    review_if_sensitive: bool = typer.Option(True, "--review-if-sensitive/--no-review"),
    json_output: bool = JSON_OPTION,
) -> None:
    """Create a source with its D13 categorization policy."""

    async def _do(repo: IngestRepository, scope: ProjectScope) -> str:
        return await SourceService(repo).create(
            scope,
            name=name,
            type_=type_,
            policy=policy,
            default_tags=tags or (),
            review_if_sensitive=review_if_sensitive,
        )

    source_id = _run_with_repo(project, _do)
    emit_result(
        ctx, json_output, {"status": "ok", "source_id": source_id, "name": name}, f"created {name}"
    )


@sources_app.command("list")
def sources_list(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List a project's sources."""

    async def _do(repo: IngestRepository, scope: ProjectScope) -> list[dict[str, object]]:
        rows = await repo.list_sources(scope)
        return [
            {
                "id": s.id,
                "name": s.name,
                "type": s.type,
                "policy": s.policy,
                "default_tags": list(s.default_tags),
                "review_if_sensitive": s.review_if_sensitive,
            }
            for s in rows
        ]

    rows = _run_with_repo(project, _do)
    human = "\n".join(f"{s['name']} [{s['policy']}]" for s in rows)
    emit_result(ctx, json_output, {"sources": rows}, human or "no sources")
