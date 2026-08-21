"""Learning Layer correct_knowledge (SPEC-08 §3.5/3.6, AC 2-6/10) against the real container."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import select

from rsc_brain.knowledge.corrections import CorrectionService
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("pricing", 0), ("hr", 3)]


async def _make_user(harness: Harness) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('owner')}@example.com", status="active")
    )
    return user.user_id


async def _make_person(harness: Harness, project: str, user_id: str, topics: list[str]) -> None:
    async with harness.sm() as session:
        session.add(
            models.Person(
                project_id=uuid.UUID(project),
                user_id=uuid.UUID(user_id),
                name="Owner",
                topics=topics,
            )
        )
        await session.commit()


async def _insert_claim(
    harness: Harness, project: str, *, text: str, tags: list[str], credibility: float
) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project),
            text=text,
            subject="Acme pricing",
            credibility=credibility,
            tags=tags,
        )
        session.add(claim)
        await session.flush()
        cid = str(claim.id)
        await session.commit()
    return cid


def _scope(
    project: str,
    user_id: str,
    principal_type: PrincipalType = PrincipalType.HUMAN,
    *,
    topics: tuple[str, ...] = ("pricing", "hr"),
) -> ProjectScope:
    """A caller with topic authority over this file's claims.

    A claim outside the caller's topic visibility is neither readable nor mutable and answers exactly
    like a nonexistent one (AUDIT-036 / R06), so a scope with no topic authority would exercise that
    refusal instead of the correction behaviour under test.
    """
    return Principal(id=user_id, type=principal_type, allowed_topics=frozenset(topics)).scope_for(
        project
    )


def _service(harness: Harness) -> CorrectionService:
    return CorrectionService(
        store=KnowledgeStore(harness.sm), graph=AgeGraphStore(harness.sm), gateway=harness.gateway
    )


async def test_owner_correction_supersedes_and_can_revert(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    store = KnowledgeStore(harness.sm)
    scope = _scope(project, owner)
    async with harness.sm() as session:
        topic_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == uuid.UUID(project), models.Topic.slug == "pricing"
            )
        )
    assert topic_id is not None
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(
            slug="correction-hook",
            title="Correction hook",
            tags=["pricing"],
            depends_on=[str(topic_id)],
            state="active",
        ),
        "body",
    )

    outcome = await _service(harness).correct(
        scope, claim_id=claim, correction="The price is 120 EUR"
    )
    assert outcome.status == "applied"
    old = await store.get_claim(scope, claim)
    new = await store.get_claim(scope, outcome.new_claim_id or "")
    assert old is not None and old.valid_to is not None and old.credibility == pytest.approx(0.1)
    assert new is not None and new.credibility == pytest.approx(0.9) and "pricing" in new.tags
    assert (await SkillStore(harness.sm).get(scope, "correction-hook")).stale is True  # type: ignore[union-attr]

    # Revert restores the old claim (active again, credibility back to 0.6).
    revert = await _service(harness).revert(scope, outcome.correction_id or "")
    assert revert.status == "reverted"
    restored = await store.get_claim(scope, claim)
    assert restored is not None and restored.valid_to is None
    assert restored.credibility == pytest.approx(0.6)


async def test_non_owner_is_routed(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    stranger = await _make_user(harness)  # no Person → owns nothing
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    scope = _scope(project, stranger)
    outcome = await _service(harness).correct(scope, claim_id=claim, correction="wrong")
    assert outcome.status == "routed_to_owner"
    # Nothing changed.
    unchanged = await KnowledgeStore(harness.sm).get_claim(scope, claim)
    assert unchanged is not None and unchanged.valid_to is None and unchanged.credibility == 0.6


async def test_agent_never_corrects(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])  # even a would-be owner agent
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    agent_scope = _scope(project, owner, PrincipalType.AGENT)
    outcome = await _service(harness).correct(agent_scope, claim_id=claim, correction="x")
    assert outcome.status == "routed_to_owner"
    unchanged = await KnowledgeStore(harness.sm).get_claim(agent_scope, claim)
    assert unchanged is not None and unchanged.valid_to is None


async def test_sensitive_correction_pends(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["hr"])
    claim = await _insert_claim(
        harness, project, text="Salary band is B", tags=["hr"], credibility=0.6
    )
    scope = _scope(project, owner)
    outcome = await _service(harness).correct(scope, claim_id=claim, correction="Salary band is C")
    assert outcome.status == "pending_confirmation"
    # The old (sensitive) claim is NOT superseded until a second owner confirms.
    old = await KnowledgeStore(harness.sm).get_claim(scope, claim)
    assert old is not None and old.valid_to is None
    async with harness.sm() as session:
        new = await session.get(models.Claim, uuid.UUID(outcome.new_claim_id or ""))
        assert new is not None and new.pending_confirmation is True


async def test_dry_run_mutates_nothing(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    scope = _scope(project, owner)
    outcome = await _service(harness).correct(
        scope, claim_id=claim, correction="The price is 120 EUR", dry_run=True
    )
    assert outcome.status == "applied" and "dry-run" in outcome.explanation
    unchanged = await KnowledgeStore(harness.sm).get_claim(scope, claim)
    assert unchanged is not None and unchanged.valid_to is None and unchanged.credibility == 0.6
