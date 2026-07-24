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


def _maybe_uuid(value: str | None) -> uuid.UUID | None:
    """Parse a UUID, or None for absent / non-UUID principals (e.g. the CLI 'cli' actor)."""
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


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

    async def set_disputed(
        self, scope: ProjectScope, claim_ids: Sequence[str], *, disputed: bool
    ) -> None:
        """Set/clear the ``disputed`` flag (SPEC-15: a rejected correction review restores the
        claim by clearing it)."""
        if not claim_ids:
            return
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Claim)
                .where(
                    models.Claim.id.in_([uuid.UUID(i) for i in claim_ids]),
                    models.Claim.project_id == _pid(scope),
                )
                .values(disputed=disputed)
            )

    async def set_correction_status(
        self, scope: ProjectScope, correction_id: str, *, status: str, new_claim: str | None = None
    ) -> None:
        """Advance a correction record's status (SPEC-15 CORRECTION_REVIEW: routed_hunt → applied |
        rejected | expired)."""
        values: dict[str, object] = {"status": status, "resolved_at": _now()}
        if new_claim is not None:
            values["new_claim"] = uuid.UUID(new_claim)
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Correction)
                .where(
                    models.Correction.id == uuid.UUID(correction_id),
                    models.Correction.project_id == _pid(scope),
                )
                .values(**values)
            )

    async def get_claim(self, scope: ProjectScope, claim_id: str) -> ClaimData | None:
        async with self._sm() as session:
            claim = await session.get(models.Claim, uuid.UUID(claim_id))
            if claim is None or claim.project_id != _pid(scope):
                return None
            return self._to_claim_data(claim)

    # --- corrections (Learning Layer, FR-15.x) -------------------------------

    async def person_owns_any_tag(
        self, scope: ProjectScope, user_id: str, tags: Sequence[str]
    ) -> bool:
        """True iff a Person(user_id) is RESPONSIBLE_FOR (``persons.topics``) any of ``tags``."""
        if not tags:
            return False
        async with self._sm() as session:
            match = await session.scalar(
                select(models.Person.id).where(
                    models.Person.project_id == _pid(scope),
                    models.Person.user_id == uuid.UUID(user_id),
                    models.Person.topics.op("&&")(list(tags)),
                )
            )
            return match is not None

    async def sensitive_slugs(self, scope: ProjectScope, *, threshold: int = 3) -> set[str]:
        """Project topic slugs with ``sensitivity >= threshold`` (FR-4.14/15.5)."""
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Topic.slug).where(
                    models.Topic.project_id == _pid(scope),
                    models.Topic.sensitivity >= threshold,
                )
            )
            return set(rows)

    async def find_candidate_claims(
        self, scope: ProjectScope, embedding: Sequence[float], *, limit: int = 5
    ) -> list[ClaimData]:
        """Active claims most similar to ``embedding`` (for topic+statement target resolution)."""
        distance = models.Claim.embedding.cosine_distance(list(embedding))
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Claim)
                .where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.embedding.is_not(None),
                    models.Claim.valid_to.is_(None),
                )
                .order_by(distance)
                .limit(limit)
            )
            return [self._to_claim_data(c) for c in rows]

    async def apply_owner_correction(
        self,
        scope: ProjectScope,
        *,
        old_claim_id: str,
        new_text: str,
        new_tags: Sequence[str],
        cred_old: float,
        cred_new: float,
        pending: bool,
    ) -> str:
        """One transaction: degrade + supersede the old claim (unless pending), create the new
        claim. Returns the new claim id."""
        async with session_scope(self._sm) as session:
            old = await session.get(models.Claim, uuid.UUID(old_claim_id))
            if old is None or old.project_id != _pid(scope):
                raise LookupError(old_claim_id)
            new_claim = models.Claim(
                project_id=_pid(scope),
                chunk_id=old.chunk_id,
                text=new_text,
                subject=old.subject,
                predicate=old.predicate,
                object=old.object,
                credibility=cred_new,
                tags=list(new_tags),
                source_document_id=old.source_document_id,
                pending_confirmation=pending,
            )
            session.add(new_claim)
            await session.flush()
            if not pending:
                old.credibility = cred_old
                old.valid_to = _now()
            return str(new_claim.id)

    async def record_correction(
        self,
        scope: ProjectScope,
        *,
        target_claim: str,
        new_claim: str | None,
        author_id: str | None,
        on_behalf_of: str | None,
        role_applied: str,
        status: str,
        before_text: str | None,
        after_text: str | None,
        reason: str | None,
    ) -> str:
        async with session_scope(self._sm) as session:
            correction = models.Correction(
                project_id=_pid(scope),
                target_claim=uuid.UUID(target_claim),
                new_claim=uuid.UUID(new_claim) if new_claim else None,
                author_id=_maybe_uuid(author_id),
                on_behalf_of=_maybe_uuid(on_behalf_of),
                role_applied=role_applied,
                status=status,
                before_text=before_text,
                after_text=after_text,
                reason=reason,
                resolved_at=_now() if status in {"applied", "reverted"} else None,
            )
            session.add(correction)
            await session.flush()
            return str(correction.id)

    async def get_correction(
        self, scope: ProjectScope, correction_id: str
    ) -> models.Correction | None:
        async with self._sm() as session:
            correction = await session.get(models.Correction, uuid.UUID(correction_id))
            if correction is None or correction.project_id != _pid(scope):
                return None
            return correction

    async def list_corrections(
        self, scope: ProjectScope, *, limit: int = 100
    ) -> list[dict[str, object]]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Correction)
                .where(models.Correction.project_id == _pid(scope))
                .order_by(models.Correction.created_at.desc())
                .limit(limit)
            )
            return [
                {
                    "id": str(c.id),
                    "target_claim": str(c.target_claim),
                    "new_claim": str(c.new_claim) if c.new_claim else None,
                    "status": c.status,
                    "role_applied": c.role_applied,
                    "before_text": c.before_text,
                    "after_text": c.after_text,
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                }
                for c in rows
            ]

    async def revert_correction(
        self,
        scope: ProjectScope,
        *,
        old_claim_id: str,
        new_claim_id: str | None,
        cred_restore: float,
    ) -> None:
        """Reactivate the old claim (clear valid_to, restore credibility) and supersede the new
        claim — the reverse of an applied correction (FR-15.8)."""
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Claim)
                .where(
                    models.Claim.id == uuid.UUID(old_claim_id),
                    models.Claim.project_id == _pid(scope),
                )
                .values(valid_to=None, credibility=cred_restore, disputed=False)
            )
            if new_claim_id is not None:
                await session.execute(
                    update(models.Claim)
                    .where(
                        models.Claim.id == uuid.UUID(new_claim_id),
                        models.Claim.project_id == _pid(scope),
                    )
                    .values(valid_to=_now())
                )

    async def corrections_by_author_since(
        self, scope: ProjectScope, author_id: str, since: dt.datetime
    ) -> int:
        async with self._sm() as session:
            from sqlalchemy import func

            total = await session.scalar(
                select(func.count())
                .select_from(models.Correction)
                .where(
                    models.Correction.project_id == _pid(scope),
                    models.Correction.author_id == uuid.UUID(author_id),
                    models.Correction.created_at >= since,
                )
            )
            return int(total or 0)

    async def distinct_correctors_of_claim(self, scope: ProjectScope, claim_id: str) -> int:
        async with self._sm() as session:
            from sqlalchemy import func

            total = await session.scalar(
                select(func.count(func.distinct(models.Correction.author_id))).where(
                    models.Correction.project_id == _pid(scope),
                    models.Correction.target_claim == uuid.UUID(claim_id),
                )
            )
            return int(total or 0)

    async def feedback_budget_remaining(
        self, scope: ProjectScope, principal_id: str, claim_id: str, day: dt.date, cap: float
    ) -> float:
        """Remaining daily |Δcred| budget for this (principal, claim) — the agent-spam guard."""
        async with self._sm() as session:
            consumed = await session.scalar(
                select(models.FeedbackDailyImpact.impact).where(
                    models.FeedbackDailyImpact.project_id == _pid(scope),
                    models.FeedbackDailyImpact.principal_id == principal_id,
                    models.FeedbackDailyImpact.claim_id == uuid.UUID(claim_id),
                    models.FeedbackDailyImpact.day == day,
                )
            )
            return max(0.0, cap - float(consumed or 0.0))

    async def apply_feedback(
        self,
        scope: ProjectScope,
        *,
        principal_id: str,
        claim_id: str,
        day: dt.date,
        new_credibility: float,
        delta: float,
        disputed: bool = False,
        hunting_candidate: bool = False,
    ) -> None:
        """Set the claim's new credibility, mark disputed/hunting if requested, and add the
        consumed impact to the daily ledger — one transaction."""
        values: dict[str, object] = {"credibility": new_credibility}
        if disputed:
            values["disputed"] = True
        if hunting_candidate:
            values["hunting_candidate"] = True
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Claim)
                .where(
                    models.Claim.id == uuid.UUID(claim_id),
                    models.Claim.project_id == _pid(scope),
                )
                .values(**values)
            )
            statement = (
                pg_insert(models.FeedbackDailyImpact)
                .values(
                    project_id=_pid(scope),
                    principal_id=principal_id,
                    claim_id=uuid.UUID(claim_id),
                    day=day,
                    impact=delta,
                )
                .on_conflict_do_update(
                    index_elements=["project_id", "principal_id", "claim_id", "day"],
                    set_={"impact": models.FeedbackDailyImpact.__table__.c.impact + delta},
                )
            )
            await session.execute(statement)
