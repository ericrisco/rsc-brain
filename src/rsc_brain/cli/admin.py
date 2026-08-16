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
from rsc_brain.scope import PROJECT_ROLE_ADMIN, PROJECT_ROLE_MEMBER, PROJECT_ROLE_VIEWER
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

# SPEC-04 §3.1's project roles. Validated in the CLI so an unknown role is refused where a human can
# read the refusal, instead of persisting as a role nothing in the product understands.
_PROJECT_ROLES = (PROJECT_ROLE_ADMIN, PROJECT_ROLE_MEMBER, PROJECT_ROLE_VIEWER)


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


# AUDIT-074: `add_membership` had one caller — the bootstrap of the first owner. So `brain users
# invite` + `accept` produced a user who belonged to no project, saw nothing, and could not be given
# anything, with SQL the only way out. SPEC-04 §3.1 specifies the membership (user, project, role,
# `allowed_topics[]`, `can_curate`) in `api/` + `cli/`; these three commands are the CLI half.


@users_app.command("add-membership")
def users_add_membership(
    ctx: typer.Context,
    user_id: str = typer.Argument(..., help="User to attach."),
    project_id: str = typer.Option(..., "--project-id", help="Project to attach them to."),
    role: str = typer.Option(
        PROJECT_ROLE_MEMBER, "--role", help="project-admin | member | viewer."
    ),
    can_curate: bool = typer.Option(
        False, "--can-curate", help="May resolve contradictions and merge proposals."
    ),
    json_output: bool = JSON_OPTION,
) -> None:
    """Attach a user to a project, with a role stated explicitly.

    No topics are granted here. Authority stays a separate, explicit act (`brain topics grant`),
    because empty authority is never all topics (AUDIT-020, R01) and a membership that silently
    carried access would be exactly that inference.
    """
    if role not in _PROJECT_ROLES:
        typer.echo(f"unknown role {role!r}; expected one of {', '.join(_PROJECT_ROLES)}", err=True)
        raise typer.Exit(code=2)
    existing = _run(lambda s: s.membership_topics(user_id, project_id))
    if existing is not None:
        typer.echo(
            f"user {user_id} is already a member of project {project_id} "
            "(a membership is unique per user and project). Use `brain topics grant` to change "
            "authority, or `brain users remove-membership` first.",
            err=True,
        )
        raise typer.Exit(code=2)
    membership_id = _run(
        lambda s: s.add_membership(user_id, project_id, role=role, can_curate=can_curate)
    )
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "membership_id": membership_id, "role": role, "allowed_topics": []},
        f"added {user_id} to {project_id} as {role}; authority is empty until a topic is granted",
    )


@users_app.command("remove-membership")
def users_remove_membership(
    ctx: typer.Context,
    user_id: str = typer.Argument(..., help="User to detach."),
    project_id: str = typer.Option(..., "--project-id", help="Project to detach them from."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Detach a user from a project, revoking the credentials issued under that membership.

    The PAT foreign key cascades, so tokens minted for this membership stop resolving with the
    membership itself rather than in a second step someone can forget.
    """
    removed = _run(lambda s: s.remove_membership(user_id, project_id))
    if not removed:
        typer.echo(f"no membership for user {user_id} in project {project_id}", err=True)
        raise typer.Exit(code=2)
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "removed": user_id},
        f"removed {user_id} from {project_id}; its access tokens no longer resolve",
    )


@users_app.command("memberships")
def users_memberships(
    ctx: typer.Context,
    project_id: str = typer.Option(..., "--project-id", help="Project to report on."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Report who belongs to a project, with the role and topic authority each holds."""
    rows = _run(lambda s: s.list_memberships(project_id))
    human = "\n".join(
        f"  {r['email']}  {r['role']}  topics={', '.join(r['allowed_topics']) or '(none)'}"  # type: ignore[arg-type]
        f"  curate={r['can_curate']}  id={r['user_id']}"
        for r in rows
    )
    emit_result(ctx, json_output, {"memberships": rows}, human or "  (no members)")


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


# AUDIT-073: creating a topic granted it to its creator and that was the whole story — no surface
# granted or revoked a topic for anyone else, so past the first user a company could not give its
# departments the topic-based access this product exists to provide. SPEC-04 §3.1 specifies the
# membership's `allowed_topics[]` in `api/` + `cli/`; these are that half of it.
#
# AUDIT-074: and the grant's own precondition was unreachable. `add_membership` had exactly one
# caller — the bootstrap of the first owner — so an invited user who set their password belonged to
# no project. The commands under `brain users` below are the missing half; without them the grant
# above is a surface over a state nobody can create.


def _resolve_membership(project_id: str, user_id: str) -> tuple[str, ...]:
    """Refuse loudly when the membership does not exist, instead of reporting an empty success."""
    current = _run(lambda s: s.membership_topics(user_id, project_id))
    if current is None:
        typer.echo(
            f"no membership for user {user_id} in project {project_id}. A grant is recorded on a "
            "membership, so the user must be a member of the project first.",
            err=True,
        )
        raise typer.Exit(code=2)
    return current


@topics_app.command("list")
def topics_list(
    ctx: typer.Context,
    project_id: str = typer.Option(..., "--project-id", help="Project whose taxonomy to report."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Report a project's topics with their sensitivity (AUDIT-075).

    The set a grant may draw from. A topic at sensitivity 3 or above is restrictive, so the number is
    shown rather than left for the operator to remember.
    """
    topics = _run(lambda s: s.list_topics(project_id))
    human = "\n".join(
        f"  {t['slug']:<16} sensitivity={t['sensitivity']}"
        f"{'  (restrictive)' if int(t['sensitivity']) >= 3 else ''}  {t['name']}"  # type: ignore[call-overload]
        for t in topics
    )
    emit_result(ctx, json_output, {"topics": topics}, human or "  (no topics)")


@topics_app.command("grant")
def topics_grant(
    ctx: typer.Context,
    slug: str = typer.Argument(..., help="Topic slug to grant."),
    project_id: str = typer.Option(..., "--project-id", help="Project the membership belongs to."),
    user_id: str = typer.Option(..., "--user-id", help="User whose authority is being extended."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Grant a topic to a principal's membership.

    Authority is never implied by a role (R01, AUDIT-020), so it is granted here explicitly and per
    topic. A slug that is not a topic of this project is refused (SPEC-04 §3.2).
    """
    _resolve_membership(project_id, user_id)
    try:
        granted = _run(lambda s: s.grant_topics(user_id, project_id, [slug]))
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "allowed_topics": list(granted)},
        f"granted {slug}; authority is now {', '.join(granted) or '(none)'}",
    )


@topics_app.command("revoke")
def topics_revoke(
    ctx: typer.Context,
    slug: str = typer.Argument(..., help="Topic slug to withdraw."),
    project_id: str = typer.Option(..., "--project-id", help="Project the membership belongs to."),
    user_id: str = typer.Option(..., "--user-id", help="User whose authority is being reduced."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Withdraw a topic from a principal's membership. Idempotent."""
    _resolve_membership(project_id, user_id)
    remaining = _run(lambda s: s.revoke_topics(user_id, project_id, [slug]))
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "allowed_topics": list(remaining)},
        f"revoked {slug}; authority is now {', '.join(remaining) or '(none)'}",
    )


@topics_app.command("grants")
def topics_grants(
    ctx: typer.Context,
    project_id: str = typer.Option(..., "--project-id", help="Project to report on."),
    user_id: str = typer.Option(..., "--user-id", help="User to report on."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Report a principal's current topic authority — what a grant or revoke would change."""
    current = _resolve_membership(project_id, user_id)
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "allowed_topics": list(current)},
        f"authority: {', '.join(current) or '(none)'}",
    )


# --- audit + doctor (single commands) ---------------------------------------


def audit(
    ctx: typer.Context,
    project_id: str = typer.Option(..., "--project-id", help="Project to audit."),
    action: str | None = typer.Option(None, "--action", help="Filter by action."),
    tool: str | None = typer.Option(None, "--tool", help="Filter by tool."),
    principal_type: str | None = typer.Option(
        None, "--principal-type", help="Filter by principal type (human|agent)."
    ),
    principal_id: str | None = typer.Option(None, "--principal-id", help="Filter by principal id."),
    denied: bool | None = typer.Option(
        None, "--denied/--not-denied", help="Filter by denied flag."
    ),
    since: str | None = typer.Option(None, "--since", help="Only entries at/after this date/time."),
    until: str | None = typer.Option(
        None, "--until", help="Only entries at/before this date/time."
    ),
    limit: int = typer.Option(100, "--limit"),
    export: Path | None = typer.Option(None, "--export", help="Write CSV to this path."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Show the audit log for a project (`--json`) or export it to CSV (`--export`), with filters
    (SPEC-26 FR-13.7 — parity with the console audit view)."""

    async def _query() -> list[dict[str, object]]:
        engine = make_engine()
        sessionmaker = make_sessionmaker(engine)
        try:
            return await audit_mod.query_audit_raw(
                sessionmaker,
                project_id,
                action=action,
                tool=tool,
                principal_type=principal_type,
                principal_id=principal_id,
                denied=denied,
                since=since,
                until=until,
                limit=limit,
            )
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
