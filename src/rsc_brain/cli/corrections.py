"""`brain corrections` CLI (SPEC-08, FR-15.8): list + revert Learning-Layer corrections."""

from __future__ import annotations

import typer

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.cli.ingest import _cli_scope, _dispatch, _resolve_project_id
from rsc_brain.config import load_settings
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.knowledge.corrections import CorrectionService
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

corrections_app = typer.Typer(
    help="List and revert Learning-Layer corrections.", no_args_is_help=True
)


@corrections_app.command("list")
def corrections_list(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List a project's corrections (newest first)."""

    async def _run() -> list[dict[str, object]]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            return await KnowledgeStore(sessionmaker).list_corrections(_cli_scope(project_id))
        finally:
            await engine.dispose()

    rows = _dispatch(_run())
    human = "\n".join(f"{r['id']}: {r['status']} ({r['role_applied']})" for r in rows)
    emit_result(ctx, json_output, {"corrections": rows}, human or "no corrections")


@corrections_app.command("revert")
def corrections_revert(
    ctx: typer.Context,
    correction_id: str = typer.Argument(..., help="Correction id to revert."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Revert a correction, restoring the previous claim (audited as a new entry)."""

    async def _run() -> tuple[str, str]:
        settings = load_settings()
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            service = CorrectionService(
                store=KnowledgeStore(sessionmaker),
                graph=AgeGraphStore(sessionmaker),
                gateway=ModelGateway(settings.capabilities),
            )
            outcome = await service.revert(_cli_scope(project_id), correction_id)
        finally:
            await engine.dispose()
        return outcome.status, outcome.explanation

    status, explanation = _dispatch(_run())
    emit_result(
        ctx, json_output, {"status": status, "explanation": explanation}, f"{status}: {explanation}"
    )
    if status == "rejected":
        raise typer.Exit(code=1)
