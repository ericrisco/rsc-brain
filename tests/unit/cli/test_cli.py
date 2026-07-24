"""Tests for the brain CLI skeleton (SPEC-01 AC-6)."""

from __future__ import annotations

import json

from typer.testing import CliRunner

from rsc_brain import __version__
from rsc_brain.cli.main import COMMANDS, app

runner = CliRunner()


def test_help_lists_all_22_subcommands() -> None:
    assert len(COMMANDS) == 22
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in COMMANDS:
        assert command in result.stdout


def test_version_flag() -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout


def test_unimplemented_command_exits_nonzero_with_json_after_subcommand() -> None:
    # `up` is still a declared FR-10.1 stub (implemented by a later SPEC); `skills`/`plan`/`apply`
    # are now real.
    result = runner.invoke(app, ["up", "--json"])
    assert result.exit_code == 2
    payload = json.loads(result.stdout)
    assert payload == {"status": "not_implemented", "command": "up"}


def test_global_json_before_subcommand_also_works() -> None:
    # `down` is still a declared stub (start/stop the stack land with a later SPEC).
    result = runner.invoke(app, ["--json", "down"])
    assert result.exit_code == 2
    payload = json.loads(result.stdout)
    assert payload == {"status": "not_implemented", "command": "down"}


def test_unimplemented_command_human_message_goes_to_stderr() -> None:
    result = runner.invoke(app, ["down"])
    assert result.exit_code == 2
    assert "not implemented" in result.output
