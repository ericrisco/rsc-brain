"""The hunting CLI groups are wired into ``brain`` (SPEC-15, FR-6.1/6.2/6.6).

No DB here — the DB behaviour lives in the hunting integration suite. This locks the Typer wiring:
``persons``/``gaps``/``hunts`` are real groups (no longer FR-10.1 stubs), ``hunt ask`` exists, and
``gaps list`` carries the ``--agents`` flag. Assertions introspect the Click command tree rather
than the rendered ``--help`` text, so they don't depend on the terminal width.

They also don't depend on a *third party's class identity*. These assertions used to read
``isinstance(cmd, click.Group)``, which silently became false in typer 0.27: typer now vendors its
own click, so ``TyperGroup`` inherits ``typer._click.core.Command`` and is not an instance of the
``click.Group`` we import. Nothing about the CLI had changed — five tests went red over a base class
the product never touches (it imports no click at all). What these tests actually care about is
whether a command *holds subcommands*, so that is what they now assert.
"""

from __future__ import annotations

from typing import Any

import pytest
import typer

from rsc_brain.cli.main import app

_ROOT = typer.main.get_command(app)


def _subcommands(command: Any) -> dict[str, Any]:
    """The subcommand map of a group, or ``{}`` for a leaf command.

    Duck-typed on ``.commands`` rather than a class, because which click class typer wraps is
    typer's business and has changed under us before.
    """
    commands = getattr(command, "commands", None)
    return dict(commands) if isinstance(commands, dict) else {}


def _group(name: str) -> dict[str, Any]:
    subcommands = _subcommands(_ROOT.commands[name])  # type: ignore[attr-defined]
    assert subcommands, f"`brain {name}` holds no subcommands, so it is not a group"
    return subcommands


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
    assert expected <= set(_group(group))


def test_gaps_list_has_the_agents_flag() -> None:
    list_cmd = _group("gaps")["list"]
    opts = {opt for param in list_cmd.params for opt in param.opts}
    assert "--agents" in opts


def test_stub_commands_are_still_stubs() -> None:
    """Sanity: a not-yet-implemented FR-10.1 command is a plain command, not a group.

    This is what keeps ``_subcommands`` an honest discriminator — if a future click made every
    command carry a ``.commands`` dict, this assertion goes red instead of the group checks
    quietly passing on everything.
    """
    assert _subcommands(_ROOT.commands["plan"]) == {}  # type: ignore[attr-defined]
