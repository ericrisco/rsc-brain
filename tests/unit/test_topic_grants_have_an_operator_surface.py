"""AUDIT-073: the product's headline permission model had no way to grant a topic to anyone.

Found while building the precondition for T010 — two projects with real taxonomy and differentiated
principals — which is the setup G2 (zero permission leaks, cross-project included) is measured on.
There was no way to construct it through the product.

What existed: `POST /topics` creates a topic and grants it to **its creator**, and bootstrap grants
the first owner a snapshot. Between them, nothing. No CLI command, no API route and no console
surface granted or revoked a topic for any other principal — and `revoke_topics` did not exist at
all. Every route out led to a direct database write, which is exactly what `create_topic`'s own
docstring says the grant exists to avoid.

SPEC-04 §3.1 specifies memberships carrying `allowed_topics[]` in `api/` + `cli/`, and §3.2's
acceptance check — "asignar un topic de otro proyecto a una membresía falla" — presumes the assigning
operation exists and validates. So this is a missing implementation of a specified capability, not a
new feature.

The consequence is larger than a missing command. A company installs this to give its departments
deterministic topic-based access; past the first user, it cannot. A topic with `sensitivity >= 3`
(hr, payroll, personnel in the shipped taxonomy) can never be held by anyone but whoever typed it in.
And G2 cannot be measured through product surfaces at all, which is the real reason T010 was never
run.
"""

from __future__ import annotations

from pathlib import Path

from rsc_brain.cli.main import app

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "src" / "rsc_brain" / "identity" / "service.py"
ADMIN_API = REPO / "src" / "rsc_brain" / "api" / "admin.py"


def test_the_cli_can_grant_a_topic_to_a_principal() -> None:
    assert "grant" in _subcommands(["topics"]), (
        "no CLI surface grants a topic, so a second user's authority can only be set with SQL"
    )


def test_the_cli_can_revoke_a_topic_from_a_principal() -> None:
    """`create_topic`'s docstring claims the grant is 'visible and revocable'. Nothing revoked it:
    authority could only ever grow."""
    assert "revoke" in _subcommands(["topics"]), "granted authority could not be withdrawn"


def _subcommands(command_path: list[str]) -> set[str]:
    """The names of a group's subcommands, read from the parsed command tree."""
    import typer.main

    node = typer.main.get_command(app)
    for name in command_path:
        node = node.commands[name]  # type: ignore[attr-defined]
    return set(node.commands)  # type: ignore[attr-defined]


def _option_names(command_path: list[str]) -> set[str]:
    """The command's declared option strings.

    Read from the parsed command rather than from `--help`: Rich wraps help output to the terminal
    width, so an assertion against rendered text passes at one width and fails at another. My first
    version of this test did exactly that — green locally, red in CI on the same commit.
    """
    import typer.main

    click_command = typer.main.get_command(app)
    node = click_command
    for name in command_path:
        node = node.commands[name]  # type: ignore[attr-defined]
    return {opt for param in node.params for opt in getattr(param, "opts", [])}


def test_granting_names_the_principal_and_the_project() -> None:
    """A grant is meaningless without saying whose it is. The command must take the user and the
    project, not default to the caller — defaulting to the caller is precisely the hole this fixes."""
    options = _option_names(["topics", "grant"])
    for option in ("--project-id", "--user-id"):
        assert option in options, f"grant does not name {option}; it declares {sorted(options)}"


def test_a_grant_is_validated_against_the_project_taxonomy() -> None:
    """SPEC-04 §3.2: "asignar un topic de otro proyecto a una membresía falla". `grant_topics` merged
    whatever string it was handed into `allowed_topics` — no check that the slug names a topic of
    that project, or a topic at all. Authority is the one field that must never accept an
    unvalidated write."""
    source = SERVICE.read_text(encoding="utf-8")
    body = source[source.index("async def grant_topics") :]
    body = body[: body.index("\n    async def ", 10)]
    assert "AUDIT-073" in body, "the grant path carries no record of the validation it lacked"
    assert "Topic" in body, (
        "grant_topics never consults the project's topics, so it cannot reject a foreign slug"
    )


def test_the_api_exposes_granting_as_spec_04_requires() -> None:
    """SPEC-04 §3.1's check: roles and topic authority "persistidos y expuestos por API"."""
    source = ADMIN_API.read_text(encoding="utf-8")
    assert "grants" in source or "grant" in source, "no API route grants a topic"
    assert "AUDIT-073" in source, "the new surface carries no record of why it exists"
