"""RED control-plane contracts for Hunting Directory and Skill Lifecycle (T007)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.service import HuntService
from rsc_brain.identity.service import IdentityService
from rsc_brain.skills.frontmatter import SkillFrontmatter, serialize_skill
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

_PASSWORD = "correct horse battery staple"  # Integration fixture only.


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    app.state.hunts = HuntService(
        harness.sm, channel=NullChannel(), base_url="http://test", can_deliver=True
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    )


async def _session(
    harness: Harness,
    client: httpx.AsyncClient,
    *,
    platform_role: str = "member",
    project_id: str | None = None,
    project_role: str = "member",
    topics: tuple[str, ...] = ("general",),
    can_curate: bool = False,
) -> tuple[dict[str, str], str]:
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('hunting-skills')}@example.com"
    invitation = await identity.invite_user(email, role=platform_role)
    user_id = await identity.accept_invitation(invitation.token, _PASSWORD)
    if project_id is not None:
        await identity.add_membership(
            user_id,
            project_id,
            role=project_role,
            allowed_topics=topics,
            can_curate=can_curate,
        )
    login = await client.post("/api/v1/auth/login", json={"email": email, "password": _PASSWORD})
    assert login.status_code == 200, login.status_code
    return {"Authorization": f"Bearer {login.json()['session_token']}"}, user_id


def _safe_shape(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"content-type={response.headers.get('content-type', 'unknown')}"
    if isinstance(payload, dict):
        return f"keys={sorted(payload)}"
    return f"type={type(payload).__name__}"


def _status(failures: list[str], label: str, response: httpx.Response, expected: int) -> None:
    if response.status_code != expected:
        failures.append(
            f"{label}: expected {expected}, got {response.status_code}; {_safe_shape(response)}"
        )


def _object(response: httpx.Response) -> dict[str, object]:
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def _list_field(payload: dict[str, object], key: str) -> list[object]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


def _dict_field(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


async def test_manual_hunt_persists_topics_and_replays_idempotently(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("hunt-topics")
    project_id = await harness.setup_project(slug, [("general", 0), ("hidden", 4)])
    question = f"Who owns {unique_slug('deploy')}?"

    async with _client(harness, tmp_path) as client:
        headers, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="project-admin",
            topics=("general",),
        )
        owner = await client.post(
            f"/api/v1/admin/persons?project={slug}",
            headers=headers,
            json={
                "name": "Deployment owner",
                "topics": ["general"],
                "channels": {"email": "owner@example.invalid"},
                "quiet_hours": {},
                "language": "en",
            },
        )
        assert owner.status_code == 201, owner.status_code
        request_headers = {**headers, "Idempotency-Key": "hunt-topics-001"}
        first = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=request_headers,
            json={"question": question, "topics": ["general"]},
        )
        replay = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=request_headers,
            json={"question": question, "topics": ["general"]},
        )
        hunts = await client.get(f"/api/v1/admin/hunts?project={slug}", headers=headers)
        first_id = _object(first).get("hunt_id", "missing")
        detail = await client.get(f"/api/v1/admin/hunts/{first_id}?project={slug}", headers=headers)
        hidden = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=headers,
            json={"question": "hidden", "topics": ["hidden"]},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("first", first, 201),
        ("idempotent replay", replay, 200),
        ("list", hunts, 200),
        ("detail", detail, 200),
        ("unauthorized topic", hidden, 403),
    ):
        _status(failures, label, response, expected)
    first_body = _object(first)
    replay_body = _object(replay)
    if first.status_code == 201:
        if first_body.get("topics") != ["general"]:
            failures.append("first: authorized topics are not returned/persisted")
        if not first_body.get("audit_correlation"):
            failures.append("first: non-empty audit correlation missing")
    if replay.status_code == 200:
        if replay_body.get("hunt_id") != first_body.get("hunt_id"):
            failures.append("replay: idempotency key created a second hunt")
        if replay_body.get("replayed") is not True:
            failures.append("replay: authoritative replay flag missing")
    if hunts.status_code == 200:
        matching = [
            item
            for item in _list_field(_object(hunts), "hunts")
            if isinstance(item, dict) and item.get("question") == question
        ]
        if len(matching) != 1 or matching[0].get("topics") != ["general"]:
            failures.append("list: hunt is duplicated or its persisted topics are absent")
    if detail.status_code == 200 and _dict_field(_object(detail), "hunt").get("topics") != [
        "general"
    ]:
        failures.append("detail: persisted topics missing")
    assert not failures, "\n".join(failures)


async def test_person_collection_minimizes_contact_and_delete_reports_dependencies(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("directory")
    project_id = await harness.setup_project(slug, [("general", 0)])
    foreign_slug = unique_slug("foreign-directory")
    foreign_id = await harness.setup_project(foreign_slug, [("general", 0)])
    contact = f"private-{unique_slug('contact')}@example.invalid"

    async with _client(harness, tmp_path) as client:
        headers, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="project-admin",
        )
        foreign_headers, _ = await _session(
            harness,
            client,
            project_id=foreign_id,
            project_role="project-admin",
        )
        created = await client.post(
            f"/api/v1/admin/persons?project={slug}",
            headers=headers,
            json={
                "name": "Private contact",
                "topics": ["general"],
                "channels": {"email": contact, "slack": "@private"},
                "quiet_hours": {"tz": "Europe/Madrid", "start": "22:00", "end": "07:00"},
                "language": "es",
            },
        )
        assert created.status_code == 201, created.status_code
        person_id = _object(created).get("person_id", "missing")
        collection = await client.get(f"/api/v1/admin/persons?project={slug}", headers=headers)
        detail = await client.get(
            f"/api/v1/admin/persons/{person_id}?project={slug}", headers=headers
        )
        foreign_detail = await client.get(
            f"/api/v1/admin/persons/{person_id}?project={foreign_slug}", headers=foreign_headers
        )
        hunt = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=headers,
            json={"question": "dependency", "topics": ["general"]},
        )
        assert hunt.status_code == 201, hunt.status_code
        impact = await client.get(
            f"/api/v1/admin/persons/{person_id}/delete-impact?project={slug}", headers=headers
        )
        removed = await client.delete(
            f"/api/v1/admin/persons/{person_id}",
            headers=headers,
            params={"project": slug, "expected_version": 1},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("collection", collection, 200),
        ("detail", detail, 200),
        ("foreign detail", foreign_detail, 404),
        ("dependency impact", impact, 200),
        ("unsafe delete", removed, 409),
    ):
        _status(failures, label, response, expected)
    if collection.status_code == 200:
        if contact in collection.text or "@private" in collection.text:
            failures.append("collection: raw contact channel leaked")
        people = _list_field(_object(collection), "persons")
        item = next(
            (
                person
                for person in people
                if isinstance(person, dict) and person.get("id") == person_id
            ),
            None,
        )
        if not isinstance(item, dict) or set(item) != {
            "id",
            "name",
            "topics",
            "language",
            "channel_types",
            "has_quiet_hours",
            "active_hunts",
            "version",
        }:
            failures.append("collection: minimized PersonView schema missing")
    if detail.status_code == 200:
        person = _object(detail).get("person", {})
        if not isinstance(person, dict) or person.get("channels", {}).get("email") != contact:
            failures.append("detail: authorized contact channel missing")
    if impact.status_code == 200:
        body = _object(impact)
        if body.get("can_delete") is not False or body.get("active_hunts") != 1:
            failures.append("impact: active hunt dependency not reported")
    assert not failures, "\n".join(failures)


async def test_skill_view_dependency_validation_archive_replay_and_stale_version(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("skill-lifecycle")
    project_id = await harness.setup_project(slug, [("general", 0)])
    skill_slug = unique_slug("deploy-skill")
    dependency = str(uuid.uuid4())
    markdown = serialize_skill(
        SkillFrontmatter(
            slug=skill_slug,
            title="Deploy safely",
            tags=["general"],
            depends_on=[dependency],
            state="active",
            version=1,
        ),
        "## Procedure\n\nVerify the release.\n",
    )

    async with _client(harness, tmp_path) as client:
        headers, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="project-admin",
        )
        created = await client.post(
            f"/api/v1/admin/skills?project={slug}", headers=headers, json={"markdown": markdown}
        )
        listing = await client.get(f"/api/v1/admin/skills?project={slug}", headers=headers)
        validated = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/validate?project={slug}",
            headers=headers,
            json={"expected_version": 1},
        )
        archive_headers = {**headers, "Idempotency-Key": "archive-skill-001"}
        archived = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/archive?project={slug}",
            headers=archive_headers,
            json={"expected_version": 1},
        )
        replay = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/archive?project={slug}",
            headers=archive_headers,
            json={"expected_version": 1},
        )
        stale = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/archive?project={slug}",
            headers={**headers, "Idempotency-Key": "archive-skill-stale"},
            json={"expected_version": 1},
        )
        after = await client.get(f"/api/v1/admin/skills?project={slug}", headers=headers)

    failures: list[str] = []
    for label, response, expected in (
        ("create", created, 201),
        ("list", listing, 200),
        ("validate", validated, 200),
        ("archive", archived, 200),
        ("archive replay", replay, 200),
        ("stale version", stale, 409),
        ("list after", after, 200),
    ):
        _status(failures, label, response, expected)

    def find_skill(response: httpx.Response) -> dict[str, object] | None:
        if response.status_code != 200:
            return None
        return next(
            (
                item
                for item in _list_field(_object(response), "skills")
                if isinstance(item, dict) and item.get("slug") == skill_slug
            ),
            None,
        )

    listed = find_skill(listing)
    if listed is None or not {
        "slug",
        "title",
        "status",
        "stale",
        "depends_on",
        "version",
    } <= set(listed):
        failures.append("list: complete versioned SkillView missing")
    elif listed.get("depends_on") != [dependency] or listed.get("version") != 1:
        failures.append("list: dependency/version values are not authoritative")
    if validated.status_code == 200:
        body = _object(validated)
        if body.get("valid") is not True or body.get("depends_on") != [dependency]:
            failures.append("validate: dependency result missing")
    if archived.status_code == 200:
        body = _object(archived)
        if body.get("status") != "archived" or body.get("version") != 2:
            failures.append("archive: authoritative status/version missing")
        if not body.get("audit_correlation"):
            failures.append("archive: audit correlation missing")
    if replay.status_code == 200 and _object(replay).get("replayed") is not True:
        failures.append("archive replay: idempotent replay flag missing")
    current = find_skill(after)
    if current is None or current.get("status") != "archived" or current.get("version") != 2:
        failures.append("list after: stale request changed authoritative state")
    assert not failures, "\n".join(failures)


async def test_viewer_curator_and_platform_owner_cannot_mutate_project_directory(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("directory-deny")
    project_id = await harness.setup_project(slug, [("general", 0)])
    skill = serialize_skill(
        SkillFrontmatter(slug="denied", title="Denied", tags=["general"]), "No write"
    )

    async with _client(harness, tmp_path) as client:
        viewer, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="viewer",
            can_curate=True,
        )
        curator, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="member",
            can_curate=True,
        )
        owner, _ = await _session(harness, client, platform_role="owner")
        viewer_person = await client.post(
            f"/api/v1/admin/persons?project={slug}",
            headers=viewer,
            json={"name": "denied", "topics": ["general"]},
        )
        curator_skill = await client.post(
            f"/api/v1/admin/skills?project={slug}",
            headers=curator,
            json={"markdown": skill},
        )
        owner_hunt = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=owner,
            json={"question": "denied", "topics": ["general"]},
        )

    assert (
        viewer_person.status_code,
        curator_skill.status_code,
        owner_hunt.status_code,
    ) == (403, 403, 404), {
        "viewer_person": _safe_shape(viewer_person),
        "curator_skill": _safe_shape(curator_skill),
        "owner_hunt": _safe_shape(owner_hunt),
    }
