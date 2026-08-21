"""`brain skills` CLI (SPEC-20, FR-7.1/10.1): create/list/show/edit/archive skills.

A skill is a markdown file with an OKF-compatible frontmatter (see ``skills.frontmatter``). Scoped
to an explicit ``--project`` (resolved server-side, never trusted as a knowledge scope, FR-12.3).
``create``/``edit`` validate the frontmatter and that ``owner`` exists in the person directory.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import typer

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.cli.ingest import _cli_scope, _dispatch, _resolve_project_id
from rsc_brain.scope import ProjectScope
from rsc_brain.skills.frontmatter import SkillFrontmatterError, parse_skill, serialize_skill
from rsc_brain.skills.store import (
    SkillNotFound,
    SkillOwnerNotFound,
    SkillStore,
    SkillVersionConflict,
)
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

skills_app = typer.Typer(help="Manage skills (reusable procedures, FR-7.1).", no_args_is_help=True)

_PROJECT = typer.Option(..., "--project", help="Project slug.")


def _with[T](slug: str, fn: Callable[[object, ProjectScope], Awaitable[T]]) -> T:
    async def _inner() -> T:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, slug)
            return await fn(sessionmaker, _cli_scope(project_id))
        finally:
            await engine.dispose()

    return _dispatch(_inner())


@skills_app.command("create")
def skills_create(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="Markdown skill file (frontmatter + body)."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Create a skill from a markdown file."""
    try:
        frontmatter, body = parse_skill(file.read_text(encoding="utf-8"))
    except (SkillFrontmatterError, OSError) as exc:
        typer.echo(f"invalid skill file: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    if frontmatter.state != "proposed" or frontmatter.version < 1:
        raise typer.BadParameter("skills must begin proposed with a positive version")

    async def _run(sm: object, scope: ProjectScope) -> str:
        try:
            return await SkillStore(sm).create(scope, frontmatter, body)  # type: ignore[arg-type]
        except SkillOwnerNotFound as exc:
            raise typer.BadParameter("owner not found") from exc

    skill_id = _with(project, _run)
    emit_result(
        ctx,
        json_output,
        {"skill_id": skill_id, "slug": frontmatter.slug},
        f"created {frontmatter.slug}",
    )


@skills_app.command("list")
def skills_list(
    ctx: typer.Context,
    project: str = _PROJECT,
    state: str | None = typer.Option(None, "--state", help="Filter by state."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List a project's skills."""

    async def _run(sm: object, scope: ProjectScope) -> list[dict[str, object]]:
        rows = await SkillStore(sm).list_all(scope, state=state)  # type: ignore[arg-type]
        return [
            {
                "slug": s.slug,
                "title": s.title,
                "state": s.state,
                "stale": s.stale,
                "tags": list(s.tags),
                "description": s.description,
                "when_to_use": s.when_to_use,
                "when_not": s.when_not,
                "owner_person_id": s.owner_person_id,
                "depends_on": list(s.depends_on),
                "version": s.version,
            }
            for s in rows
        ]

    skills = _with(project, _run)
    human = "\n".join(f"{s['slug']}: {s['state']}{' STALE' if s['stale'] else ''}" for s in skills)
    emit_result(ctx, json_output, {"skills": skills}, human or "no skills")


@skills_app.command("show")
def skills_show(
    ctx: typer.Context,
    slug: str = typer.Argument(..., help="Skill slug."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Show a skill's full markdown (frontmatter + body)."""

    async def _run(sm: object, scope: ProjectScope) -> str | None:
        row = await SkillStore(sm).get(scope, slug)  # type: ignore[arg-type]
        return serialize_skill(row.frontmatter(), row.body or "") if row is not None else None

    text = _with(project, _run)
    if text is None:
        emit_result(ctx, json_output, {"error": "not_found", "slug": slug}, "skill not found")
        raise typer.Exit(code=1)
    emit_result(ctx, json_output, {"slug": slug, "markdown": text}, text)


@skills_app.command("edit")
def skills_edit(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="Updated markdown skill file."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Replace a skill from a markdown file (clears the stale flag; bumps version)."""
    try:
        frontmatter, body = parse_skill(file.read_text(encoding="utf-8"))
    except (SkillFrontmatterError, OSError) as exc:
        typer.echo(f"invalid skill file: {exc}", err=True)
        raise typer.Exit(code=2) from exc

    async def _run(sm: object, scope: ProjectScope) -> dict[str, object]:
        store = SkillStore(sm)  # type: ignore[arg-type]
        current = await store.get(scope, frontmatter.slug)
        if current is None:
            raise typer.BadParameter("skill not found")
        if frontmatter.state != current.state:
            raise typer.BadParameter("skill edit must preserve lifecycle state")
        try:
            updated = await store.update(scope, frontmatter.slug, frontmatter, body)
        except SkillOwnerNotFound as exc:
            raise typer.BadParameter("owner not found") from exc
        except SkillVersionConflict as exc:
            raise typer.BadParameter("version conflict") from exc
        return {
            "slug": updated.slug,
            "updated": True,
            "owner_person_id": updated.owner_person_id,
            "status": updated.state,
            "version": updated.version,
        }

    result = _with(project, _run)
    emit_result(ctx, json_output, result, f"updated {frontmatter.slug}")


@skills_app.command("archive")
def skills_archive(
    ctx: typer.Context,
    slug: str = typer.Argument(..., help="Skill slug."),
    project: str = _PROJECT,
    json_output: bool = JSON_OPTION,
) -> None:
    """Archive a skill (removed from MCP; not deleted)."""

    async def _run(sm: object, scope: ProjectScope) -> dict[str, object]:
        store = SkillStore(sm)  # type: ignore[arg-type]
        current = await store.get(scope, slug)
        if current is None:
            raise typer.BadParameter("skill not found")
        try:
            transition = await store.archive(
                scope,
                slug,
                expected_version=current.version,
                idempotency_key=str(uuid.uuid4()),
                authorize_topics=False,
            )
        except (SkillNotFound, SkillVersionConflict) as exc:
            raise typer.BadParameter("version conflict") from exc
        return {
            "slug": transition.skill.slug,
            "archived": True,
            "status": transition.skill.state,
            "version": transition.skill.version,
            "audit_correlation": transition.audit_correlation,
        }

    result = _with(project, _run)
    emit_result(ctx, json_output, result, f"archived {slug}")
