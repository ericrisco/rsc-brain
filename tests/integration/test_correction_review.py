"""CORRECTION_REVIEW hunts against the real container (SPEC-15, FR-15.6 / FR-15.3 b,c).

A non-owner's proposed correction becomes a review hunt to the tag owner: confirm applies it
(old superseded, corrected claim at 0.9), reject restores the claim (clears disputed), expire
leaves it disputed. No owner ⇒ NO_OWNER, claim disputed.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import select

from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.corrections_review import CorrectionReviewService
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntService
from rsc_brain.hunting.state_machine import HuntState
from rsc_brain.mcp.tools import do_correct_knowledge
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


def _scope(project_id: str) -> ProjectScope:
    """R06: a caller must hold the topic of the claim it acts on — a claim outside its visibility answers exactly like a nonexistent one."""
    return Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.HUMAN,
        can_curate=True,
        allowed_topics=frozenset({"hr", "general"}),
    ).scope_for(project_id)


async def _seed_claim(harness: Harness, project_id: str, text: str, tags: list[str]) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project_id), text=text, tags=tags, credibility=0.6
        )
        session.add(claim)
        await session.flush()
        cid = str(claim.id)
        await session.commit()
        return cid


async def _routed_correction(
    harness: Harness, scope: ProjectScope, claim_id: str, after: str
) -> str:
    return await KnowledgeStore(harness.sm).record_correction(
        scope,
        target_claim=claim_id,
        new_claim=None,
        author_id=None,
        on_behalf_of=None,
        role_applied="non_owner",
        status="routed_hunt",
        before_text="old",
        after_text=after,
        reason=None,
    )


async def _review_service(harness: Harness, project_id: str) -> CorrectionReviewService:
    await PersonDirectory(harness.sm).add(
        _scope(project_id), name="Owner", channels={"email": "o@x"}, topics=["hr"]
    )
    # A channel is what an install configures; without one the service cannot deliver and parks
    # every hunt (R28). The recorder is the test seam for a configured install.
    return CorrectionReviewService(harness.sm, hunts=HuntService(harness.sm, channel=NullChannel()))


async def test_confirm_applies_the_correction(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = _scope(project_id)
    claim_id = await _seed_claim(harness, project_id, "Old fact", ["hr"])
    correction_id = await _routed_correction(harness, scope, claim_id, "Corrected fact")
    review = await _review_service(harness, project_id)

    opened = await review.open_review(scope, correction_id)
    assert opened.state == HuntState.AWAITING_ANSWER
    confirmed = await review.confirm(scope, opened.hunt_id)
    assert confirmed.state == HuntState.RESOLVED

    async with harness.sm() as session:
        old = await session.get(models.Claim, uuid.UUID(claim_id))
        assert old is not None and old.valid_to is not None  # superseded
        corrected = await session.scalar(
            select(models.Claim).where(
                models.Claim.project_id == uuid.UUID(project_id),
                models.Claim.text == "Corrected fact",
            )
        )
        assert corrected is not None and float(corrected.credibility) == 0.9
        assert "hr" in corrected.tags  # tags inherited (topic permissions preserved, FR-15.4)
        correction = await session.get(models.Correction, uuid.UUID(correction_id))
        assert correction is not None and correction.status == "applied"


async def test_reject_restores_the_claim(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = _scope(project_id)
    claim_id = await _seed_claim(harness, project_id, "Fact", ["hr"])
    correction_id = await _routed_correction(harness, scope, claim_id, "Wrong correction")
    review = await _review_service(harness, project_id)

    opened = await review.open_review(scope, correction_id)
    rejected = await review.reject(scope, opened.hunt_id)
    assert rejected.state == HuntState.DECLINED
    async with harness.sm() as session:
        claim = await session.get(models.Claim, uuid.UUID(claim_id))
        assert claim is not None and claim.disputed is False and claim.valid_to is None
        correction = await session.get(models.Correction, uuid.UUID(correction_id))
        assert correction is not None and correction.status == "rejected"


async def test_expire_leaves_claim_disputed(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = _scope(project_id)
    claim_id = await _seed_claim(harness, project_id, "Fact", ["hr"])
    correction_id = await _routed_correction(harness, scope, claim_id, "Maybe")
    review = await _review_service(harness, project_id)

    opened = await review.open_review(scope, correction_id)
    expired = await review.expire(scope, opened.hunt_id)
    assert expired.state == HuntState.EXPIRED
    async with harness.sm() as session:
        claim = await session.get(models.Claim, uuid.UUID(claim_id))
        assert claim is not None and claim.disputed is True  # stays disputed
        correction = await session.get(models.Correction, uuid.UUID(correction_id))
        assert correction is not None and correction.status == "expired"


async def test_correct_knowledge_opens_a_review_hunt(
    build_harness: Callable[..., Harness],
) -> None:
    """The real entry point (FR-15.3b/§8.1): a non-owner's ``correct_knowledge`` marks the claim
    disputed and opens a CORRECTION_REVIEW hunt to the tag owner, linked to the correction row."""
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    await PersonDirectory(harness.sm).add(
        _scope(project_id), name="Owner", channels={"email": "o@x"}, topics=["hr"]
    )
    claim_id = await _seed_claim(harness, project_id, "Old fact", ["hr"])
    stranger = Principal(
        id="99999999-9999-9999-9999-999999999999",
        type=PrincipalType.HUMAN,
        # A stranger to the TOPIC's owner, not to the topic: this test is about ownership routing,
        # so the caller must be able to see the claim at all (R06).
        allowed_topics=frozenset({"hr"}),
    ).scope_for(project_id)

    outcome = await do_correct_knowledge(
        harness.sm,
        AgeGraphStore(harness.sm),
        harness.gateway,
        stranger,
        claim_id=claim_id,
        topic=None,
        statement=None,
        correction="Corrected fact",
        # A configured install: the review hunt has to reach the owner for this to be about routing.
        hunts=HuntService(harness.sm, channel=NullChannel()),
    )
    assert outcome.status == "routed_to_owner"

    async with harness.sm() as session:
        hunt = await session.scalar(
            select(models.Hunt).where(
                models.Hunt.project_id == uuid.UUID(project_id),
                models.Hunt.hunt_type == "CORRECTION_REVIEW",
            )
        )
        assert hunt is not None and hunt.state == HuntState.AWAITING_ANSWER.value
        claim = await session.get(models.Claim, uuid.UUID(claim_id))
        assert claim is not None and claim.disputed is True
        correction = await session.scalar(
            select(models.Correction).where(models.Correction.project_id == uuid.UUID(project_id))
        )
        assert correction is not None
        assert correction.status == "routed_hunt" and correction.hunt_id == hunt.id


async def test_no_owner_leaves_claim_disputed(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = _scope(project_id)
    claim_id = await _seed_claim(harness, project_id, "Fact", ["nobody-owns"])
    correction_id = await _routed_correction(harness, scope, claim_id, "x")
    # No person owns the claim's tag → NO_OWNER, but the claim is still marked disputed.
    review = CorrectionReviewService(
        harness.sm, hunts=HuntService(harness.sm, channel=NullChannel())
    )
    opened = await review.open_review(scope, correction_id)
    assert opened.state == HuntState.NO_OWNER
    async with harness.sm() as session:
        claim = await session.get(models.Claim, uuid.UUID(claim_id))
        assert claim is not None and claim.disputed is True
