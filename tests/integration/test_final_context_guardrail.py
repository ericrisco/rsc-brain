"""AUDIT-016 production-serving, alert, tenant and degraded-mode evidence."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Sequence
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from rsc_brain import audit as audit_mod
from rsc_brain.config.models import RecallConfig
from rsc_brain.hunting.channels import NullChannel, OutboundMessage
from rsc_brain.identity.service import IdentityService
from rsc_brain.mcp.server import build_mcp_server
from rsc_brain.mcp.tools import do_recall
from rsc_brain.observability.product import product_metrics
from rsc_brain.recall.guardrail_alerts import GuardrailAlertService
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


class Verdicts:
    def __init__(self, values: Sequence[str | None]) -> None:
        self.values = values

    async def classify_many(
        self, texts: Sequence[str], candidate_topics: Sequence[str]
    ) -> Sequence[str | None]:
        return self.values


class FailedChannel:
    name = "smtp"

    async def send(self, message: OutboundMessage) -> None:
        raise RuntimeError("injected delivery failure")


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(tau=0.0),
    )


async def _seed_claim(harness: Harness, project_id: str, text: str) -> tuple[str, str]:
    embedding = (await harness.gateway.embed([text]))[0]
    async with harness.sm() as session:
        document = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id=unique_slug("guardrail"),
            checksum=uuid.uuid4().hex,
            status="processed",
            doc_tags=["hr"],
        )
        session.add(document)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project_id),
            document_id=document.id,
            kind="prose",
            text=text,
            tags=["hr"],
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            chunk_id=chunk.id,
            text=text,
            tags=["hr"],
            credibility=0.8,
            embedding=embedding,
        )
        session.add(claim)
        await session.commit()
        return str(claim.id), str(chunk.id)


async def _seed_claimless_chunk(harness: Harness, project_id: str, text: str) -> str:
    embedding = (await harness.gateway.embed([text]))[0]
    async with harness.sm() as session:
        document = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id=unique_slug("claimless"),
            checksum=uuid.uuid4().hex,
            status="processed",
            doc_tags=["hr"],
        )
        session.add(document)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project_id),
            document_id=document.id,
            kind="prose",
            text=text,
            tags=["hr"],
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.commit()
        return str(chunk.id)


async def _add_admin(harness: Harness, project_id: str, email: str) -> None:
    user = await PgRelationalStore(harness.sm).users().create_user(email=email, status="active")
    await IdentityService(harness.sm).add_membership(
        user.user_id, project_id, role="project-admin", allowed_topics=("hr", "finance")
    )


async def _admin_pat(harness: Harness, project_id: str, email: str) -> str:
    user = await PgRelationalStore(harness.sm).users().create_user(email=email, status="active")
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id,
        project_id,
        role="project-admin",
        allowed_topics=("hr",),
        can_curate=True,
    )
    return (await identity.issue_pat(membership)).token


def _context(token: str) -> SimpleNamespace:
    return SimpleNamespace(
        request_context=SimpleNamespace(
            request=SimpleNamespace(headers={"authorization": f"Bearer {token}"})
        )
    )


async def test_recall_blocks_marks_alerts_and_abstains(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("finance", 0), ("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    claim_id, chunk_id = await _seed_claim(harness, project, "payroll guardrail exact")
    admin_email = f"{unique_slug('admin')}@example.test"
    await _add_admin(harness, project, admin_email)
    channel = NullChannel()

    output = await do_recall(
        _retriever(harness),
        harness.sm,
        scope,
        query="payroll guardrail exact",
        classifier=Verdicts(["finance"]),
        guardrail_alerts=GuardrailAlertService(harness.sm, channel=channel, can_deliver=True),
    )

    assert output.found is False and output.fragments == []
    assert len(channel.sent) == 1
    assert channel.sent[0].to == admin_email
    assert claim_id not in channel.sent[0].body
    async with harness.sm() as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
        actions = list(
            await session.scalars(
                select(models.AuditLog.action).where(
                    models.AuditLog.project_id == uuid.UUID(project)
                )
            )
        )
    assert chunk is not None and chunk.needs_review is True
    assert "guardrail:screened" in actions
    assert "guardrail:admin_alerted" in actions
    metrics = await product_metrics(harness.sm, scope)
    assert metrics["health"]["guardrail_p95_ms"] is not None  # type: ignore[index]


async def test_alert_dedupe_is_concurrent_and_cross_project_safe(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    foreign = await harness.setup_project(unique_slug("foreign"), [("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    own_claim, _ = await _seed_claim(harness, project, "own")
    foreign_claim, foreign_chunk = await _seed_claim(harness, foreign, "foreign")
    suffix = uuid.uuid4().hex[:8]
    await _add_admin(harness, project, f"z-admin-{suffix}@example.test")
    await _add_admin(harness, project, f"a-admin-{suffix}@example.test")
    channel = NullChannel()
    alerts = GuardrailAlertService(harness.sm, channel=channel, can_deliver=True)

    results = await asyncio.gather(
        *(
            alerts.notify(
                scope,
                [own_claim, foreign_claim],
                chunk_ids=[foreign_chunk],
                reason="mislabeled",
            )
            for _ in range(4)
        )
    )

    assert results.count(True) == 1
    assert await alerts.notify(scope, [own_claim], reason="mislabeled") is False
    assert len(channel.sent) == 1
    assert channel.sent[0].to == f"a-admin-{suffix}@example.test"
    assert own_claim not in channel.sent[0].body
    assert foreign_claim not in channel.sent[0].body
    async with harness.sm() as session:
        foreign_row = await session.get(models.Chunk, uuid.UUID(foreign_chunk))
        alerted = await session.scalar(
            select(func.count())
            .select_from(models.AuditLog)
            .where(
                models.AuditLog.project_id == uuid.UUID(project),
                models.AuditLog.action == "guardrail:admin_alerted",
            )
        )
    assert foreign_row is not None and foreign_row.needs_review is False
    assert alerted == 1


async def test_claimless_fragment_is_still_reviewed_and_alerted(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("claimless"), [("finance", 0), ("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    chunk_id = await _seed_claimless_chunk(harness, project, "claimless blocked context")
    await _add_admin(harness, project, f"{unique_slug('claimless-admin')}@example.test")
    channel = NullChannel()

    output = await do_recall(
        _retriever(harness),
        harness.sm,
        scope,
        query="claimless blocked context",
        classifier=Verdicts(["finance"]),
        guardrail_alerts=GuardrailAlertService(harness.sm, channel=channel, can_deliver=True),
    )

    assert output.found is False and output.fragments == []
    assert len(channel.sent) == 1
    async with harness.sm() as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
    assert chunk is not None and chunk.needs_review is True


async def test_alert_failure_is_audited_without_becoming_success(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    claim_id, _ = await _seed_claim(harness, project, "failed alert")
    await _add_admin(harness, project, f"{unique_slug('admin')}@example.test")
    alerts = GuardrailAlertService(harness.sm, channel=FailedChannel(), can_deliver=True)

    assert await alerts.notify(scope, [claim_id], reason="inconclusive") is False
    async with harness.sm() as session:
        failures = await session.scalar(
            select(func.count())
            .select_from(models.AuditLog)
            .where(
                models.AuditLog.project_id == uuid.UUID(project),
                models.AuditLog.action == "guardrail:alert_failed",
            )
        )
    assert failures == 1


async def test_unconfigured_alert_route_is_explicitly_audited(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("unconfigured"), [("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    claim_id, _ = await _seed_claim(harness, project, "unconfigured alert")

    assert (
        await GuardrailAlertService(harness.sm).notify(scope, [claim_id], reason="inconclusive")
        is False
    )
    async with harness.sm() as session:
        unavailable = await session.scalar(
            select(func.count())
            .select_from(models.AuditLog)
            .where(
                models.AuditLog.project_id == uuid.UUID(project),
                models.AuditLog.action == "guardrail:alert_unavailable",
            )
        )
    assert unavailable == 1


async def test_guardrail_latency_p95_is_separate_and_exact(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("latency"), [("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    for duration_ms in (10, 20, 30, 40):
        await audit_mod.record_audit(
            harness.sm,
            scope,
            action="guardrail:screened",
            tool="guardrail",
            duration_ms=duration_ms,
        )

    metrics = await product_metrics(harness.sm, scope)

    assert metrics["health"]["guardrail_p95_ms"] == pytest.approx(38.5)  # type: ignore[index]
    assert metrics["health"]["recall_p95_ms"] is None  # type: ignore[index]
    assert metrics["health"]["guardrail_p95_ms"] < 4_000  # type: ignore[index]


async def test_real_mcp_recall_and_skill_have_no_guardrail_opt_out(
    build_harness: Callable[..., Harness], make_completion: Callable[..., Any]
) -> None:
    seen_schemas: list[str] = []
    completion = make_completion(tags=["hr"], guardrail_topic="finance")

    async def recording_completion(**kwargs: Any) -> Any:
        seen_schemas.append(getattr(kwargs.get("response_format"), "__name__", ""))
        return await completion(**kwargs)

    harness = build_harness(completion=recording_completion)
    project = await harness.setup_project(unique_slug("mcp"), [("finance", 0), ("hr", 0)])
    scope = harness.scope(project, allowed_topics=["hr"])
    token = await _admin_pat(harness, project, f"{unique_slug('mcp-admin')}@example.test")
    channel = NullChannel()
    alerts = GuardrailAlertService(harness.sm, channel=channel, can_deliver=True)
    server = build_mcp_server(
        sessionmaker=harness.sm,
        retriever=_retriever(harness),
        gateway=harness.gateway,
        guardrail_alerts=alerts,
    )
    context = _context(token)

    await _seed_claim(harness, project, "payroll production skill")
    # AUDIT-017: a skill's context comes only from its declared dependencies, so the skill has to
    # depend on the hr topic for the seeded fragment to be eligible at all. Without it there is no
    # context to screen and this test would pass while proving nothing about the guardrail.
    async with harness.sm() as session:
        hr_topic_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == uuid.UUID(project), models.Topic.slug == "hr"
            )
        )
    assert hr_topic_id is not None
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(
            slug="payroll",
            title="payroll production skill",
            tags=["hr"],
            depends_on=[str(hr_topic_id)],
        ),
        "authorized instructions",
    )
    skill_output = await server._tool_manager.get_tool("run_skill").fn(  # type: ignore[union-attr]
        slug="payroll", ctx=context
    )
    await _seed_claim(harness, project, "payroll production recall")
    recall_output = await server._tool_manager.get_tool("recall").fn(  # type: ignore[union-attr]
        query="payroll production recall", ctx=context
    )

    assert skill_output.found is True and skill_output.context_fragments == []
    assert recall_output.found is False and recall_output.fragments == []
    assert seen_schemas.count("GuardrailClassification") == 2
    assert len(channel.sent) == 2


async def test_real_mcp_classifier_outage_is_a_safe_abstention(
    build_harness: Callable[..., Harness],
) -> None:
    async def unavailable_completion(**kwargs: Any) -> Any:
        raise TimeoutError("provider details must not cross the boundary")

    harness = build_harness(completion=unavailable_completion)
    project = await harness.setup_project(unique_slug("outage"), [("hr", 0)])
    token = await _admin_pat(harness, project, f"{unique_slug('outage-admin')}@example.test")
    _, chunk_id = await _seed_claim(harness, project, "outage final context")
    channel = NullChannel()
    server = build_mcp_server(
        sessionmaker=harness.sm,
        retriever=_retriever(harness),
        gateway=harness.gateway,
        guardrail_alerts=GuardrailAlertService(harness.sm, channel=channel, can_deliver=True),
    )

    output = await server._tool_manager.get_tool("recall").fn(  # type: ignore[union-attr]
        query="outage final context", ctx=_context(token)
    )

    assert output.found is False and output.fragments == []
    assert len(channel.sent) == 1 and "inconclusive" in channel.sent[0].body
    async with harness.sm() as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
    assert chunk is not None and chunk.needs_review is True


async def test_real_mcp_delegation_uses_effective_topic_intersection(
    build_harness: Callable[..., Harness], make_completion: Callable[..., Any]
) -> None:
    harness = build_harness(completion=make_completion(tags=["hr"], guardrail_topic="finance"))
    project = await harness.setup_project(unique_slug("delegated"), [("finance", 0), ("hr", 0)])
    identity = IdentityService(harness.sm)
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('delegate')}@example.test", status="active")
    )
    await identity.add_membership(
        user.user_id,
        project,
        role="project-admin",
        allowed_topics=("hr",),
        can_curate=True,
    )
    agent_id = await identity.create_agent(
        project,
        user.user_id,
        "guardrail-agent",
        allowed_topics=("finance", "hr"),
    )
    agent_token = (await identity.issue_agent_pat(agent_id)).token
    await _seed_claim(harness, project, "delegated guardrail exact")
    channel = NullChannel()
    server = build_mcp_server(
        sessionmaker=harness.sm,
        retriever=_retriever(harness),
        gateway=harness.gateway,
        guardrail_alerts=GuardrailAlertService(harness.sm, channel=channel, can_deliver=True),
    )

    direct = await server._tool_manager.get_tool("recall").fn(  # type: ignore[union-attr]
        query="delegated guardrail exact", ctx=_context(agent_token)
    )
    delegated = await server._tool_manager.get_tool("recall").fn(  # type: ignore[union-attr]
        query="delegated guardrail exact",
        ctx=_context(agent_token),
        on_behalf_of=user.user_id,
    )

    assert direct.found is True and direct.fragments
    assert delegated.found is False and delegated.fragments == []
    assert len(channel.sent) == 1
