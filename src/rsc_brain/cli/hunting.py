"""Hunting CLI (SPEC-15, FR-6.1/6.2/6.6): ``brain persons`` · ``brain hunt ask`` · ``brain hunts``
· ``brain gaps``.

The person directory, manual hunt creation, and the read views for hunts and gaps, all scoped to
an explicit ``--project`` slug (resolved to an id server-side, never trusted as a knowledge scope,
FR-12.3). Agent gaps live only under ``gaps list --agents`` (FR-14.6); human-driven gaps are the
default view and the only ones eligible for the automatic trigger.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import typer

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.cli.ingest import _cli_scope, _dispatch, _resolve_project_id
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntService
from rsc_brain.recall.gaps import list_gaps
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

persons_app = typer.Typer(
    help="Manage the hunting person directory (FR-6.1).", no_args_is_help=True
)
hunt_app = typer.Typer(help="Ask a person a question by hand (FR-6.2c).", no_args_is_help=True)
hunts_app = typer.Typer(help="Inspect hunts (FR-6.6).", no_args_is_help=True)
gaps_app = typer.Typer(
    help="Inspect and promote knowledge gaps (FR-6.6/14.6).", no_args_is_help=True
)

_PROJECT = typer.Option(..., "--project", help="Project slug.")


def _with_scope[T](slug: str, fn: Callable[[object, ProjectScope], Awaitable[T]]) -> T:
    async def _inner() -> T:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, slug)
            return await fn(sessionmaker, _cli_scope(project_id))
        finally:
            await engine.dispose()

    return _dispatch(_inner())


def _topics(raw: str | None) -> list[str]:
    return [t.strip() for t in (raw or "").split(",") if t.strip()]


# --- brain persons ----------------------------------------------------------


@persons_app.command("add")
def persons_add(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Person's display name."),
    project: str = _PROJECT,
    topics: str = typer.Option("", "--topics", help="Comma-separated topic slugs they own."),
    email: str | None = typer.Option(None, "--email", help="Email channel address."),
    slack: str | None = typer.Option(None, "--slack", help="Slack channel id / handle."),
    quiet_start: str | None = typer.Option(
        None, "--quiet-start", help="Quiet-hours start HH:MM UTC."
    ),
    quiet_end: str | None = typer.Option(None, "--quiet-end", help="Quiet-hours end HH:MM UTC."),
    language: str | None = typer.Option(None, "--language", help="Preferred message language."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Add a person to a project's directory."""
    channels: dict[str, object] = {}
    if email:
        channels["email"] = email
    if slack:
        channels["slack"] = slack
    quiet_hours = {"start": quiet_start, "end": quiet_end} if quiet_start and quiet_end else None

    async def _run(sm: object, scope: ProjectScope) -> str:
        return await PersonDirectory(sm).add(  # type: ignore[arg-type]
            scope,
            name=name,
            channels=channels,
            topics=_topics(topics),
            quiet_hours=quiet_hours,
            language=language,
        )

    person_id = _with_scope(project, _run)
    emit_result(
        ctx, json_output, {"person_id": person_id, "name": name}, f"added {name} ({person_id})"
    )


@persons_app.command("list")
def persons_list(
    ctx: typer.Context, project: str = _PROJECT, json_output: bool = JSON_OPTION
) -> None:
    """List a project's people."""

    async def _run(sm: object, scope: ProjectScope) -> list[dict[str, object]]:
        rows = await PersonDirectory(sm).list(scope)  # type: ignore[arg-type]
        return [
            {
                "id": p.id,
                "name": p.name,
                "topics": list(p.topics),
                "channels": p.channels,
                "quiet_hours": p.quiet_hours,
                "language": p.language,
            }
            for p in rows
        ]

    people = _with_scope(project, _run)
    human = "\n".join(f"{p['id']}: {p['name']} {p['topics']}" for p in people)
    emit_result(ctx, json_output, {"persons": people}, human or "no persons")


@persons_app.command("update")
def persons_update(
    ctx: typer.Context,
    person_id: str = typer.Argument(..., help="Person id."),
    project: str = _PROJECT,
    topics: str | None = typer.Option(None, "--topics", help="Replace topics (comma-separated)."),
    email: str | None = typer.Option(None, "--email", help="Replace email channel."),
    slack: str | None = typer.Option(None, "--slack", help="Replace Slack channel."),
    quiet_start: str | None = typer.Option(None, "--quiet-start", help="Quiet-hours start HH:MM."),
    quiet_end: str | None = typer.Option(None, "--quiet-end", help="Quiet-hours end HH:MM."),
    language: str | None = typer.Option(None, "--language", help="Preferred message language."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Update a person's topics, channels, quiet hours, or language."""
    channels: dict[str, object] | None = None
    if email or slack:
        channels = {}
        if email:
            channels["email"] = email
        if slack:
            channels["slack"] = slack
    quiet_hours = {"start": quiet_start, "end": quiet_end} if quiet_start and quiet_end else None

    async def _run(sm: object, scope: ProjectScope) -> None:
        await PersonDirectory(sm).update(  # type: ignore[arg-type]
            scope,
            person_id,
            topics=_topics(topics) if topics is not None else None,
            channels=channels,
            quiet_hours=quiet_hours,
            language=language,
        )

    _with_scope(project, _run)
    emit_result(ctx, json_output, {"person_id": person_id, "updated": True}, f"updated {person_id}")


@persons_app.command("remove")
def persons_remove(
    ctx: typer.Context,
    person_id: str = typer.Argument(..., help="Person id."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Remove a person from the directory."""

    async def _run(sm: object, scope: ProjectScope) -> None:
        await PersonDirectory(sm).remove(scope, person_id)  # type: ignore[arg-type]

    _with_scope(project, _run)
    emit_result(ctx, json_output, {"person_id": person_id, "removed": True}, f"removed {person_id}")


# --- brain hunt ask ---------------------------------------------------------


@hunt_app.command("ask")
def hunt_ask(
    ctx: typer.Context,
    question: str = typer.Argument(..., help="The question to route to a responsible person."),
    project: str = _PROJECT,
    topics: str = typer.Option("", "--topics", help="Comma-separated topics for routing."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Open a MANUAL hunt (FR-6.2c) — routed by topic overlap, respecting quiet hours + anti-spam."""

    async def _run(sm: object, scope: ProjectScope) -> dict[str, object]:
        outcome = await HuntService(sm).create_manual(  # type: ignore[arg-type]
            scope, question=question, topics=_topics(topics)
        )
        return {
            "hunt_id": outcome.hunt_id,
            "state": str(outcome.state),
            "person_id": outcome.person_id,
            "throttled": outcome.throttled,
        }

    result = _with_scope(project, _run)
    emit_result(ctx, json_output, result, f"{result['state']} ({result['hunt_id']})")


# --- brain hunts ------------------------------------------------------------


@hunts_app.command("list")
def hunts_list(
    ctx: typer.Context,
    project: str = _PROJECT,
    open_only: bool = typer.Option(False, "--open", help="Only hunts still awaiting resolution."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List a project's hunts (newest first)."""

    async def _run(sm: object, scope: ProjectScope) -> list[dict[str, object]]:
        return await HuntService(sm).list_hunts(scope, open_only=open_only)  # type: ignore[arg-type]

    hunts = _with_scope(project, _run)
    human = "\n".join(f"{h['id']}: {h['type']} {h['state']} — {h['question']}" for h in hunts)
    emit_result(ctx, json_output, {"hunts": hunts}, human or "no hunts")


@hunts_app.command("show")
def hunts_show(
    ctx: typer.Context,
    hunt_id: str = typer.Argument(..., help="Hunt id."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Show one hunt's full lifecycle state."""

    async def _run(sm: object, scope: ProjectScope) -> dict[str, object] | None:
        return await HuntService(sm).get_hunt(scope, hunt_id)  # type: ignore[arg-type]

    hunt = _with_scope(project, _run)
    if hunt is None:
        emit_result(ctx, json_output, {"error": "not_found", "hunt_id": hunt_id}, "hunt not found")
        raise typer.Exit(code=1)
    emit_result(
        ctx, json_output, {"hunt": hunt}, f"{hunt['type']} {hunt['state']}: {hunt['question']}"
    )


# --- brain gaps -------------------------------------------------------------


@gaps_app.command("list")
def gaps_list(
    ctx: typer.Context,
    project: str = _PROJECT,
    agents: bool = typer.Option(
        False, "--agents", help="Show the separate agent-gap view (FR-14.6)."
    ),
    json_output: bool = JSON_OPTION,
) -> None:
    """List knowledge gaps. Human-driven by default; ``--agents`` for the agent-only view."""

    async def _run(sm: object, scope: ProjectScope) -> list[dict[str, object]]:
        return await list_gaps(sm, scope, audience="agent" if agents else "human")  # type: ignore[arg-type]

    gaps = _with_scope(project, _run)
    human = "\n".join(f"{g['id']}: [{g['count']}x] {g['query_text']}" for g in gaps)
    emit_result(
        ctx,
        json_output,
        {"gaps": gaps, "audience": "agent" if agents else "human"},
        human or "no gaps",
    )


@gaps_app.command("promote")
def gaps_promote(
    ctx: typer.Context,
    gap_id: str = typer.Argument(..., help="Gap id to promote to a hunt."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Promote an agent gap to a hunt by hand (FR-14.6 — agent gaps never trigger automatically)."""

    async def _run(sm: object, scope: ProjectScope) -> dict[str, object] | None:
        outcome = await HuntService(sm).promote_agent_gap(scope, gap_id)  # type: ignore[arg-type]
        if outcome is None:
            return None
        return {"hunt_id": outcome.hunt_id, "state": str(outcome.state)}

    result = _with_scope(project, _run)
    if result is None:
        emit_result(ctx, json_output, {"error": "not_found", "gap_id": gap_id}, "gap not found")
        raise typer.Exit(code=1)
    emit_result(ctx, json_output, result, f"{result['state']} ({result['hunt_id']})")
