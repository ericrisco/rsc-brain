"""Skills over MCP + FR-4.4 guardrail + stale notification (SPEC-20) against the real container.

list_skills / run_skill respect tag visibility (a caller without the tag sees nothing —
indistinguishable from nonexistent). The guardrail drops a deliberately mislabeled fragment,
flags its chunk needs_review, and audits an admin alert. A knowledge change on a depended-on
entity marks the skill stale and notifies its owner exactly once.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import RecallConfig
from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.mcp.tools import do_list_skills, do_run_skill
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.staleness import mark_stale_and_notify
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0), ("general", 0)]


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(tau=0.0, hybrid_enabled=True),
    )


class FakeClassifier:
    def __init__(self, verdict: str | None) -> None:
        self._verdict = verdict

    async def classify_many(
        self, texts: Sequence[str], candidate_topics: Sequence[str]
    ) -> Sequence[str | None]:
        return [self._verdict] * len(texts)


async def _seed_chunk_claim(harness: Harness, project_id: str, text: str, tags: list[str]) -> str:
    embedding = (await harness.gateway.embed([text]))[0]
    async with harness.sm() as session:
        doc = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id=f"s-{uuid.uuid4().hex[:8]}",
            checksum=f"s-{uuid.uuid4().hex}",
            status="processed",
        )
        session.add(doc)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project_id),
            document_id=doc.id,
            kind="prose",
            text=text,
            tags=tags,
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        chunk_id = str(chunk.id)
        session.add(
            models.Claim(
                project_id=uuid.UUID(project_id),
                chunk_id=chunk.id,
                text=text,
                tags=tags,
                credibility=0.6,
                embedding=embedding,
            )
        )
        await session.commit()
        return chunk_id


async def test_list_and_run_respect_tag_visibility(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    admin = harness.scope(project_id, allowed_topics=["hr", "general"])
    await SkillStore(harness.sm).create(
        admin, SkillFrontmatter(slug="onboard", title="Onboard", tags=["hr"]), "## Do this\n"
    )
    retriever = _retriever(harness)

    with_hr = harness.scope(project_id, allowed_topics=["hr"])
    without = harness.scope(project_id, allowed_topics=["general"])
    assert [s.slug for s in (await do_list_skills(harness.sm, with_hr)).skills] == ["onboard"]
    assert (await do_list_skills(harness.sm, without)).skills == []

    ran = await do_run_skill(retriever, harness.sm, with_hr, slug="onboard")
    assert ran.found and ran.instructions == "## Do this\n"
    # A caller without the tag: indistinguishable from nonexistent (FR-4.3).
    denied = await do_run_skill(retriever, harness.sm, without, slug="onboard")
    assert denied.found is False


async def test_guardrail_drops_mislabeled_fragment(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    chunk_id = await _seed_chunk_claim(harness, project_id, "leaked salary data", ["hr"])
    async with harness.sm() as session:
        topic_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == uuid.UUID(project_id), models.Topic.slug == "hr"
            )
        )
    assert topic_id is not None
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(slug="pay", title="Payroll", tags=["hr"], depends_on=[str(topic_id)]),
        "body",
    )
    # The classifier says the (hr-tagged) fragment is really 'general' — a topic this caller lacks.
    ran = await do_run_skill(
        _retriever(harness), harness.sm, scope, slug="pay", classifier=FakeClassifier("general")
    )
    assert ran.found and ran.context_fragments == []  # the mislabeled fragment was dropped
    async with harness.sm() as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
        assert chunk is not None and chunk.needs_review is True  # flagged for review
        alerts = await session.scalar(
            select(func.count())
            .select_from(models.AuditLog)
            .where(
                models.AuditLog.project_id == uuid.UUID(project_id),
                models.AuditLog.action == "guardrail:dropped_mislabeled",
            )
        )
        assert int(alerts or 0) >= 1  # admin alert audited


async def test_stale_notifies_owner_once(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope, name="Owner", channels={"email": "o@x"}, topics=["hr"]
    )
    entity_id = str(uuid.uuid4())
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(slug="policy", title="Policy", tags=["hr"], depends_on=[entity_id]),
        "body",
        owner_person_id=owner_id,
    )
    channel = NullChannel()
    newly = await mark_stale_and_notify(
        harness.sm, scope, [entity_id], reason="claim corrected", channel=channel
    )
    assert newly == ["policy"] and len(channel.sent) == 1 and channel.sent[0].to == "o@x"
    # Re-running notifies nobody (idempotent — FR-7.2 "exactly one").
    again = await mark_stale_and_notify(
        harness.sm, scope, [entity_id], reason="claim corrected", channel=channel
    )
    assert again == [] and len(channel.sent) == 1
