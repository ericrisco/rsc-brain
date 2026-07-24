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
    # The spec's literal example: `brain doctor --json`.
    result = runner.invoke(app, ["doctor", "--json"])
    assert result.exit_code == 2
    payload = json.loads(result.stdout)
    assert payload == {"status": "not_implemented", "command": "doctor"}


def test_global_json_before_subcommand_also_works() -> None:
    result = runner.invoke(app, ["--json", "ingest"])
    assert result.exit_code == 2
    payload = json.loads(result.stdout)
    assert payload == {"status": "not_implemented", "command": "ingest"}


def test_unimplemented_command_human_message_goes_to_stderr() -> None:
    result = runner.invoke(app, ["ingest"])
    assert result.exit_code == 2
    assert "not implemented" in result.output
