"""`brain entities` CLI (SPEC-09, FR-1.9 P1): propose alias-merges and manage the review queue.

``merge`` runs the deterministic proposer (auto-applies high-confidence, queues the rest);
``merges list|confirm|reject|reverse`` drives the human confirmation and recovery lifecycle. Live LLM proposing is
blocked-by-resource — the deterministic proposer is the CLI/CI path.
"""

from __future__ import annotations

import typer

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.cli.ingest import _cli_scope, _dispatch, _resolve_project_id
from rsc_brain.config import load_settings
from rsc_brain.knowledge.entity_merge import DeterministicMergeProposer, EntityMergeService
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.entity_store import EntityStore

entities_app = typer.Typer(help="Entity dedup and alias-merge review.", no_args_is_help=True)
merges_app = typer.Typer(help="Review the alias-merge queue.", no_args_is_help=True)
entities_app.add_typer(merges_app, name="merges")


def _build_service(sessionmaker: object) -> EntityMergeService:
    settings = load_settings()
    return EntityMergeService(
        store=EntityStore(sessionmaker),  # type: ignore[arg-type]
        graph=AgeGraphStore(sessionmaker),  # type: ignore[arg-type]
        proposer=DeterministicMergeProposer(min_similarity=settings.knowledge.merge_min_similarity),
        sessionmaker=sessionmaker,  # type: ignore[arg-type]
        config=settings.knowledge,
    )


@entities_app.command("merge")
def entities_merge(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Propose alias-merges: auto-apply high-confidence ones, queue the rest for review."""

    async def _run() -> tuple[int, int]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            summary = await _build_service(sessionmaker).propose(_cli_scope(project_id))
            return len(summary.auto_applied), len(summary.queued)
        finally:
            await engine.dispose()

    auto, queued = _dispatch(_run())
    emit_result(
        ctx,
        json_output,
        {"auto_applied": auto, "queued": queued},
        f"auto-applied {auto}, queued {queued} for review",
    )


@merges_app.command("list")
def merges_list(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    status: str | None = typer.Option(None, "--status", help="Filter by status."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List merge proposals (newest first)."""

    async def _run() -> list[dict[str, object]]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            rows = await EntityStore(sessionmaker).list_proposals(
                _cli_scope(project_id), status=status
            )
            return [
                {
                    "id": r.id,
                    "canonical": r.canonical_entity_id,
                    "duplicate": r.duplicate_entity_id,
                    "confidence": r.confidence,
                    "status": r.status,
                    "reason": r.reason,
                }
                for r in rows
            ]
        finally:
            await engine.dispose()

    rows = _dispatch(_run())
    human = "\n".join(f"{r['id']}: {r['status']} ({r['confidence']}) {r['reason']}" for r in rows)
    emit_result(ctx, json_output, {"proposals": rows}, human or "no proposals")


def _resolve_and_act(project: str, proposal_id: str, action: str) -> tuple[str, str]:
    async def _run() -> tuple[str, str]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            service = _build_service(sessionmaker)
            scope = _cli_scope(project_id)
            if action == "confirm":
                outcome = await service.confirm(scope, proposal_id)
            elif action == "reverse":
                outcome = await service.reverse(scope, proposal_id)
            else:
                outcome = await service.reject(scope, proposal_id)
            return outcome.status, outcome.explanation
        finally:
            await engine.dispose()

    return _dispatch(_run())


@merges_app.command("confirm")
def merges_confirm(
    ctx: typer.Context,
    proposal_id: str = typer.Argument(..., help="Merge proposal id."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Confirm a proposal: merge the duplicate into the canonical entity (audited)."""
    status, explanation = _resolve_and_act(project, proposal_id, "confirm")
    emit_result(
        ctx, json_output, {"status": status, "explanation": explanation}, f"{status}: {explanation}"
    )
    # `refused` is the service declining the request (already resolved, absent); it used to be reported
    # as `rejected`, which is a different thing and is why this exit code had to be widened (T022).
    if status in {"rejected", "refused"}:
        raise typer.Exit(code=1)


@merges_app.command("reject")
def merges_reject(
    ctx: typer.Context,
    proposal_id: str = typer.Argument(..., help="Merge proposal id."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Reject a proposal: no merge; the proposal is closed (audited)."""
    status, explanation = _resolve_and_act(project, proposal_id, "reject")
    emit_result(
        ctx, json_output, {"status": status, "explanation": explanation}, f"{status}: {explanation}"
    )
    # A refusal is not a rejection: the proposal was already resolved, so the operator's request did not
    # take effect and must not exit 0.
    if status == "refused":
        raise typer.Exit(code=1)


@merges_app.command("reverse")
def merges_reverse(
    ctx: typer.Context,
    proposal_id: str = typer.Argument(..., help="Applied merge proposal id."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Reverse an applied merge from its drift-checked snapshot (audited)."""
    status, explanation = _resolve_and_act(project, proposal_id, "reverse")
    emit_result(
        ctx,
        json_output,
        {"status": status, "explanation": explanation},
        f"{status}: {explanation}",
    )
    if status == "refused":
        raise typer.Exit(code=1)
