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

from rsc_brain.hunting.corrections_review import CorrectionReviewService
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntService
from rsc_brain.hunting.state_machine import HuntState
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


def _scope(project_id: str) -> ProjectScope:
    return Principal(
        id="11111111-1111-1111-1111-111111111111", type=PrincipalType.HUMAN, can_curate=True
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
    return CorrectionReviewService(harness.sm, hunts=HuntService(harness.sm))


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


async def test_no_owner_leaves_claim_disputed(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = _scope(project_id)
    claim_id = await _seed_claim(harness, project_id, "Fact", ["nobody-owns"])
    correction_id = await _routed_correction(harness, scope, claim_id, "x")
    # No person owns the claim's tag → NO_OWNER, but the claim is still marked disputed.
    review = CorrectionReviewService(harness.sm, hunts=HuntService(harness.sm))
    opened = await review.open_review(scope, correction_id)
    assert opened.state == HuntState.NO_OWNER
    async with harness.sm() as session:
        claim = await session.get(models.Claim, uuid.UUID(claim_id))
        assert claim is not None and claim.disputed is True
