"""The hunting CLI groups are wired into ``brain`` (SPEC-15, FR-6.1/6.2/6.6).

No DB here — the DB behaviour lives in the hunting integration suite. This locks the Typer wiring:
``persons``/``gaps``/``hunts`` are real groups (no longer FR-10.1 stubs), ``hunt ask`` exists, and
``gaps list`` carries the ``--agents`` flag. Assertions introspect the Click command tree rather
than the rendered ``--help`` text, so they don't depend on the terminal width.
"""

from __future__ import annotations

import click
import pytest
import typer

from rsc_brain.cli.main import app

_ROOT = typer.main.get_command(app)


def _group(name: str) -> click.Group:
    group = _ROOT.commands[name]  # type: ignore[attr-defined]
    assert isinstance(group, click.Group)
    return group


@pytest.mark.parametrize(
    ("group", "expected"),
    [
        ("persons", {"add", "list", "update", "remove"}),
        ("hunts", {"list", "show"}),
        ("gaps", {"list", "promote"}),
        ("hunt", {"ask"}),
    ],
)
def test_group_exposes_its_subcommands(group: str, expected: set[str]) -> None:
    assert expected <= set(_group(group).commands)


def test_gaps_list_has_the_agents_flag() -> None:
    list_cmd = _group("gaps").commands["list"]
    opts = {opt for param in list_cmd.params for opt in param.opts}
    assert "--agents" in opts


def test_stub_commands_are_still_stubs() -> None:
    # Sanity: a not-yet-implemented FR-10.1 command is a plain command, not a group.
    assert not isinstance(_ROOT.commands["plan"], click.Group)  # type: ignore[attr-defined]
