"""AUDIT-075: a project's topics could be created from the CLI but never read back.

Found on the host immediately after AUDIT-073/074 landed, while setting up T010: `brain topics list`
does not exist. `brain topics` offered `create` (and, since AUDIT-073, `grant`/`revoke`/`grants`) and
no way to see what a project's taxonomy actually contains.

What makes it worth fixing rather than noting: AUDIT-073's own refusal message tells the operator

    not topics of this project: personnel. A grant may only name a topic of the membership's own
    project (SPEC-04 §3.2).

— and then gives them no way to find out which topics *are* of this project. A workflow that refuses
an input without exposing the valid set is not finished. Sensitivity matters too: granting a topic at
`sensitivity >= 3` is a different decision from granting one at 0, and nothing in the CLI showed
which was which.

SPEC-04 §3.2 specifies "CRUD de topics **por proyecto** (slug, nombre, `sensitivity`)" in `api/` +
`cli/ topics`. The API has the read; the CLI had only the create.
"""

from __future__ import annotations

from pathlib import Path

from rsc_brain.cli.main import app

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "src" / "rsc_brain" / "identity" / "service.py"


def _subcommands(command_path: list[str]) -> set[str]:
    import typer.main

    node = typer.main.get_command(app)
    for name in command_path:
        node = node.commands[name]  # type: ignore[attr-defined]
    return set(node.commands)  # type: ignore[attr-defined]


def _option_names(command_path: list[str]) -> set[str]:
    import typer.main

    node = typer.main.get_command(app)
    for name in command_path:
        node = node.commands[name]  # type: ignore[attr-defined]
    return {opt for param in node.params for opt in getattr(param, "opts", [])}


def test_a_projects_topics_can_be_read_from_the_cli() -> None:
    commands = _subcommands(["topics"])
    assert "list" in commands, (
        "topics can be created and granted but never read back; the grant's own refusal names a "
        f"constraint the operator cannot inspect. topics exposes {sorted(commands)}"
    )


def test_listing_names_the_project() -> None:
    assert "--project-id" in _option_names(["topics", "list"]), (
        "listing must name the project: a topic belongs to one, and authority never crosses"
    )


def test_the_listing_carries_sensitivity() -> None:
    """Granting a `sensitivity >= 4` topic is a different decision from granting a `0`. A list that
    hides it invites the wrong grant."""
    source = SERVICE.read_text(encoding="utf-8")
    body = source[source.index("async def list_topics") :]
    body = body[: body.index("\n    async def ", 10)]
    assert "AUDIT-075" in body, "the read carries no record of why it exists"
    assert "sensitivity" in body, "the listing omits sensitivity, which is what makes a grant risky"
