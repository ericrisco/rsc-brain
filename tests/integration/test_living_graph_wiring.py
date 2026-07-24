"""Bloque A wiring end-to-end (SPEC-08): cred0 at ingest, correction reflected in recall, and the
include_superseded admin gate — against the real container."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import cast

import pytest

from rsc_brain.knowledge.corrections import CorrectionService
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0)]
DOC = b"# Handbook\n\nThe deployment pipeline runs in CI daily.\n"


def _completion(make_completion: Callable[..., object]) -> object:
    return make_completion(
        entities=[{"name": "pipeline", "type": "system", "aliases": []}],
        claims=[
            {
                "text": "The pipeline runs daily",
                "subject": "pipeline",
                "predicate": "runs",
                "object": "daily",
            }
        ],
        tags=["engineering"],
    )


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )


async def _ingest(harness: Harness, project: str) -> None:
    scope = harness.scope(project, allowed_topics=["engineering"])
    await harness.repo.create_source(
        scope, name="src", type_="folder", policy="source_tags", default_tags=["engineering"]
    )
    await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="src")


async def test_cred0_is_source_typed_not_default(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = build_harness(completion=_completion(make_completion))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _ingest(harness, project)
    # The extracted prose claim gets a computed cred0 (official_prose authority), not the 0.5 default.
    async with harness.sm() as session:
        from sqlalchemy import select

        creds = (
            await session.scalars(
                select(models.Claim.credibility).where(
                    models.Claim.project_id == uuid.UUID(project)
                )
            )
        ).all()
    assert creds and all(float(c) != 0.5 for c in creds)


async def test_correction_is_reflected_in_recall_and_admin_can_see_superseded(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = build_harness(completion=_completion(make_completion))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _ingest(harness, project)

    owner = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('owner')}@example.com", status="active")
    )
    async with harness.sm() as session:
        session.add(
            models.Person(
                project_id=uuid.UUID(project),
                user_id=uuid.UUID(owner.user_id),
                name="Owner",
                topics=["engineering"],
            )
        )
        await session.commit()

    recall_scope = harness.scope(project, allowed_topics=["engineering", "general"])
    before = await _retriever(harness).recall(recall_scope, "deployment pipeline", top_k=8)
    assert before.found is True
    original_claim_ids = cast("list[str]", before.fragments[0].provenance["claim_ids"])
    assert original_claim_ids

    owner_scope: ProjectScope = Principal(id=owner.user_id, type=PrincipalType.HUMAN).scope_for(
        project
    )
    service = CorrectionService(
        store=KnowledgeStore(harness.sm), graph=AgeGraphStore(harness.sm), gateway=harness.gateway
    )
    outcome = await service.correct(
        owner_scope, claim_id=original_claim_ids[0], correction="The pipeline runs hourly"
    )
    assert outcome.status == "applied"

    after = await _retriever(harness).recall(recall_scope, "deployment pipeline", top_k=8)
    assert after.found is True
    new_claim_ids = cast("list[str]", after.fragments[0].provenance["claim_ids"])
    assert original_claim_ids[0] not in new_claim_ids  # the corrected (superseded) claim is gone
    assert outcome.new_claim_id in new_claim_ids  # the new claim is present

    # An admin can still see the superseded claim with include_superseded=True.
    admin_scope = harness.scope(
        project, allowed_topics=["engineering", "general"]
    )  # can_curate=True
    admin_view = await _retriever(harness).recall(
        admin_scope, "deployment pipeline", top_k=8, include_superseded=True
    )
    admin_claim_ids = cast("list[str]", admin_view.fragments[0].provenance["claim_ids"])
    assert original_claim_ids[0] in admin_claim_ids
