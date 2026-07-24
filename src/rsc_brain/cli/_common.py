"""Shared CLI helpers: the global --json flag, state, and output emitters."""

from __future__ import annotations

import json
from typing import Any

import typer

JSON_OPTION = typer.Option(False, "--json", help="Emit machine-readable JSON output.")


class State:
    """Holds the group-level ``--json`` flag so it is available on every subcommand."""

    __slots__ = ("json_output",)

    def __init__(self, json_output: bool = False) -> None:
        self.json_output = json_output


def json_enabled(ctx: typer.Context, local: bool) -> bool:
    return bool(getattr(ctx.obj, "json_output", False)) or local


def emit_not_implemented(command: str, json_output: bool) -> None:
    """Report a declared-but-unimplemented command and exit non-zero."""
    if json_output:
        typer.echo(json.dumps({"status": "not_implemented", "command": command}))
    else:
        typer.echo(f"brain {command}: not implemented yet", err=True)
    raise typer.Exit(code=2)


def emit_result(ctx: typer.Context, local_json: bool, payload: dict[str, Any], human: str) -> None:
    """Emit a success result as JSON (if requested) or a human-readable line."""
    if json_enabled(ctx, local_json):
        typer.echo(json.dumps(payload))
    else:
        typer.echo(human)
