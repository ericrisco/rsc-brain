"""AUDIT-018 parity contract for the installed ``brain skills`` surface."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from typer.testing import CliRunner

from rsc_brain.cli.main import app
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.skills.frontmatter import SkillFrontmatter, serialize_skill

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


def _write(path: Path, frontmatter: SkillFrontmatter, body: str) -> None:
    path.write_text(serialize_skill(frontmatter, body), encoding="utf-8")


async def test_cli_create_edit_show_list_archive_preserves_owner_and_versions(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("skills-cli")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    scope = harness.scope(project_id, allowed_topics=["general"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope, name="CLI Owner", channels={"email": "owner@example.test"}, topics=["general"]
    )
    source = tmp_path / "skill.md"
    _write(
        source,
        SkillFrontmatter(
            slug="cli-parity",
            title="CLI initial",
            tags=["general"],
            owner="CLI Owner",
            state="proposed",
            version=1,
        ),
        "initial body",
    )
    runner = CliRunner()

    created = await asyncio.to_thread(
        runner.invoke,
        app,
        ["skills", "create", str(source), "--project", project_slug, "--json"],
    )
    shown = await asyncio.to_thread(
        runner.invoke,
        app,
        ["skills", "show", "cli-parity", "--project", project_slug, "--json"],
    )
    listed = await asyncio.to_thread(
        runner.invoke, app, ["skills", "list", "--project", project_slug, "--json"]
    )
    _write(
        source,
        SkillFrontmatter(
            slug="cli-parity",
            title="CLI edited",
            tags=["general"],
            owner=owner_id,
            state="proposed",
            version=1,
        ),
        "edited body",
    )
    edited = await asyncio.to_thread(
        runner.invoke,
        app,
        ["skills", "edit", str(source), "--project", project_slug, "--json"],
    )
    archived = await asyncio.to_thread(
        runner.invoke,
        app,
        ["skills", "archive", "cli-parity", "--project", project_slug, "--json"],
    )

    assert created.exit_code == 0, created.output
    assert shown.exit_code == 0, shown.output
    shown_payload = json.loads(shown.output)
    assert f"owner: {owner_id}" in shown_payload["markdown"]
    assert listed.exit_code == 0, listed.output
    listed_row = json.loads(listed.output)["skills"][0]
    assert listed_row["owner_person_id"] == owner_id
    assert listed_row["version"] == 1
    assert edited.exit_code == 0, edited.output
    assert json.loads(edited.output)["version"] == 2
    assert archived.exit_code == 0, archived.output
    archived_payload = json.loads(archived.output)
    assert archived_payload["version"] == 3
    assert archived_payload["status"] == "archived"
