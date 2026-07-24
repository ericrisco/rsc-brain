"""The ``brain`` CLI (Typer, FR-10.1).

Every FR-10.1 subcommand is declared with a global ``--json`` flag. Subcommands implemented in
this SPEC are registered from their modules; the rest remain declared stubs that exit non-zero
with a structured payload, so docs/tests distinguish "declared but not implemented" from "works".
"""

from __future__ import annotations

from collections.abc import Callable

import typer

from rsc_brain import __version__
from rsc_brain.cli._common import JSON_OPTION, State, emit_not_implemented, json_enabled
from rsc_brain.cli.data import backup as _backup
from rsc_brain.cli.data import forget as _forget
from rsc_brain.cli.data import migrate as _migrate
from rsc_brain.cli.data import restore as _restore

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

# Subcommands with real behaviour registered from their own modules (skip the stub for these).
_IMPLEMENTED: dict[str, tuple[Callable[..., None], str]] = {
    "migrate": (_migrate, "Apply pending database migrations to head (idempotent)."),
    "backup": (_backup, "Back up the database to a single dump artifact."),
    "restore": (_restore, "Restore a dump, apply migrations, and verify."),
    "forget": (_forget, "Hard-delete a document and tombstone its graph nodes."),
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
    if _name in _IMPLEMENTED:
        _fn, _help = _IMPLEMENTED[_name]
        app.command(_name, help=_help)(_fn)
    else:
        app.command(_name, help=f"[{_name}] — not implemented in this SPEC; see the owning SPEC.")(
            _make_stub(_name)
        )


if __name__ == "__main__":  # pragma: no cover
    app()
