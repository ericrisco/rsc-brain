"""The ``brain`` CLI (Typer, FR-10.1).

Every FR-10.1 subcommand is declared with a global ``--json`` flag. Subcommands implemented so
far are registered from their modules (as single commands or command groups); the rest remain
declared stubs that exit non-zero with a structured payload, so docs/tests distinguish
"declared but not implemented" from "works".
"""

from __future__ import annotations

from collections.abc import Callable

import typer

from rsc_brain import __version__
from rsc_brain.cli._common import JSON_OPTION, State, emit_not_implemented, json_enabled
from rsc_brain.cli.admin import audit as _audit
from rsc_brain.cli.admin import projects_app, topics_app, users_app
from rsc_brain.cli.corrections import corrections_app
from rsc_brain.cli.data import backup as _backup
from rsc_brain.cli.data import forget as _forget
from rsc_brain.cli.data import migrate as _migrate
from rsc_brain.cli.data import restore as _restore
from rsc_brain.cli.entities import entities_app
from rsc_brain.cli.hunting import gaps_app, hunt_app, hunts_app, persons_app
from rsc_brain.cli.ingest import docs_app, sources_app
from rsc_brain.cli.ingest import ingest as _ingest
from rsc_brain.cli.ingest import status as _status
from rsc_brain.cli.installer import apply as _apply
from rsc_brain.cli.installer import calibrate as _calibrate
from rsc_brain.cli.installer import doctor as _doctor
from rsc_brain.cli.installer import eval_command as _eval
from rsc_brain.cli.installer import init as _init
from rsc_brain.cli.installer import plan as _plan
from rsc_brain.cli.installer import usage as _usage
from rsc_brain.cli.installer import verify as _verify
from rsc_brain.cli.skills import skills_app

# FR-10.1 subcommands, in the order the spec lists them.
COMMANDS: tuple[str, ...] = (
    "init",
    "doctor",
    "plan",
    "apply",
    "verify",
    "up",
    "down",
    "migrate",
    "ingest",
    "status",
    "users",
    "topics",
    "persons",
    "gaps",
    "hunts",
    "skills",
    "audit",
    "forget",
    "backup",
    "restore",
    "calibrate",
    "usage",
)

# Single commands with real behaviour (skip the stub for these).
_IMPLEMENTED_COMMANDS: dict[str, tuple[Callable[..., None], str]] = {
    "init": (_init, "Bootstrap a deployment: migrate + create the first admin (idempotent)."),
    "migrate": (_migrate, "Apply pending database migrations to head (idempotent)."),
    "ingest": (_ingest, "Ingest PDFs/markdown into a project (dedup + D13 approval gate)."),
    "status": (_status, "Show per-document ingestion runs (phase, claims, errors)."),
    "backup": (_backup, "Back up the database to a single dump artifact."),
    "restore": (_restore, "Restore a dump, apply migrations, and verify."),
    "forget": (_forget, "Hard-delete a document and tombstone its graph nodes."),
    "audit": (_audit, "Show or export the audit log for a project."),
    "doctor": (_doctor, "Detect host + recommend profile + scan config for secrets."),
    "plan": (_plan, "Dry-run the install: the phase plan `apply` would execute (SPEC-16)."),
    "apply": (_apply, "Execute the install plan (idempotent, checkpointed, per-phase rollback)."),
    "verify": (_verify, "Smoke-test the running system (gateway + database)."),
    "calibrate": (_calibrate, "Report the calibration set + default τ."),
    "usage": (_usage, "Report per-capability token + call usage by day (FR-9.5)."),
}

# Command groups (sub-apps) with real behaviour.
_IMPLEMENTED_GROUPS: dict[str, tuple[typer.Typer, str]] = {
    "users": (users_app, "Manage users and invitations."),
    "topics": (topics_app, "Manage a project's topics."),
    "persons": (persons_app, "Manage the hunting person directory (FR-6.1)."),
    "gaps": (gaps_app, "List and promote knowledge gaps (FR-6.6/14.6)."),
    "hunts": (hunts_app, "Inspect hunts (FR-6.6)."),
    "skills": (skills_app, "Manage skills (reusable procedures, FR-7.1)."),
}

app = typer.Typer(
    name="brain",
    help="rsc-brain — self-hosted company memory over MCP.",
    add_completion=False,
)


@app.callback(invoke_without_command=True)
def _main(
    ctx: typer.Context,
    json_output: bool = JSON_OPTION,
    version: bool = typer.Option(False, "--version", help="Show version and exit."),
) -> None:
    if version:
        typer.echo(__version__)
        raise typer.Exit(code=0)
    ctx.obj = State(json_output=json_output)
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())
        raise typer.Exit(code=0)


def _make_stub(name: str) -> Callable[..., None]:
    def _cmd(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
        emit_not_implemented(name, json_enabled(ctx, json_output))

    _cmd.__name__ = f"cmd_{name}"
    return _cmd


for _name in COMMANDS:
    if _name in _IMPLEMENTED_COMMANDS:
        _fn, _help = _IMPLEMENTED_COMMANDS[_name]
        app.command(_name, help=_help)(_fn)
    elif _name in _IMPLEMENTED_GROUPS:
        _group, _group_help = _IMPLEMENTED_GROUPS[_name]
        app.add_typer(_group, name=_name, help=_group_help)
    else:
        app.command(_name, help=f"[{_name}] — not implemented in this SPEC; see the owning SPEC.")(
            _make_stub(_name)
        )

# `projects` is introduced by SPEC-04 (beyond the original FR-10.1 22).
app.add_typer(projects_app, name="projects", help="Manage projects.")
# `docs` (D13 approval) and `sources` are introduced by SPEC-05.
app.add_typer(docs_app, name="docs", help="Review, approve, and reject ingested documents.")
app.add_typer(sources_app, name="sources", help="Manage ingestion sources and their policy.")
# `corrections` (Learning Layer revert/list) is introduced by SPEC-08.
app.add_typer(corrections_app, name="corrections", help="List and revert corrections.")
# `entities` (alias-merge propose + review queue) is introduced by SPEC-09.
app.add_typer(entities_app, name="entities", help="Entity dedup and alias-merge review.")
# `hunt ask` (manual hunt) is introduced by SPEC-15 (the plural `hunts`/`gaps`/`persons` groups
# fill in FR-10.1 stubs above).
app.add_typer(hunt_app, name="hunt", help="Ask a responsible person a question by hand (FR-6.2c).")
# `eval` (golden-set evaluation) is introduced by SPEC-06 (beyond the original FR-10.1 list).
app.command("eval", help="Report the golden-set composition (full run needs an ingested corpus).")(
    _eval
)


if __name__ == "__main__":  # pragma: no cover
    app()
