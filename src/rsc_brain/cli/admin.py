"""Admin CLI (SPEC-04): projects · users · topics · audit · doctor.

Thin wrappers over :class:`IdentityService`, the audit query, and the doctor secret scan.
Newly minted tokens are printed exactly once. No command accepts a project as a knowledge scope
from the client — project management here is explicit administration, distinct from the
token-derived scope that gates recall (FR-12.3).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

import typer

from rsc_brain import audit as audit_mod
from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.identity.service import IdentityService
from rsc_brain.installer import doctor as doctor_mod
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker


def _run[T](fn: Callable[[IdentityService], Awaitable[T]]) -> T:
    async def _inner() -> T:
        engine = make_engine()
        sessionmaker = make_sessionmaker(engine)
        try:
            return await fn(IdentityService(sessionmaker))
        finally:
            await engine.dispose()

    return asyncio.run(_inner())


# --- projects ---------------------------------------------------------------

projects_app = typer.Typer(help="Manage projects.", no_args_is_help=True)


@projects_app.command("create")
def projects_create(
    ctx: typer.Context,
    slug: str = typer.Argument(..., help="Unique project slug."),
    name: str = typer.Option(..., "--name", help="Human-readable name."),
    json_output: bool = JSON_OPTION,
) -> None:
    project_id = _run(lambda s: s.create_project(slug, name))
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "project_id": project_id, "slug": slug},
        f"created {slug}",
    )


@projects_app.command("list")
def projects_list(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    slugs = _run(lambda s: s.list_projects())
    emit_result(ctx, json_output, {"projects": slugs}, "\n".join(slugs))


@projects_app.command("delete")
def projects_delete(
    ctx: typer.Context,
    slug: str = typer.Argument(..., help="Project slug to delete."),
    yes: bool = typer.Option(False, "--yes", help="Confirm irreversible deletion."),
    json_output: bool = JSON_OPTION,
) -> None:
    if not yes:
        typer.echo("Refusing to delete without --yes.", err=True)
        raise typer.Exit(code=2)
    _run(lambda s: s.delete_project(slug))
    emit_result(ctx, json_output, {"status": "ok", "deleted": slug}, f"deleted {slug}")


# --- users ------------------------------------------------------------------

users_app = typer.Typer(help="Manage users and invitations.", no_args_is_help=True)


@users_app.command("invite")
def users_invite(
    ctx: typer.Context,
    email: str = typer.Argument(..., help="Email to invite."),
    role: str = typer.Option("member", "--role", help="owner|admin|member."),
    json_output: bool = JSON_OPTION,
) -> None:
    issued = _run(lambda s: s.invite_user(email, role=role))
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "user_id": issued.id, "invitation_token": issued.token},
        f"invited {email}\ninvitation token (shown once): {issued.token}",
    )


@users_app.command("accept")
def users_accept(
    ctx: typer.Context,
    token: str = typer.Argument(..., help="Invitation token."),
    password: str = typer.Option(
        ..., "--password", help="New password.", prompt=True, hide_input=True
    ),
    json_output: bool = JSON_OPTION,
) -> None:
    user_id = _run(lambda s: s.accept_invitation(token, password))
    emit_result(ctx, json_output, {"status": "ok", "user_id": user_id}, "invitation accepted")


@users_app.command("deactivate")
def users_deactivate(
    ctx: typer.Context,
    user_id: str = typer.Argument(..., help="User id to deactivate."),
    json_output: bool = JSON_OPTION,
) -> None:
    _run(lambda s: s.deactivate_user(user_id))
    emit_result(
        ctx, json_output, {"status": "ok", "deactivated": user_id}, f"deactivated {user_id}"
    )


# --- topics -----------------------------------------------------------------

topics_app = typer.Typer(help="Manage a project's topics.", no_args_is_help=True)


@topics_app.command("create")
def topics_create(
    ctx: typer.Context,
    project_id: str = typer.Option(..., "--project-id", help="Owning project id."),
    slug: str = typer.Argument(..., help="Topic slug."),
    name: str = typer.Option(..., "--name", help="Topic name."),
    sensitivity: int = typer.Option(0, "--sensitivity", help="0..n; >=3 is restrictive."),
    json_output: bool = JSON_OPTION,
) -> None:
    topic_id = _run(lambda s: s.create_topic(project_id, slug, name, sensitivity=sensitivity))
    emit_result(ctx, json_output, {"status": "ok", "topic_id": topic_id}, f"created topic {slug}")


# --- audit + doctor (single commands) ---------------------------------------


def audit(
    ctx: typer.Context,
    project_id: str = typer.Option(..., "--project-id", help="Project to audit."),
    action: str | None = typer.Option(None, "--action", help="Filter by action."),
    limit: int = typer.Option(100, "--limit"),
    export: Path | None = typer.Option(None, "--export", help="Write CSV to this path."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Show the audit log for a project (`--json`) or export it to CSV (`--export`)."""

    async def _query() -> list[dict[str, object]]:
        engine = make_engine()
        sessionmaker = make_sessionmaker(engine)
        try:
            return await audit_mod.query_audit(sessionmaker, project_id, action=action, limit=limit)
        finally:
            await engine.dispose()

    rows = asyncio.run(_query())
    if export is not None:
        export.write_text(audit_mod.to_csv(rows), encoding="utf-8")
    emit_result(
        ctx,
        json_output,
        {"count": len(rows), "rows": rows, "exported": str(export) if export else None},
        f"{len(rows)} audit rows" + (f" exported to {export}" if export else ""),
    )


def doctor(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Scan config files for hardcoded secrets (FR-4.7). Exits non-zero if any are found."""
    candidates = [Path("config.yaml"), Path("config.example.yaml")]
    findings = doctor_mod.scan_paths(candidates)
    payload = {
        "status": "ok" if not findings else "secrets_found",
        "findings": [{"path": f.path, "line": f.line, "reason": f.reason} for f in findings],
    }
    human = (
        "doctor: no hardcoded secrets in config."
        if not findings
        else "doctor: hardcoded secrets found:\n"
        + "\n".join(f"  {f.path}:{f.line} — {f.reason}" for f in findings)
    )
    emit_result(ctx, json_output, payload, human)
    if findings:
        raise typer.Exit(code=1)
