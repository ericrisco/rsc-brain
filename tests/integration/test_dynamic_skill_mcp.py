"""Authenticated dynamic skill discovery and invocation over the real MCP transport."""

from __future__ import annotations

import gc
import json
import uuid
import warnings
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, cast

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.config.models import RecallConfig
from rsc_brain.identity.service import IdentityService
from rsc_brain.ingest.chunker import approx_tokens
from rsc_brain.ingest.entity_resolution import entity_id
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.conftest import canned_completion

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0), ("hr", 3)]


async def _mint_pat(harness: Harness, project_id: str, topics: tuple[str, ...]) -> tuple[str, str]:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('dynamic')}@example.com", status="active")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(user.user_id, project_id, allowed_topics=topics)
    return (await identity.issue_pat(membership)).token, user.user_id


def _payload(response: httpx.Response) -> dict[str, Any]:
    for line in reversed(response.text.splitlines()):
        if line.startswith("data: "):
            return cast("dict[str, Any]", json.loads(line.removeprefix("data: ")))
    return cast("dict[str, Any]", response.json())


async def _rpc(
    client: httpx.AsyncClient,
    token: str,
    method: str,
    params: dict[str, object] | None = None,
    *,
    request_id: int = 1,
    on_behalf_of: str | None = None,
) -> dict[str, Any]:
    headers = {
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if on_behalf_of is not None:
        headers["X-RSC-On-Behalf-Of"] = on_behalf_of
    response = await client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    payload = _payload(response)
    await response.aclose()
    del response
    _collect_mcp_streams()
    return payload


async def _initialize(client: httpx.AsyncClient, token: str) -> None:
    payload = await _rpc(
        client,
        token,
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "dynamic-skill-test", "version": "1.0"},
        },
    )
    assert "result" in payload


async def _list_tools(
    client: httpx.AsyncClient,
    token: str,
    *,
    request_id: int,
    on_behalf_of: str | None = None,
) -> dict[str, dict[str, Any]]:
    listed = await _rpc(
        client,
        token,
        "tools/list",
        request_id=request_id,
        on_behalf_of=on_behalf_of,
    )
    return {tool["name"]: tool for tool in listed["result"]["tools"]}


async def _call_tool(
    client: httpx.AsyncClient,
    token: str,
    name: str,
    arguments: dict[str, object] | None = None,
    *,
    request_id: int,
    on_behalf_of: str | None = None,
) -> dict[str, Any]:
    return await _rpc(
        client,
        token,
        "tools/call",
        {"name": name, "arguments": arguments or {}},
        request_id=request_id,
        on_behalf_of=on_behalf_of,
    )


def _structured(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload["result"]
    assert result.get("isError") is not True, result
    return cast("dict[str, Any]", result["structuredContent"])


def _collect_mcp_streams() -> None:
    """Collect the SDK's completed SSE receive streams under its known warning."""
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore", message=r"Unclosed <MemoryObjectReceiveStream.*", category=ResourceWarning
        )
        gc.collect()


@asynccontextmanager
async def _mcp_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    try:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
            ) as client,
        ):
            yield client
    finally:
        _collect_mcp_streams()


def _app(harness: Harness, *, answer_token_budget: int = 2_000) -> FastAPI:
    return create_app(
        deps=ApiDeps(
            sessionmaker=harness.sm,
            gateway=harness.gateway,
            recall_config=RecallConfig(
                tau=0.0,
                k_hop=0,
                hybrid_enabled=False,
                answer_token_budget=answer_token_budget,
            ),
        )
    )


async def _seed_chunk_claim(
    harness: Harness,
    project_id: str,
    *,
    text: str,
    tags: list[str],
    subject_key: uuid.UUID | None = None,
) -> tuple[str, str]:
    embedding = (await harness.gateway.embed([text]))[0]
    async with harness.sm() as session:
        document = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id=f"dynamic-{uuid.uuid4().hex}",
            checksum=uuid.uuid4().hex,
            title=f"Source {text[:24]}",
            status="processed",
            doc_tags=tags,
        )
        session.add(document)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project_id),
            document_id=document.id,
            page=1,
            kind="prose",
            text=text,
            tags=tags,
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            chunk_id=chunk.id,
            source_document_id=document.id,
            text=text,
            subject="Dependency" if subject_key else None,
            predicate="states" if subject_key else None,
            object="Evidence" if subject_key else None,
            subject_entity_key=subject_key,
            tags=tags,
            credibility=0.8,
            embedding=embedding,
            pending_confirmation=False,
        )
        session.add(claim)
        await session.commit()
        return str(chunk.id), str(claim.id)


async def test_tools_list_discovers_only_the_visible_active_dynamic_skill(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("dynamic"), TOPICS)
    admin = harness.scope(project_id, allowed_topics=["general", "engineering", "hr"])
    store = SkillStore(harness.sm)
    await store.create(
        admin,
        SkillFrontmatter(slug="visible", title="Visible", tags=["general"], state="active"),
        "visible instructions",
    )
    await store.create(
        admin,
        SkillFrontmatter(
            slug="authority-general",
            title="Authority general",
            tags=["general"],
            state="active",
        ),
        "general instructions",
    )
    await store.create(
        admin,
        SkillFrontmatter(slug="hidden", title="Hidden", tags=["hr"], state="active"),
        "hidden instructions",
    )
    await store.create(
        admin,
        SkillFrontmatter(slug="draft", title="Draft", tags=["general"], state="proposed"),
        "draft instructions",
    )
    await store.create(
        admin,
        SkillFrontmatter(
            slug="partial", title="Partial", tags=["general", "engineering"], state="active"
        ),
        "partial instructions",
    )
    foreign_project = await harness.setup_project(unique_slug("foreign"), TOPICS)
    await store.create(
        harness.scope(foreign_project, allowed_topics=["general"]),
        SkillFrontmatter(slug="foreign", title="Foreign", tags=["general"], state="active"),
        "foreign instructions",
    )
    token, user_id = await _mint_pat(harness, project_id, ("general",))
    app = _app(harness)

    async with _mcp_client(app) as client:
        await _initialize(client, token)
        tools = await _list_tools(client, token, request_id=2)
        hidden = _structured(await _call_tool(client, token, "skill_hidden", request_id=3))
        absent = _structured(await _call_tool(client, token, "skill_does-not-exist", request_id=4))
        foreign_dynamic = _structured(
            await _call_tool(client, token, "skill_foreign", request_id=9)
        )
        foreign_generic = _structured(
            await _call_tool(client, token, "run_skill", {"slug": "foreign"}, request_id=10)
        )

        await store.set_state(admin, "visible", "archived")
        await store.create(
            admin,
            SkillFrontmatter(
                slug="created-later", title="Created later", tags=["general"], state="active"
            ),
            "new instructions",
        )
        refreshed = await _list_tools(client, token, request_id=5)
        stale_call = _structured(await _call_tool(client, token, "skill_visible", request_id=6))
        created = await store.get(admin, "created-later")
        assert created is not None
        await store.update(
            admin,
            "created-later",
            SkillFrontmatter(
                slug="created-later",
                title="Created later",
                tags=["engineering"],
                state="active",
                version=created.version,
            ),
            "new instructions",
        )
        retagged = await _list_tools(client, token, request_id=7)
        async with harness.sm() as session:
            await session.execute(
                update(models.ProjectMembership)
                .where(
                    models.ProjectMembership.project_id == uuid.UUID(project_id),
                    models.ProjectMembership.user_id == uuid.UUID(user_id),
                )
                .values(allowed_topics=["engineering"])
            )
            await session.commit()
        authority_refreshed = await _list_tools(client, token, request_id=8)

    assert "skill_visible" in tools
    assert "skill_hidden" not in tools
    assert "skill_draft" not in tools
    assert "skill_partial" not in tools
    assert "skill_foreign" not in tools
    assert tools["skill_visible"]["outputSchema"] == {**tools["run_skill"]["outputSchema"]}
    assert set(tools["skill_visible"]["inputSchema"]["properties"]) == {
        "args",
        "on_behalf_of",
    }
    assert tools["skill_visible"]["inputSchema"]["additionalProperties"] is False
    assert hidden == absent == {"found": False, "instructions": "", "context_fragments": []}
    assert foreign_dynamic == foreign_generic == absent
    assert "skill_visible" not in refreshed
    assert "skill_created-later" in refreshed
    assert "skill_created-later" not in retagged
    assert "skill_created-later" in authority_refreshed
    assert "skill_authority-general" not in authority_refreshed
    assert stale_call == absent


async def test_generic_and_dynamic_invocation_share_dependency_context_and_audit(
    build_harness: Callable[..., Harness],
) -> None:
    # AUDIT-016 screens every skill context, so the classifier double has to agree with the
    # fragment's real topic; otherwise the guardrail correctly drops evidence this test needs.
    harness = build_harness(completion=canned_completion(guardrail_topic="general"))
    project_id = await harness.setup_project(unique_slug("equivalent"), TOPICS)
    admin = harness.scope(project_id, allowed_topics=["general", "engineering", "hr"])
    async with harness.sm() as session:
        canonical = models.Entity(
            project_id=uuid.UUID(project_id),
            name="Release Board",
            normalized_name="release board",
            type="team",
        )
        session.add(canonical)
        await session.flush()
        dependency = models.Entity(
            project_id=uuid.UUID(project_id),
            name="Release Committee",
            normalized_name="release committee",
            type="team",
            merged_into=canonical.id,
        )
        session.add(dependency)
        await session.flush()
        dependency_uuid = str(dependency.id)
        dependency_key = entity_id(canonical.type, canonical.name)
        await session.commit()

    _, related_claim = await _seed_chunk_claim(
        harness,
        project_id,
        text="The Release Board approves production launches.",
        tags=["general"],
        subject_key=dependency_key,
    )
    _, unrelated_claim = await _seed_chunk_claim(
        harness,
        project_id,
        text="The lunch menu changes every Tuesday.",
        tags=["general"],
        subject_key=entity_id("team", "Catering"),
    )
    await SkillStore(harness.sm).create(
        admin,
        SkillFrontmatter(
            slug="release",
            title="Release",
            tags=["general"],
            depends_on=[dependency_uuid],
            state="active",
        ),
        "## Follow the release checklist.",
    )
    foreign_project = await harness.setup_project(unique_slug("dependency-foreign"), TOPICS)
    async with harness.sm() as session:
        foreign_entity = models.Entity(
            project_id=uuid.UUID(foreign_project),
            name="Foreign Board",
            normalized_name="foreign board",
            type="team",
        )
        session.add(foreign_entity)
        await session.flush()
        foreign_dependency = str(foreign_entity.id)
        await session.commit()
    await SkillStore(harness.sm).create(
        admin,
        SkillFrontmatter(
            slug="ungrounded",
            title="Ungrounded",
            tags=["general"],
            depends_on=[foreign_dependency, str(uuid.uuid4())],
            state="active",
        ),
        "Instructions without authorized evidence.",
    )
    token, user_id = await _mint_pat(harness, project_id, ("general",))
    app = _app(harness, answer_token_budget=10_000)

    async with _mcp_client(app) as client:
        await _initialize(client, token)
        await _list_tools(client, token, request_id=2)
        generic = _structured(
            await _call_tool(
                client,
                token,
                "run_skill",
                {"slug": "release", "args": {"mode": "safe"}},
                request_id=3,
            )
        )
        dynamic = _structured(
            await _call_tool(
                client,
                token,
                "skill_release",
                {"args": {"mode": "safe"}},
                request_id=4,
            )
        )
        ungrounded = _structured(await _call_tool(client, token, "skill_ungrounded", request_id=5))
    assert dynamic == generic
    assert dynamic["found"] is True
    assert dynamic["instructions"] == "## Follow the release checklist."
    assert {claim for item in dynamic["context_fragments"] for claim in item["claim_ids"]} == {
        related_claim
    }
    assert unrelated_claim not in json.dumps(dynamic)
    assert all(item["content_type"] == "untrusted_data" for item in dynamic["context_fragments"])
    assert all(item["document"] for item in dynamic["context_fragments"])
    assert ungrounded == {
        "found": True,
        "instructions": "Instructions without authorized evidence.",
        "context_fragments": [],
    }

    async with harness.sm() as session:
        rows = (
            await session.execute(
                select(
                    models.AuditLog.tool,
                    models.AuditLog.principal_id,
                    models.AuditLog.denied,
                ).where(
                    models.AuditLog.project_id == uuid.UUID(project_id),
                    models.AuditLog.action == "run_skill",
                )
            )
        ).all()
    assert ("run_skill", user_id, False) in rows
    assert ("skill_release", user_id, False) in rows


async def test_topic_dependency_is_bounded_to_two_thousand_tokens_deterministically(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("budget"), TOPICS)
    admin = harness.scope(project_id, allowed_topics=["general"])
    async with harness.sm() as session:
        topic_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == uuid.UUID(project_id), models.Topic.slug == "general"
            )
        )
    assert topic_id is not None
    for index in range(3):
        await _seed_chunk_claim(
            harness,
            project_id,
            text=f"Evidence {index}: " + (f"word-{index} " * 900),
            tags=["general"],
        )
    await SkillStore(harness.sm).create(
        admin,
        SkillFrontmatter(
            slug="bounded",
            title="Bounded evidence",
            tags=["general"],
            depends_on=[str(topic_id)],
            state="active",
        ),
        "Use bounded evidence.",
    )
    token, _ = await _mint_pat(harness, project_id, ("general",))
    app = _app(harness, answer_token_budget=10_000)

    async with _mcp_client(app) as client:
        await _initialize(client, token)
        await _list_tools(client, token, request_id=2)
        first = _structured(await _call_tool(client, token, "skill_bounded", request_id=3))
        second = _structured(await _call_tool(client, token, "skill_bounded", request_id=4))
    fragments = first["context_fragments"]
    assert first == second
    assert fragments
    assert sum(approx_tokens(item["text"]) for item in fragments) <= 2_000
    assert all(item["claim_ids"] and item["document"] for item in fragments)


async def test_delegated_discovery_and_invocation_use_the_permission_intersection(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("delegated"), TOPICS)
    admin = harness.scope(project_id, allowed_topics=["general", "hr"])
    store = SkillStore(harness.sm)
    await store.create(
        admin,
        SkillFrontmatter(slug="general", title="General", tags=["general"], state="active"),
        "general body",
    )
    await store.create(
        admin,
        SkillFrontmatter(slug="payroll", title="Payroll", tags=["hr"], state="active"),
        "payroll body",
    )
    _, delegated_user_id = await _mint_pat(harness, project_id, ("general",))
    identity = IdentityService(harness.sm)
    owner = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('agent-owner')}@example.com", status="active")
    )
    agent_id = await identity.create_agent(
        project_id, owner.user_id, "delegated-agent", allowed_topics=("general", "hr")
    )
    agent_token = (await identity.issue_agent_pat(agent_id)).token
    app = _app(harness)

    async with _mcp_client(app) as client:
        await _initialize(client, agent_token)
        tools = await _list_tools(client, agent_token, request_id=2, on_behalf_of=delegated_user_id)
        hidden = _structured(
            await _call_tool(
                client,
                agent_token,
                "skill_payroll",
                {"on_behalf_of": delegated_user_id},
                request_id=3,
                on_behalf_of=delegated_user_id,
            )
        )
        absent = _structured(
            await _call_tool(
                client,
                agent_token,
                "skill_absent",
                {"on_behalf_of": delegated_user_id},
                request_id=4,
                on_behalf_of=delegated_user_id,
            )
        )
        visible_dynamic = _structured(
            await _call_tool(
                client,
                agent_token,
                "skill_general",
                {"on_behalf_of": delegated_user_id},
                request_id=5,
                on_behalf_of=delegated_user_id,
            )
        )
        visible_generic = _structured(
            await _call_tool(
                client,
                agent_token,
                "run_skill",
                {"slug": "general", "on_behalf_of": delegated_user_id},
                request_id=6,
                on_behalf_of=delegated_user_id,
            )
        )
        conflict = await _call_tool(
            client,
            agent_token,
            "skill_general",
            {"on_behalf_of": str(uuid.uuid4())},
            request_id=7,
            on_behalf_of=delegated_user_id,
        )
    assert "skill_general" in tools
    assert "skill_payroll" not in tools
    assert hidden == absent == {"found": False, "instructions": "", "context_fragments": []}
    assert (
        visible_dynamic
        == visible_generic
        == {
            "found": True,
            "instructions": "general body",
            "context_fragments": [],
        }
    )
    assert conflict["result"]["isError"] is True
    assert "AUTH_INVALID" in conflict["result"]["content"][0]["text"]
    async with harness.sm() as session:
        delegated_audits = (
            await session.execute(
                select(
                    models.AuditLog.tool,
                    models.AuditLog.principal_id,
                    models.AuditLog.on_behalf_of,
                    models.AuditLog.denied,
                ).where(
                    models.AuditLog.project_id == uuid.UUID(project_id),
                    models.AuditLog.action == "run_skill",
                )
            )
        ).all()
    assert ("skill_general", agent_id, delegated_user_id, False) in delegated_audits
    assert ("run_skill", agent_id, delegated_user_id, False) in delegated_audits
    assert ("skill_payroll", agent_id, delegated_user_id, True) in delegated_audits
