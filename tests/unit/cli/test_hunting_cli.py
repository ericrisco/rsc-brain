"""The hunting CLI groups are wired into ``brain`` (SPEC-15, FR-6.1/6.2/6.6).

No DB here — the DB behaviour lives in the hunting integration suite. This locks the Typer wiring:
``persons``/``gaps``/``hunts`` are real groups (no longer FR-10.1 stubs) and ``hunt ask`` exists.
"""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from rsc_brain.cli.main import app

runner = CliRunner()


@pytest.mark.parametrize(
    ("group", "expected"),
    [
        ("persons", ("add", "list", "update", "remove")),
        ("hunts", ("list", "show")),
        ("gaps", ("list", "promote")),
        ("hunt", ("ask",)),
    ],
)
def test_group_exposes_its_subcommands(group: str, expected: tuple[str, ...]) -> None:
    result = runner.invoke(app, [group, "--help"])
    assert result.exit_code == 0, result.output
    for sub in expected:
        assert sub in result.output


def test_persons_and_hunts_are_no_longer_stubs() -> None:
    # A stub prints a not_implemented payload; a real group prints its own help / subcommands.
    for group in ("persons", "gaps", "hunts"):
        output = runner.invoke(app, [group]).output
        assert "not_implemented" not in output
        assert "not implemented" not in output


def test_gaps_list_has_the_agents_flag() -> None:
    result = runner.invoke(app, ["gaps", "list", "--help"])
    assert result.exit_code == 0
    assert "--agents" in result.output
