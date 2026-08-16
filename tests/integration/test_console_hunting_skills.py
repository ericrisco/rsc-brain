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

_HUNT_COMMAND_FIELDS = frozenset(
    {
        "hunt_id",
        "state",
        "topics",
        "person_id",
        "throttled",
        "delivered",
        "audit_correlation",
        "replayed",
    }
)
_HUNT_VIEW_FIELDS = frozenset(
    {
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
    }
)
_PERSON_COLLECTION_FIELDS = frozenset(
    {
        "id",
        "name",
        "topics",
        "language",
        "channel_types",
        "has_quiet_hours",
        "active_hunts",
        "version",
    }
)
_SKILL_CREATE_FIELDS = frozenset({"skill_id", "slug"})
_SKILL_VIEW_FIELDS = frozenset({"slug", "title", "status", "stale", "depends_on", "version"})
_SKILL_VALIDATE_FIELDS = frozenset(
    {"slug", "status", "stale", "depends_on", "version", "audit_correlation"}
)
_SKILL_ARCHIVE_FIELDS = frozenset(
    {
        "slug",
        "status",
        "stale",
        "depends_on",
        "version",
        "audit_correlation",
        "replayed",
    }
)


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


def _forbidden_public_key_paths(value: object, path: str = "$") -> list[str]:
    """Find secret-bearing keys recursively without ever rendering their values."""
    paths: list[str] = []
    if isinstance(value, dict):
        for raw_key, child in value.items():
            key = str(raw_key).casefold().replace("-", "_")
            child_path = f"{path}.{raw_key}"
            is_secret_key = any(
                (
                    key.startswith("magic"),
                    "token" in key,
                    "hash" in key,
                    "contact" in key,
                    key in {"channels", "email", "slack"},
                    "channel" in key and key not in {"channel", "channel_types"},
                )
            )
            if is_secret_key:
                paths.append(child_path)
            paths.extend(_forbidden_public_key_paths(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(_forbidden_public_key_paths(child, f"{path}[{index}]"))
    return paths


def _response_value(response: httpx.Response) -> object:
    try:
        return response.json()
    except ValueError:
        return response.text


def _secret_value_paths(value: object, secrets: set[str], path: str = "$") -> list[str]:
    """Find fixture secrets recursively while reporting paths, never the secret values."""
    if isinstance(value, str):
        return [path] if any(secret in value for secret in secrets) else []
    paths: list[str] = []
    if isinstance(value, dict):
        for raw_key, child in value.items():
            paths.extend(_secret_value_paths(child, secrets, f"{path}.{raw_key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(_secret_value_paths(child, secrets, f"{path}[{index}]"))
    return paths


def _check_public_payload(
    failures: list[str],
    label: str,
    response: httpx.Response,
    expected: frozenset[str] | None = None,
) -> None:
    """Check a JSON payload's closed shape and recursively reject secret-bearing keys."""
    value = _response_value(response)
    payload = value if isinstance(value, dict) else {}
    if expected is not None and response.status_code < 400 and set(payload) != expected:
        failures.append(f"{label}: minimized top-level response shape differs")
    if forbidden_paths := _forbidden_public_key_paths(value):
        failures.append(f"{label}: secret-bearing response keys at {', '.join(forbidden_paths)}")


def _check_secret_values(
    failures: list[str],
    label: str,
    responses: tuple[httpx.Response, ...],
    logs: str,
    secrets: set[str],
) -> None:
    leaked_paths = [
        f"response[{index}]{path.removeprefix('$')}"
        for index, response in enumerate(responses)
        for path in _secret_value_paths(_response_value(response), secrets)
    ]
    if leaked_paths:
        failures.append(f"{label}: secret fixture value leaked at {', '.join(leaked_paths)}")
    if any(secret in logs for secret in secrets):
        failures.append(f"{label}: secret fixture value leaked through logs")


async def _project_resource_counts(harness: Harness, project_id: str) -> tuple[int, int, int]:
    project_uuid = _uuid(project_id)
    if project_uuid is None:
        return (-1, -1, -1)
    async with harness.sm() as session:
        counts: list[int] = []
        for model in (models.Person, models.Skill, models.Hunt):
            count = await session.scalar(
                select(func.count()).select_from(model).where(model.project_id == project_uuid)
            )
            counts.append(int(count or 0))
    return counts[0], counts[1], counts[2]


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

    delivery_secrets = {contact} | {
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
    _check_public_payload(failures, "first", first, _HUNT_COMMAND_FIELDS)
    _check_public_payload(failures, "replay", replay, _HUNT_COMMAND_FIELDS)
    _check_public_payload(failures, "list", hunts, frozenset({"hunts"}))
    _check_public_payload(failures, "detail", detail, frozenset({"hunt"}))
    _check_public_payload(failures, "legacy detail", legacy_detail, frozenset({"hunt"}))
    _check_public_payload(failures, "restricted list", restricted_list, frozenset({"hunts"}))
    for label, response in (
        ("owner", owner),
        ("unauthorized topic", hidden),
        ("restricted detail", restricted_detail),
        ("missing detail", missing_detail),
    ):
        _check_public_payload(failures, label, response)
    if first.status_code == 201:
        if first_body.get("topics") != ["general"]:
            failures.append("first: authorized topics are not returned/persisted")
        if not first_body.get("audit_correlation"):
            failures.append("first: non-empty audit correlation missing")
        if first_body.get("replayed") is not False:
            failures.append("first: a newly-created hunt must report replayed=false")
    if replay.status_code == 200:
        if replay_body.get("replayed") is not True:
            failures.append("replay: authoritative replay flag missing")
        expected_replay = {**first_body, "replayed": True}
        if replay_body != expected_replay:
            failures.append("replay: complete original command result changed beyond replayed flag")
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
        hunt_rows = _list_field(_object(hunts), "hunts")
        if any(not isinstance(item, dict) or set(item) != _HUNT_VIEW_FIELDS for item in hunt_rows):
            failures.append("list: a HuntView did not match the minimized closed schema")
        matching = [
            item
            for item in hunt_rows
            if isinstance(item, dict) and item.get("question") == question
        ]
        if len(matching) != 1 or matching[0].get("topics") != ["general"]:
            failures.append("list after restart: immutable topic snapshot missing or duplicated")
        legacy = next(
            (item for item in hunt_rows if isinstance(item, dict) and item.get("id") == legacy_id),
            None,
        )
        if not isinstance(legacy, dict) or legacy.get("topics") != []:
            failures.append("list: legacy hunt was not normalized to empty topics")
    detail_hunt = _dict_field(_object(detail), "hunt")
    if detail.status_code == 200:
        if set(detail_hunt) != _HUNT_VIEW_FIELDS:
            failures.append("detail: HuntView did not match the minimized closed schema")
        if detail_hunt.get("topics") != ["general"]:
            failures.append("detail after restart: immutable topic snapshot missing")
    legacy_hunt = _dict_field(_object(legacy_detail), "hunt")
    if legacy_detail.status_code == 200 and (
        set(legacy_hunt) != _HUNT_VIEW_FIELDS or legacy_hunt.get("topics") != []
    ):
        failures.append("detail: legacy HuntView was not minimized or normalized to empty topics")
    if restricted_list.status_code == 200:
        restricted_rows = _list_field(_object(restricted_list), "hunts")
        if any(
            not isinstance(item, dict) or set(item) != _HUNT_VIEW_FIELDS for item in restricted_rows
        ):
            failures.append("restricted list: a HuntView did not match the closed schema")
        restricted_ids = {item.get("id") for item in restricted_rows if isinstance(item, dict)}
        if first_id in restricted_ids:
            failures.append("restricted list: disclosed a hunt outside topic authority")
    if _body_signature(restricted_detail) != _body_signature(missing_detail):
        failures.append("restricted detail: refusal differs from an absent hunt")
    captured = capsys.readouterr()
    captured_logs = f"{caplog.text}\n{captured.out}\n{captured.err}"
    _check_secret_values(
        failures,
        "hunt public surfaces",
        (
            owner,
            first,
            replay,
            hidden,
            hunts,
            detail,
            legacy_detail,
            restricted_list,
            restricted_detail,
            missing_detail,
        ),
        captured_logs,
        delivery_secrets,
    )
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
    _check_public_payload(failures, "person collection", collection, frozenset({"persons"}))
    _check_public_payload(failures, "dependency hunt", hunt, _HUNT_COMMAND_FIELDS)
    for label, response in (
        ("create dependent", created),
        ("create idle", idle),
        ("create stale", stale_person),
        ("foreign detail", foreign_detail),
        ("foreign missing", foreign_missing),
        ("dependency impact", impact),
        ("idle impact", idle_impact),
        ("idle delete", idle_removed),
        ("idle after", idle_after),
        ("dependency delete", blocked),
        ("stale delete", stale_delete),
    ):
        _check_public_payload(failures, label, response)
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
        if any(
            not isinstance(person, dict) or set(person) != _PERSON_COLLECTION_FIELDS
            for person in people
        ):
            failures.append("collection: a PersonView did not match the minimized closed schema")
        item = next(
            (
                person
                for person in people
                if isinstance(person, dict) and person.get("id") == person_id
            ),
            None,
        )
        if not isinstance(item, dict):
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
    _check_secret_values(
        failures,
        "minimized person surfaces",
        (
            created,
            idle,
            stale_person,
            collection,
            foreign_detail,
            foreign_missing,
            hunt,
            impact,
            idle_impact,
            idle_removed,
            idle_after,
            blocked,
            stale_delete,
        ),
        captured_logs,
        {contact, slack},
    )
    assert not failures, "\n".join(failures)


async def test_skill_view_dependency_validation_archive_replay_and_stale_version(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
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
    procedure_secret = f"private-procedure-{unique_slug('body')}"
    markdown = serialize_skill(
        SkillFrontmatter(
            slug=skill_slug,
            title="Deploy safely",
            tags=["general"],
            depends_on=[dependency],
            state="proposed",
            version=initial_version,
        ),
        f"## Procedure\n\nVerify the release using {procedure_secret}.\n",
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
    for label, response, expected_fields in (
        ("create", created, _SKILL_CREATE_FIELDS),
        ("list", listing, frozenset({"skills"})),
        ("validate", validated, _SKILL_VALIDATE_FIELDS),
        ("list after validate", listed_after_validation, frozenset({"skills"})),
        ("archive", archived, _SKILL_ARCHIVE_FIELDS),
        ("archive replay", replay, _SKILL_ARCHIVE_FIELDS),
        ("list after", after, frozenset({"skills"})),
    ):
        _check_public_payload(failures, label, response, expected_fields)
    _check_public_payload(failures, "stale version", stale)

    def find_skill(response: httpx.Response) -> dict[str, object] | None:
        if response.status_code != 200:
            return None
        skills = _list_field(_object(response), "skills")
        if any(not isinstance(item, dict) or set(item) != _SKILL_VIEW_FIELDS for item in skills):
            failures.append("list: a SkillView did not match the minimized closed schema")
        return next(
            (item for item in skills if isinstance(item, dict) and item.get("slug") == skill_slug),
            None,
        )

    listed = find_skill(listing)
    if listed is None:
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
            body.get("slug") != skill_slug
            or body.get("status") != "active"
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
        if (
            body.get("slug") != skill_slug
            or body.get("status") != "archived"
            or body.get("version") != initial_version + 2
        ):
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
        expected_replay = {**archive_body, "replayed": True}
        if replay_body != expected_replay:
            failures.append("archive replay: complete original result changed beyond replayed flag")
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
    captured = capsys.readouterr()
    captured_logs = f"{caplog.text}\n{captured.out}\n{captured.err}"
    _check_secret_values(
        failures,
        "skill public surfaces",
        (
            created,
            listing,
            validated,
            listed_after_validation,
            archived,
            replay,
            stale,
            after,
        ),
        captured_logs,
        {procedure_secret},
    )
    assert not failures, "\n".join(failures)


async def test_viewer_curator_and_platform_owner_cannot_mutate_project_directory(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("directory-deny")
    project_id = await harness.setup_project(slug, [("general", 0)])
    marker = unique_slug("denied")
    seed_skill_slug = unique_slug("deny-control-skill")
    seed_skill_version = 5
    async with harness.sm() as session:
        dependency_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == _uuid(project_id), models.Topic.slug == "general"
            )
        )
    dependency = str(dependency_id or uuid.uuid4())
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
        seed_person = await client.post(
            f"/api/v1/admin/persons?project={slug}",
            headers=admin,
            json={"name": "Mutation control person", "topics": ["general"], "language": "en"},
        )
        seed_person_id = _string_field(_object(seed_person), "person_id") or str(uuid.uuid4())
        seed_skill_markdown = serialize_skill(
            SkillFrontmatter(
                slug=seed_skill_slug,
                title="Mutation control skill",
                tags=["general"],
                depends_on=[dependency],
                state="proposed",
                version=seed_skill_version,
            ),
            "Control body",
        )
        seed_skill = await client.post(
            f"/api/v1/admin/skills?project={slug}",
            headers=admin,
            json={"markdown": seed_skill_markdown},
        )
        seed_person_before = await _person_db_state(harness, seed_person_id)
        seed_skill_before = await _skill_db_state(harness, project_id, seed_skill_slug)
        counts_before = await _project_resource_counts(harness, project_id)
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
            denials[f"{actor}/person-create"] = await client.post(
                f"/api/v1/admin/persons?project={slug}",
                headers=actor_headers,
                json={"name": person_name, "topics": ["general"]},
            )
            denials[f"{actor}/person-patch"] = await client.patch(
                f"/api/v1/admin/persons/{seed_person_id}?project={slug}",
                headers=actor_headers,
                json={"language": f"denied-{actor}", "expected_version": 1},
            )
            denials[f"{actor}/person-delete"] = await client.delete(
                f"/api/v1/admin/persons/{seed_person_id}",
                headers=actor_headers,
                params={"project": slug, "expected_version": 1},
            )
            denials[f"{actor}/skill-create"] = await client.post(
                f"/api/v1/admin/skills?project={slug}",
                headers=actor_headers,
                json={"markdown": skill},
            )
            denials[f"{actor}/skill-validate"] = await client.post(
                f"/api/v1/admin/skills/{seed_skill_slug}/validate?project={slug}",
                headers=actor_headers,
                json={"expected_version": seed_skill_version},
            )
            denials[f"{actor}/skill-archive"] = await client.post(
                f"/api/v1/admin/skills/{seed_skill_slug}/archive?project={slug}",
                headers={
                    **actor_headers,
                    "Idempotency-Key": f"deny-archive-{actor}",
                },
                json={"expected_version": seed_skill_version},
            )
            denials[f"{actor}/hunt-ask"] = await client.post(
                f"/api/v1/admin/hunts/ask?project={slug}",
                headers=actor_headers,
                json={"question": question, "topics": ["general"]},
            )
        seed_person_after = await _person_db_state(harness, seed_person_id)
        seed_skill_after = await _skill_db_state(harness, project_id, seed_skill_slug)
        counts_after = await _project_resource_counts(harness, project_id)
        persons_after = await client.get(f"/api/v1/admin/persons?project={slug}", headers=admin)
        skills_after = await client.get(f"/api/v1/admin/skills?project={slug}", headers=admin)
        hunts_after = await client.get(f"/api/v1/admin/hunts?project={slug}", headers=admin)

    failures: list[str] = []
    _status(failures, "seed person", seed_person, 201)
    _status(failures, "seed skill", seed_skill, 201)
    if dependency_id is None:
        failures.append("fixture: deny-control skill dependency is not authoritative")
    if seed_person_before is None or seed_skill_before is None:
        failures.append("fixture: mutation-control seed was not persisted")
    failures.extend(
        f"{label}: expected 403, got {response.status_code}; {_safe_shape(response)}"
        for label, response in denials.items()
        if response.status_code != 403
    )
    for label, response in (
        ("persons after", persons_after),
        ("skills after", skills_after),
        ("hunts after", hunts_after),
    ):
        _status(failures, label, response, 200)
    if seed_person_after != seed_person_before:
        failures.append("postcondition: a denied Person mutation changed or deleted its seed")
    if seed_skill_after != seed_skill_before:
        failures.append("postcondition: a denied Skill mutation changed or deleted its seed")
    if counts_after != counts_before:
        failures.append("postcondition: denied mutations changed project resource counts")
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
