"""AUDIT-074: nobody could be made a member of a project. The second user was inert forever.

Found immediately after AUDIT-073 shipped, while using its new `brain topics grant` to build T010's
precondition — and discovering that the command's own precondition could not be met.

The chain, all through product surfaces:

    brain users invite   -> creates a user
    brain users accept   -> the user sets a password
    (nothing)            -> the user is a member of no project
    brain topics grant   -> correctly refuses: no membership

`add_membership` exists on the service and is called from exactly one place: `deploy/bootstrap.py`,
for the very first owner. No CLI command and no API route ever calls it. So on any installation, every
user after the first can authenticate, holds no membership, sees nothing, and cannot be given
anything — with no route out except a direct database write.

This is the same defect family as AUDIT-073 one step earlier, and it means the AUDIT-073 fix was
necessary but not sufficient: I built the grant surface on top of a precondition nobody could create.

SPEC-04 §3.1 specifies memberships — "(usuario, proyecto, rol owner/project-admin/member/viewer,
`allowed_topics[]`, flag `can_curate`); única por (usuario, proyecto)" — in `api/` + `cli/`, with the
check that roles and `can_curate` are "persistidos y expuestos por API". None of it was reachable.
"""

from __future__ import annotations

from pathlib import Path

from rsc_brain.cli.main import app

REPO = Path(__file__).resolve().parents[2]
ADMIN_API = REPO / "src" / "rsc_brain" / "api" / "admin.py"


def _subcommands(command_path: list[str]) -> set[str]:
    """Subcommand names read from the parsed command tree, never from rendered help text (a `--help`
    assertion depends on the terminal width: mine passed locally and failed in CI on one commit)."""
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


def test_a_user_can_be_made_a_member_of_a_project() -> None:
    """The operation that makes an invited user able to do anything at all."""
    commands = _subcommands(["users"])
    assert "add-membership" in commands, (
        "no surface attaches a user to a project, so every user after the first is inert and can "
        f"only be fixed with SQL; users exposes {sorted(commands)}"
    )


def test_a_membership_can_be_removed() -> None:
    """Access that cannot be withdrawn is not access control. Removing someone from a project is the
    operation that runs when they leave the team."""
    assert "remove-membership" in _subcommands(["users"]), "a membership could not be withdrawn"


def test_a_membership_names_its_project_and_role() -> None:
    """SPEC-04 §3.1: the role and `can_curate` are part of the membership, not implied. A membership
    created with a silent default role is an authority decision nobody made."""
    options = _option_names(["users", "add-membership"])
    for option in ("--project-id", "--role"):
        assert option in options, (
            f"add-membership does not name {option}; it declares {sorted(options)}"
        )


def test_memberships_are_listable() -> None:
    """Before granting a topic an administrator has to see who is a member. AUDIT-073's grant
    refuses without a membership; nothing showed whether one existed."""
    assert "memberships" in _subcommands(["users"]), "no surface reports who belongs to a project"


def test_the_api_exposes_membership_as_spec_04_requires() -> None:
    """SPEC-04 §3.1's check: roles and `can_curate` "persistidos y expuestos por API"."""
    source = ADMIN_API.read_text(encoding="utf-8")
    assert "AUDIT-074" in source, "the membership surface carries no record of why it exists"
    assert "memberships" in source, "no API route manages membership"
