"""Build an OKF bundle (SPEC-22, FR-10.6 / D14).

The bundle carries active claims (text + provenance: credibility, tags, validity) and skills, each
as an OKF-compatible entry (own fields under the ``rsc_brain_`` namespace, like SPEC-20's skill
frontmatter). It respects the exporting principal's permissions — only claims/skills whose tags the
principal may see are exported (the same FR-4.14 predicate as recall), filtered in-query.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.recall.permissions import claim_visibility_clause, sensitive_tags
from rsc_brain.scope import ProjectScope
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models
from rsc_brain.temporal import active_at_clause

OKF_VERSION = "0.1"


async def export_okf_bundle(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> dict[str, object]:
    """An OKF bundle of the active claims + skills the principal may see (FR-10.6)."""
    forbidden = await sensitive_tags(sessionmaker, scope.project_id)
    now = dt.datetime.now(dt.UTC)
    async with sessionmaker() as session:
        claims = list(
            await session.scalars(
                select(models.Claim)
                .where(
                    claim_visibility_clause(scope, forbidden),
                    active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
                    models.Claim.pending_confirmation.is_(False),
                )
                .order_by(models.Claim.id)
            )
        )
    claim_entries = [_claim_entry(c) for c in claims]

    skill_entries = [
        s.frontmatter().to_okf()
        for s in await SkillStore(sessionmaker).list_visible(scope, forbidden)
    ]
    return {
        "okf_version": OKF_VERSION,
        "kind": "bundle",
        "rsc_brain_project": scope.project_id,
        "rsc_brain_claims": claim_entries,
        "rsc_brain_skills": skill_entries,
    }


def _claim_entry(claim: models.Claim) -> dict[str, object]:
    return {
        "okf_version": OKF_VERSION,
        "kind": "claim",
        "title": claim.text,
        "rsc_brain_claim_id": str(claim.id),
        "rsc_brain_subject": claim.subject,
        "rsc_brain_predicate": claim.predicate,
        "rsc_brain_object": claim.object,
        "rsc_brain_credibility": float(claim.credibility) if claim.credibility is not None else 0.0,
        "rsc_brain_tags": list(claim.tags),
        "rsc_brain_valid_from": claim.valid_from.isoformat() if claim.valid_from else None,
        "rsc_brain_source_document_id": str(claim.source_document_id)
        if claim.source_document_id
        else None,
    }
