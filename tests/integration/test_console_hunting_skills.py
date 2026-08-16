"""RED control-plane contracts for Hunting Directory and Skill Lifecycle (T007)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import SQLAlchemyError

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.service import HuntService
from rsc_brain.identity.service import IdentityService
from rsc_brain.skills.frontmatter import SkillFrontmatter, serialize_skill
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

_PASSWORD = "correct horse battery staple"  # Integration fixture only.


def _client(harness: Harness, tmp_path: Path) -> tuple[httpx.AsyncClient, NullChannel]:
    channel = NullChannel()
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    app.state.hunts = HuntService(
        harness.sm, channel=channel, base_url="http://test", can_deliver=True
    )
    return (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ),
        channel,
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
    token = _object(login).get("session_token")
    assert login.status_code == 200 and isinstance(token, str), _safe_shape(login)
    return {"Authorization": f"Bearer {token}"}, user_id


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
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _list_field(payload: dict[str, object], key: str) -> list[object]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


def _dict_field(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def _string_field(payload: dict[str, object], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) else None


def _body_signature(response: httpx.Response) -> tuple[int, str, object]:
    """A total, comparable disclosure signature for both JSON and plain-text failures."""
    content_type = response.headers.get("content-type", "").partition(";")[0]
    try:
        body: object = response.json()
    except ValueError:
        body = response.text
    return response.status_code, content_type, body


def _uuid(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (AttributeError, TypeError, ValueError):
        return None


async def _hunt_count(harness: Harness, project_id: str, question: str) -> int:
    project_uuid = _uuid(project_id)
    if project_uuid is None:
        return -1
    async with harness.sm() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(models.Hunt)
            .where(models.Hunt.project_id == project_uuid, models.Hunt.question == question)
        )
        return int(count or 0)


async def _hunt_db_state(
    harness: Harness, hunt_id: object
) -> tuple[dict[str, object] | None, str | None]:
    """Read the authoritative row while remaining RED-as-AssertionError before T008 adds topics."""
    hunt_uuid = _uuid(hunt_id)
    if hunt_uuid is None:
        return None, "invalid hunt id"
    async with harness.sm() as session:
        has_topics = bool(
            await session.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'hunts' "
                    "AND column_name = 'topics')"
                )
            )
        )
        row = (
            (
                await session.execute(
                    text("SELECT * FROM hunts WHERE id = :hunt_id"), {"hunt_id": hunt_uuid}
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None, "hunt row missing"
        state = dict(row)
        if not has_topics:
            return state, "hunts.topics column missing"
        return state, None


async def _hunt_topic_column(harness: Harness) -> tuple[str, str | None] | None:
    async with harness.sm() as session:
        row = (
            await session.execute(
                text(
                    "SELECT is_nullable, column_default FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'hunts' "
                    "AND column_name = 'topics'"
                )
            )
        ).one_or_none()
        if row is None:
            return None
        return str(row.is_nullable), None if row.column_default is None else str(row.column_default)


async def _insert_legacy_hunt(
    harness: Harness, project_id: str, question: str
) -> tuple[str | None, str | None]:
    """Mimic the pre-topics writer by deliberately omitting the new field."""
    project_uuid = _uuid(project_id)
    if project_uuid is None:
        return None, "invalid project id"
    async with harness.sm() as session:
        legacy = models.Hunt(
            project_id=project_uuid,
            hunt_type="MANUAL",
            state="NO_OWNER",
            question=question,
        )
        session.add(legacy)
        try:
            await session.commit()
        except SQLAlchemyError as exc:
            await session.rollback()
            return None, type(exc).__name__
        return str(legacy.id), None


async def _person_exists(harness: Harness, person_id: object) -> bool:
    person_uuid = _uuid(person_id)
    if person_uuid is None:
        return False
    async with harness.sm() as session:
        return await session.get(models.Person, person_uuid) is not None


async def _person_db_state(harness: Harness, person_id: object) -> dict[str, object] | None:
    person_uuid = _uuid(person_id)
    if person_uuid is None:
        return None
    async with harness.sm() as session:
        row = (
            (
                await session.execute(
                    text("SELECT * FROM persons WHERE id = :person_id"), {"person_id": person_uuid}
                )
            )
            .mappings()
            .one_or_none()
        )
        return dict(row) if row is not None else None


async def _skill_db_state(harness: Harness, project_id: str, slug: str) -> dict[str, object] | None:
    project_uuid = _uuid(project_id)
    if project_uuid is None:
        return None
    async with harness.sm() as session:
        skill = await session.scalar(
            select(models.Skill).where(
                models.Skill.project_id == project_uuid, models.Skill.slug == slug
            )
        )
        if skill is None:
            return None
        return {
            "id": str(skill.id),
            "project_id": str(skill.project_id),
            "slug": skill.slug,
            "title": skill.title,
            "description": skill.description,
            "when_to_use": skill.when_to_use,
            "when_not": skill.when_not,
            "tags": list(skill.tags),
            "state": skill.state,
            "owner_person_id": str(skill.owner_person_id) if skill.owner_person_id else None,
            "depends_on": [str(item) for item in skill.depends_on],
            "body": skill.body,
            "stale": skill.stale,
            "stale_reason": skill.stale_reason,
            "stale_at": skill.stale_at,
            "version": skill.version,
        }


async def test_manual_hunt_persists_topics_and_replays_idempotently(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    harness = build_harness()
    slug = unique_slug("hunt-topics")
    project_id = await harness.setup_project(slug, [("general", 0), ("hidden", 4)])
    question = f"Who owns {unique_slug('deploy')}?"
    denied_question = f"Denied {unique_slug('hidden')}"
    legacy_question = f"Legacy {unique_slug('hunt')}"
    contact = f"owner-{unique_slug('contact')}@example.invalid"
    first_client, channel = _client(harness, tmp_path)

    async with first_client as client:
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
                "channels": {"email": contact},
                "quiet_hours": {},
                "language": "en",
            },
        )
        owner_id = _string_field(_object(owner), "person_id") or str(uuid.uuid4())
        request_headers = {**headers, "Idempotency-Key": "hunt-topics-001"}
        first = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=request_headers,
            json={"question": question, "topics": ["general"]},
        )
        first_id = _string_field(_object(first), "hunt_id") or str(uuid.uuid4())
        db_after_first, db_after_first_error = await _hunt_db_state(harness, first_id)
        replay = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=request_headers,
            json={"question": question, "topics": ["general"]},
        )
        db_after_replay, db_after_replay_error = await _hunt_db_state(harness, first_id)
        hidden = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=headers,
            json={"question": denied_question, "topics": ["hidden"]},
        )

    delivery_secrets = {
        value
        for message in channel.sent
        for value in (
            message.magic_link,
            message.magic_link.rsplit("/", 1)[-1] if message.magic_link else None,
        )
        if value
    }
    magic_token_hash = (
        db_after_replay.get("magic_token_hash") if db_after_replay is not None else None
    )
    if isinstance(magic_token_hash, str):
        delivery_secrets.add(magic_token_hash)

    owner_uuid = _uuid(owner_id)
    if owner_uuid is not None:
        async with harness.sm() as session:
            await session.execute(
                update(models.Person)
                .where(models.Person.id == owner_uuid)
                .values(topics=["hidden"])
            )
            await session.commit()
    legacy_id, legacy_error = await _insert_legacy_hunt(harness, project_id, legacy_question)

    # A replay is a successful read of the original command result: creation is 201, replay is 200.
    # Rebuilding the ASGI app proves list/detail come from Postgres, not request-local memory.
    restarted_client, _ = _client(harness, tmp_path)
    async with restarted_client as client:
        hunts = await client.get(f"/api/v1/admin/hunts?project={slug}", headers=headers)
        detail = await client.get(f"/api/v1/admin/hunts/{first_id}?project={slug}", headers=headers)
        legacy_detail = await client.get(
            f"/api/v1/admin/hunts/{legacy_id or uuid.uuid4()}?project={slug}", headers=headers
        )
        restricted, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="viewer",
            topics=("hidden",),
        )
        restricted_list = await client.get(
            f"/api/v1/admin/hunts?project={slug}", headers=restricted
        )
        restricted_detail = await client.get(
            f"/api/v1/admin/hunts/{first_id}?project={slug}", headers=restricted
        )
        missing_detail = await client.get(
            f"/api/v1/admin/hunts/{uuid.uuid4()}?project={slug}", headers=restricted
        )

    failures: list[str] = []
    for label, response, expected in (
        ("owner", owner, 201),
        ("first", first, 201),
        ("idempotent replay", replay, 200),
        ("list", hunts, 200),
        ("detail", detail, 200),
        ("legacy detail", legacy_detail, 200),
        ("unauthorized topic", hidden, 403),
        ("restricted list", restricted_list, 200),
        ("restricted detail", restricted_detail, 404),
        ("missing detail", missing_detail, 404),
    ):
        _status(failures, label, response, expected)
    first_body = _object(first)
    replay_body = _object(replay)
    if first.status_code == 201:
        if first_body.get("topics") != ["general"]:
            failures.append("first: authorized topics are not returned/persisted")
        if not first_body.get("audit_correlation"):
            failures.append("first: non-empty audit correlation missing")
        if first_body.get("replayed") is not False:
            failures.append("first: a newly-created hunt must report replayed=false")
        if set(first_body) != {
            "hunt_id",
            "state",
            "topics",
            "person_id",
            "throttled",
            "delivered",
            "audit_correlation",
            "replayed",
        }:
            failures.append("first: minimized command response shape missing")
    if replay.status_code == 200:
        if replay_body.get("hunt_id") != first_body.get("hunt_id"):
            failures.append("replay: idempotency key created a second hunt")
        if replay_body.get("replayed") is not True:
            failures.append("replay: authoritative replay flag missing")
        if replay_body.get("audit_correlation") != first_body.get("audit_correlation"):
            failures.append("replay: original audit correlation was not preserved")
        for key in (
            "hunt_id",
            "state",
            "topics",
            "person_id",
            "throttled",
            "delivered",
        ):
            if replay_body.get(key) != first_body.get(key):
                failures.append(f"replay: original {key} changed")
    if len(channel.sent) != 1:
        failures.append(f"replay: expected one delivery, got {len(channel.sent)}")
    if await _hunt_count(harness, project_id, question) != 1:
        failures.append("replay: authoritative database contains duplicate hunts")
    if await _hunt_count(harness, project_id, denied_question) != 0:
        failures.append("unauthorized topic: denied command persisted a hunt")
    if db_after_first_error is not None:
        failures.append(f"database after first: {db_after_first_error}")
    if db_after_replay_error is not None:
        failures.append(f"database after replay: {db_after_replay_error}")
    if db_after_replay is None or db_after_replay.get("topics") != ["general"]:
        failures.append("database: authorized topics were not persisted on the hunt row")
    if db_after_first != db_after_replay:
        failures.append("replay: authoritative hunt row was mutated")
    column = await _hunt_topic_column(harness)
    if column is None or column[0] != "NO" or column[1] is None:
        failures.append("migration: hunts.topics must be non-null with a legacy-safe default")
    if legacy_error is not None:
        failures.append(f"legacy row: insert without topics failed with {legacy_error}")
    if hunts.status_code == 200:
        matching = [
            item
            for item in _list_field(_object(hunts), "hunts")
            if isinstance(item, dict) and item.get("question") == question
        ]
        if len(matching) != 1 or matching[0].get("topics") != ["general"]:
            failures.append("list after restart: immutable topic snapshot missing or duplicated")
        elif set(matching[0]) != {
            "id",
            "type",
            "state",
            "question",
            "topics",
            "person_id",
            "gap_id",
            "correction_id",
            "channel",
            "retries",
            "created_at",
            "asked_at",
            "answered_at",
            "expires_at",
            "resolved_at",
        }:
            failures.append("list: minimized HuntView schema missing")
        legacy = next(
            (
                item
                for item in _list_field(_object(hunts), "hunts")
                if isinstance(item, dict) and item.get("id") == legacy_id
            ),
            None,
        )
        if not isinstance(legacy, dict) or legacy.get("topics") != []:
            failures.append("list: legacy hunt was not normalized to empty topics")
    detail_hunt = _dict_field(_object(detail), "hunt")
    if detail.status_code == 200 and detail_hunt.get("topics") != ["general"]:
        failures.append("detail after restart: immutable topic snapshot missing")
    if (
        legacy_detail.status_code == 200
        and _dict_field(_object(legacy_detail), "hunt").get("topics") != []
    ):
        failures.append("detail: legacy hunt was not normalized to empty topics")
    if restricted_list.status_code == 200:
        restricted_ids = {
            item.get("id")
            for item in _list_field(_object(restricted_list), "hunts")
            if isinstance(item, dict)
        }
        if first_id in restricted_ids:
            failures.append("restricted list: disclosed a hunt outside topic authority")
    if _body_signature(restricted_detail) != _body_signature(missing_detail):
        failures.append("restricted detail: refusal differs from an absent hunt")
    serialized_responses = "\n".join(
        response.text for response in (first, replay, hunts, detail, restricted_list)
    )
    captured = capsys.readouterr()
    captured_logs = f"{caplog.text}\n{captured.out}\n{captured.err}"
    for secret in delivery_secrets:
        if secret in serialized_responses or secret in captured_logs:
            failures.append("hunt secret leaked through a payload or logs")
            break
    assert not failures, "\n".join(failures)


async def test_person_collection_minimizes_contact_and_delete_reports_dependencies(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    harness = build_harness()
    slug = unique_slug("directory")
    project_id = await harness.setup_project(slug, [("general", 0)])
    foreign_slug = unique_slug("foreign-directory")
    foreign_id = await harness.setup_project(foreign_slug, [("general", 0)])
    contact = f"private-{unique_slug('contact')}@example.invalid"
    slack = f"@{unique_slug('private')}"
    client_instance, _ = _client(harness, tmp_path)

    async with client_instance as client:
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
                "name": "00 Dependent contact",
                "topics": ["general"],
                "channels": {"email": contact, "slack": slack},
                "quiet_hours": {"tz": "Europe/Madrid", "start": "22:00", "end": "07:00"},
                "language": "es",
            },
        )
        idle = await client.post(
            f"/api/v1/admin/persons?project={slug}",
            headers=headers,
            json={"name": "10 Idle", "topics": ["general"], "language": "en"},
        )
        stale_person = await client.post(
            f"/api/v1/admin/persons?project={slug}",
            headers=headers,
            json={"name": "20 Stale", "topics": ["general"], "language": "en"},
        )
        person_id = _string_field(_object(created), "person_id") or str(uuid.uuid4())
        idle_id = _string_field(_object(idle), "person_id") or str(uuid.uuid4())
        stale_id = _string_field(_object(stale_person), "person_id") or str(uuid.uuid4())
        collection = await client.get(f"/api/v1/admin/persons?project={slug}", headers=headers)
        detail = await client.get(
            f"/api/v1/admin/persons/{person_id}?project={slug}", headers=headers
        )
        foreign_detail = await client.get(
            f"/api/v1/admin/persons/{person_id}?project={foreign_slug}", headers=foreign_headers
        )
        foreign_missing = await client.get(
            f"/api/v1/admin/persons/{uuid.uuid4()}?project={foreign_slug}",
            headers=foreign_headers,
        )
        hunt = await client.post(
            f"/api/v1/admin/hunts/ask?project={slug}",
            headers=headers,
            json={"question": "dependency", "topics": ["general"]},
        )
        hunt_uuid = _uuid(_object(hunt).get("hunt_id"))
        async with harness.sm() as session:
            linked_person_before = (
                await session.scalar(
                    select(models.Hunt.person_id).where(models.Hunt.id == hunt_uuid)
                )
                if hunt_uuid is not None
                else None
            )
        dependent_before_delete = await _person_db_state(harness, person_id)
        impact = await client.get(
            f"/api/v1/admin/persons/{person_id}/delete-impact?project={slug}", headers=headers
        )
        idle_impact = await client.get(
            f"/api/v1/admin/persons/{idle_id}/delete-impact?project={slug}", headers=headers
        )
        idle_removed = await client.delete(
            f"/api/v1/admin/persons/{idle_id}",
            headers=headers,
            params={"project": slug, "expected_version": 1},
        )
        idle_after = await client.get(
            f"/api/v1/admin/persons/{idle_id}?project={slug}", headers=headers
        )
        blocked = await client.delete(
            f"/api/v1/admin/persons/{person_id}",
            headers=headers,
            params={"project": slug, "expected_version": 1},
        )
        blocked_after = await client.get(
            f"/api/v1/admin/persons/{person_id}?project={slug}", headers=headers
        )
        dependent_after_delete = await _person_db_state(harness, person_id)
        advanced = await client.patch(
            f"/api/v1/admin/persons/{stale_id}?project={slug}",
            headers=headers,
            json={"language": "fr", "expected_version": 1},
        )
        db_after_advance = await _person_db_state(harness, stale_id)
        stale_delete = await client.delete(
            f"/api/v1/admin/persons/{stale_id}",
            headers=headers,
            params={"project": slug, "expected_version": 1},
        )
        db_after_stale_delete = await _person_db_state(harness, stale_id)
        stale_after = await client.get(
            f"/api/v1/admin/persons/{stale_id}?project={slug}", headers=headers
        )

    failures: list[str] = []
    for label, response, expected in (
        ("create dependent", created, 201),
        ("create idle", idle, 201),
        ("create stale", stale_person, 201),
        ("collection", collection, 200),
        ("detail", detail, 200),
        ("foreign detail", foreign_detail, 404),
        ("foreign missing", foreign_missing, 404),
        ("hunt", hunt, 201),
        ("dependency impact", impact, 200),
        ("idle impact", idle_impact, 200),
        ("idle delete", idle_removed, 200),
        ("idle after", idle_after, 404),
        ("dependency delete", blocked, 409),
        ("dependency survivor", blocked_after, 200),
        ("version advance", advanced, 200),
        ("stale delete", stale_delete, 409),
        ("stale survivor", stale_after, 200),
    ):
        _status(failures, label, response, expected)
    for label, response in (
        ("dependent", created),
        ("idle", idle),
        ("stale", stale_person),
    ):
        if response.status_code == 201 and _object(response).get("version") != 1:
            failures.append(f"create {label}: initial version 1 missing")
    if collection.status_code == 200:
        if contact in collection.text or slack in collection.text:
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
        person = _dict_field(_object(detail), "person")
        channels = _dict_field(person, "channels")
        if channels.get("email") != contact or channels.get("slack") != slack:
            failures.append("detail: authorized contact channel missing")
        if person.get("version") != 1:
            failures.append("detail: authoritative person version missing")
    if _body_signature(foreign_detail) != _body_signature(foreign_missing):
        failures.append("foreign detail: response differs from a genuinely absent person")
    hunt_body = _object(hunt)
    if hunt.status_code == 201 and hunt_body.get("person_id") != person_id:
        failures.append("hunt: dependency was not linked to the selected person")
    if hunt_uuid is None:
        failures.append("hunt: valid persisted id missing")
    elif str(linked_person_before) != person_id:
        failures.append("hunt: database row is not linked to the selected person")
    if impact.status_code == 200:
        body = _object(impact)
        if body.get("can_delete") is not False or body.get("active_hunts") != 1:
            failures.append("impact: active hunt dependency not reported")
    if idle_impact.status_code == 200:
        body = _object(idle_impact)
        if body.get("can_delete") is not True or body.get("active_hunts") != 0:
            failures.append("impact: dependency-free control was not deletable")
    if idle_removed.status_code == 200 and _object(idle_removed).get("removed") is not True:
        failures.append("idle delete: authoritative removed flag missing")
    if await _person_exists(harness, idle_id):
        failures.append("idle delete: person remains persisted")
    if not await _person_exists(harness, person_id):
        failures.append("dependency delete: 409 was returned after deleting the person")
    if dependent_before_delete != dependent_after_delete:
        failures.append("dependency delete: conflict mutated authoritative person state")
    if advanced.status_code == 200 and (
        _object(advanced).get("version") != 2 or _object(advanced).get("language") != "fr"
    ):
        failures.append("version advance: authoritative version/language missing")
    if not await _person_exists(harness, stale_id):
        failures.append("stale delete: conflict mutated or deleted the person")
    if db_after_advance != db_after_stale_delete:
        failures.append("stale delete: conflict changed authoritative person fields")
    stale_view = _dict_field(_object(stale_after), "person")
    if stale_after.status_code == 200 and (
        stale_view.get("version") != 2 or stale_view.get("language") != "fr"
    ):
        failures.append("stale delete: authoritative state changed after conflict")
    captured = capsys.readouterr()
    captured_logs = f"{caplog.text}\n{captured.out}\n{captured.err}"
    if contact in captured_logs or slack in captured_logs:
        failures.append("person contact leaked through logs")
    assert not failures, "\n".join(failures)


async def test_skill_view_dependency_validation_archive_replay_and_stale_version(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("skill-lifecycle")
    project_id = await harness.setup_project(slug, [("general", 0)])
    skill_slug = unique_slug("deploy-skill")
    async with harness.sm() as session:
        dependency_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == _uuid(project_id), models.Topic.slug == "general"
            )
        )
    dependency = str(dependency_id or uuid.uuid4())
    initial_version = 7
    markdown = serialize_skill(
        SkillFrontmatter(
            slug=skill_slug,
            title="Deploy safely",
            tags=["general"],
            depends_on=[dependency],
            state="proposed",
            version=initial_version,
        ),
        "## Procedure\n\nVerify the release.\n",
    )

    client_instance, _ = _client(harness, tmp_path)
    async with client_instance as client:
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
            json={"expected_version": initial_version},
        )
        listed_after_validation = await client.get(
            f"/api/v1/admin/skills?project={slug}", headers=headers
        )
        db_after_validation = await _skill_db_state(harness, project_id, skill_slug)
        archive_headers = {**headers, "Idempotency-Key": "archive-skill-001"}
        archived = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/archive?project={slug}",
            headers=archive_headers,
            json={"expected_version": initial_version + 1},
        )
        db_after_archive = await _skill_db_state(harness, project_id, skill_slug)
        replay = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/archive?project={slug}",
            headers=archive_headers,
            json={"expected_version": initial_version + 1},
        )
        db_after_replay = await _skill_db_state(harness, project_id, skill_slug)
        stale = await client.post(
            f"/api/v1/admin/skills/{skill_slug}/archive?project={slug}",
            headers={**headers, "Idempotency-Key": "archive-skill-stale"},
            json={"expected_version": initial_version + 1},
        )
        db_after_stale = await _skill_db_state(harness, project_id, skill_slug)
        after = await client.get(f"/api/v1/admin/skills?project={slug}", headers=headers)

    failures: list[str] = []
    if dependency_id is None:
        failures.append("fixture: validate dependency does not exist in the project")
    for label, response, expected in (
        ("create", created, 201),
        ("list", listing, 200),
        ("validate", validated, 200),
        ("list after validate", listed_after_validation, 200),
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
    skill_view_fields = {
        "slug",
        "title",
        "status",
        "stale",
        "depends_on",
        "version",
    }
    if listed is None or not skill_view_fields <= set(listed):
        failures.append("list: complete versioned SkillView missing")
    elif (
        listed.get("status") != "proposed"
        or listed.get("stale") is not False
        or listed.get("depends_on") != [dependency]
        or listed.get("version") != initial_version
    ):
        failures.append(
            "list: proposed status/dependency/stale/version values are not authoritative"
        )
    if validated.status_code == 200:
        body = _object(validated)
        if (
            body.get("status") != "active"
            or body.get("version") != initial_version + 1
            or body.get("stale") is not False
            or body.get("depends_on") != [dependency]
        ):
            failures.append(
                "validate: proposed skill did not transition to authoritative active view"
            )
        if not body.get("audit_correlation"):
            failures.append("validate: audit correlation missing")
    validated_view = find_skill(listed_after_validation)
    if validated_view is None or any(
        (
            validated_view.get("status") != "active",
            validated_view.get("version") != initial_version + 1,
            validated_view.get("stale") is not False,
            validated_view.get("depends_on") != [dependency],
        )
    ):
        failures.append("list after validate: active transition was not persisted")
    if db_after_validation is None or any(
        (
            db_after_validation.get("state") != "active",
            db_after_validation.get("version") != initial_version + 1,
            db_after_validation.get("stale") is not False,
            db_after_validation.get("depends_on") != [dependency],
        )
    ):
        failures.append("validate: database transition is not authoritative")
    if archived.status_code == 200:
        body = _object(archived)
        if body.get("status") != "archived" or body.get("version") != initial_version + 2:
            failures.append("archive: authoritative status/version missing")
        if body.get("stale") is not False or body.get("depends_on") != [dependency]:
            failures.append("archive: dependency/stale state changed")
        if body.get("replayed") is not False:
            failures.append("archive: first command must report replayed=false")
        if not body.get("audit_correlation"):
            failures.append("archive: audit correlation missing")
    if replay.status_code == 200:
        archive_body = _object(archived)
        replay_body = _object(replay)
        if replay_body.get("replayed") is not True:
            failures.append("archive replay: idempotent replay flag missing")
        for key in ("slug", "status", "version", "stale", "depends_on", "audit_correlation"):
            if replay_body.get(key) != archive_body.get(key):
                failures.append(f"archive replay: original {key} changed")
    if db_after_archive is None or any(
        (
            db_after_archive.get("state") != "archived",
            db_after_archive.get("version") != initial_version + 2,
            db_after_archive.get("stale") is not False,
            db_after_archive.get("depends_on") != [dependency],
        )
    ):
        failures.append("archive: database transition is not authoritative")
    if not (db_after_archive == db_after_replay == db_after_stale):
        failures.append("archive replay/stale conflict mutated authoritative skill state")
    current = find_skill(after)
    if current is None or any(
        (
            current.get("status") != "archived",
            current.get("version") != initial_version + 2,
            current.get("stale") is not False,
            current.get("depends_on") != [dependency],
        )
    ):
        failures.append("list after: replay/stale request changed authoritative state")
    assert not failures, "\n".join(failures)


async def test_viewer_curator_and_platform_owner_cannot_mutate_project_directory(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("directory-deny")
    project_id = await harness.setup_project(slug, [("general", 0)])
    marker = unique_slug("denied")
    client_instance, _ = _client(harness, tmp_path)

    async with client_instance as client:
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
        owner_member, _ = await _session(
            harness,
            client,
            platform_role="owner",
            project_id=project_id,
            project_role="member",
        )
        admin, _ = await _session(
            harness,
            client,
            project_id=project_id,
            project_role="project-admin",
        )
        actors = {"viewer": viewer, "curator": curator, "owner-member": owner_member}
        denials: dict[str, httpx.Response] = {}
        for actor, actor_headers in actors.items():
            person_name = f"{marker}-person-{actor}"
            skill_slug = f"{marker}-skill-{actor}"
            question = f"{marker}-hunt-{actor}"
            skill = serialize_skill(
                SkillFrontmatter(slug=skill_slug, title="Denied", tags=["general"]),
                "No write",
            )
            denials[f"{actor}/person"] = await client.post(
                f"/api/v1/admin/persons?project={slug}",
                headers=actor_headers,
                json={"name": person_name, "topics": ["general"]},
            )
            denials[f"{actor}/skill"] = await client.post(
                f"/api/v1/admin/skills?project={slug}",
                headers=actor_headers,
                json={"markdown": skill},
            )
            denials[f"{actor}/hunt"] = await client.post(
                f"/api/v1/admin/hunts/ask?project={slug}",
                headers=actor_headers,
                json={"question": question, "topics": ["general"]},
            )
        persons_after = await client.get(f"/api/v1/admin/persons?project={slug}", headers=admin)
        skills_after = await client.get(f"/api/v1/admin/skills?project={slug}", headers=admin)
        hunts_after = await client.get(f"/api/v1/admin/hunts?project={slug}", headers=admin)

    failures = [
        f"{label}: expected 403, got {response.status_code}; {_safe_shape(response)}"
        for label, response in denials.items()
        if response.status_code != 403
    ]
    for label, response in (
        ("persons after", persons_after),
        ("skills after", skills_after),
        ("hunts after", hunts_after),
    ):
        _status(failures, label, response, 200)
    project_uuid = _uuid(project_id)
    if project_uuid is None:
        failures.append("postcondition: invalid project id")
    else:
        async with harness.sm() as session:
            person_count = await session.scalar(
                select(func.count())
                .select_from(models.Person)
                .where(
                    models.Person.project_id == project_uuid,
                    models.Person.name.startswith(marker),
                )
            )
            skill_count = await session.scalar(
                select(func.count())
                .select_from(models.Skill)
                .where(
                    models.Skill.project_id == project_uuid,
                    models.Skill.slug.startswith(marker),
                )
            )
            hunt_count = await session.scalar(
                select(func.count())
                .select_from(models.Hunt)
                .where(
                    models.Hunt.project_id == project_uuid,
                    models.Hunt.question.startswith(marker),
                )
            )
        if (int(person_count or 0), int(skill_count or 0), int(hunt_count or 0)) != (0, 0, 0):
            failures.append("postcondition: a denied command persisted a person, skill, or hunt")
    assert not failures, "\n".join(failures)
