"""The ``brain`` CLI (Typer) — skeleton (SPEC-01, FR-10.1).

Every FR-10.1 subcommand is declared with a global ``--json`` flag. Unimplemented
subcommands exit non-zero with a structured payload, so documentation and tests can
distinguish "declared but not implemented" from "works". Each subcommand's real behaviour
lands in its owning SPEC (doctor/verify → SPEC-06, migrate/ingest → SPEC-03/05, …).
"""

from __future__ import annotations

import json
from collections.abc import Callable

import typer

from rsc_brain import __version__

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

JSON_OPTION = typer.Option(False, "--json", help="Emit machine-readable JSON output.")

app = typer.Typer(
    name="brain",
    help="rsc-brain — self-hosted company memory over MCP.",
    add_completion=False,
)


class _State:
    """Holds the group-level ``--json`` flag so it is available on every subcommand."""

    __slots__ = ("json_output",)

    def __init__(self, json_output: bool = False) -> None:
        self.json_output = json_output


@app.callback(invoke_without_command=True)
def _main(
    ctx: typer.Context,
    json_output: bool = JSON_OPTION,
    version: bool = typer.Option(False, "--version", help="Show version and exit."),
) -> None:
    if version:
        typer.echo(__version__)
        raise typer.Exit(code=0)
    ctx.obj = _State(json_output=json_output)
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())
        raise typer.Exit(code=0)


def _emit_not_implemented(command: str, json_output: bool) -> None:
    """Report a declared-but-unimplemented command and exit non-zero."""
    if json_output:
        typer.echo(json.dumps({"status": "not_implemented", "command": command}))
    else:
        typer.echo(f"brain {command}: not implemented yet", err=True)
    raise typer.Exit(code=2)


def _make_stub(name: str) -> Callable[..., None]:
    def _cmd(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
        group_json = getattr(ctx.obj, "json_output", False)
        _emit_not_implemented(name, group_json or json_output)

    _cmd.__name__ = f"cmd_{name}"
    return _cmd


for _name in COMMANDS:
    app.command(_name, help=f"[{_name}] — not implemented in this SPEC; see the owning SPEC.")(
        _make_stub(_name)
    )


if __name__ == "__main__":  # pragma: no cover
    app()
