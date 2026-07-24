"""Project-scoped persistence for the living graph (SPEC-08): claim pairing data, the
contradiction verdict cache, and resolution writes. Every method takes a ``ProjectScope`` and
filters by ``scope.project_id`` in-query (FR-12.4).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@dataclass(frozen=True, slots=True)
class ClaimData:
    id: str
    text: str
    subject: str | None
    object: str | None
    credibility: float
    tags: tuple[str, ...]
    embedding: tuple[float, ...]
    valid_to: dt.datetime | None


class KnowledgeStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    def _to_claim_data(self, claim: models.Claim) -> ClaimData:
        return ClaimData(
            id=str(claim.id),
            text=claim.text,
            subject=claim.subject,
            object=claim.object,
            credibility=float(claim.credibility),
            tags=tuple(claim.tags),
            embedding=tuple(float(x) for x in (claim.embedding or ())),
            valid_to=claim.valid_to,
        )

    async def _fetch(self, scope: ProjectScope, condition: object) -> list[ClaimData]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Claim).where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.embedding.is_not(None),
                    models.Claim.valid_to.is_(None),  # only active claims are candidates
                    condition,  # type: ignore[arg-type]
                )
            )
            return [self._to_claim_data(c) for c in rows]

    async def claims_for_document(self, scope: ProjectScope, document_id: str) -> list[ClaimData]:
        """Active, embedded claims sourced from a document (on-ingest detection set)."""
        return await self._fetch(scope, models.Claim.source_document_id == uuid.UUID(document_id))

    async def claims_by_ids(self, scope: ProjectScope, ids: Sequence[str]) -> list[ClaimData]:
        """Active, embedded claims by id (on-consume detection set)."""
        if not ids:
            return []
        return await self._fetch(scope, models.Claim.id.in_([uuid.UUID(i) for i in ids]))

    async def get_verdict(
        self, scope: ProjectScope, claim_a: str, claim_b: str, judge_version: str
    ) -> str | None:
        low, high = sorted((claim_a, claim_b))
        async with self._sm() as session:
            verdict = await session.scalar(
                select(models.ClaimPairVerdict.verdict).where(
                    models.ClaimPairVerdict.project_id == _pid(scope),
                    models.ClaimPairVerdict.claim_a == uuid.UUID(low),
                    models.ClaimPairVerdict.claim_b == uuid.UUID(high),
                    models.ClaimPairVerdict.judge_version == judge_version,
                )
            )
            return verdict

    async def put_verdict(
        self,
        scope: ProjectScope,
        claim_a: str,
        claim_b: str,
        judge_version: str,
        verdict: str,
        confidence: float,
    ) -> None:
        low, high = sorted((claim_a, claim_b))
        statement = (
            pg_insert(models.ClaimPairVerdict)
            .values(
                project_id=_pid(scope),
                claim_a=uuid.UUID(low),
                claim_b=uuid.UUID(high),
                judge_version=judge_version,
                verdict=verdict,
                confidence=confidence,
            )
            .on_conflict_do_update(
                index_elements=["project_id", "claim_a", "claim_b", "judge_version"],
                set_={"verdict": verdict, "confidence": confidence},
            )
        )
        async with session_scope(self._sm) as session:
            await session.execute(statement)

    async def apply_resolution(
        self,
        scope: ProjectScope,
        *,
        winner_id: str,
        loser_id: str,
        winner_cred: float,
        loser_cred: float,
    ) -> None:
        """Winner keeps its (boosted) credibility; loser is degraded + `valid_to=now` (superseded,
        never deleted — FR-5.5). One transaction."""
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Claim)
                .where(
                    models.Claim.id == uuid.UUID(winner_id),
                    models.Claim.project_id == _pid(scope),
                )
                .values(credibility=winner_cred)
            )
            await session.execute(
                update(models.Claim)
                .where(
                    models.Claim.id == uuid.UUID(loser_id),
                    models.Claim.project_id == _pid(scope),
                )
                .values(credibility=loser_cred, valid_to=_now())
            )

    async def mark_disputed(
        self, scope: ProjectScope, claim_ids: Sequence[str], *, hunting_candidate: bool
    ) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Claim)
                .where(
                    models.Claim.id.in_([uuid.UUID(i) for i in claim_ids]),
                    models.Claim.project_id == _pid(scope),
                )
                .values(disputed=True, hunting_candidate=hunting_candidate)
            )

    async def get_claim(self, scope: ProjectScope, claim_id: str) -> ClaimData | None:
        async with self._sm() as session:
            claim = await session.get(models.Claim, uuid.UUID(claim_id))
            if claim is None or claim.project_id != _pid(scope):
                return None
            return self._to_claim_data(claim)
