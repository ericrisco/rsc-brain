"""Project-scoped persistence for the living graph (SPEC-08): claim pairing data, the
contradiction verdict cache, and resolution writes. Every method takes a ``ProjectScope`` and
filters by ``scope.project_id`` in-query (FR-12.4).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import maybe_session_scope, session_scope
from rsc_brain.temporal import active_at_clause
from rsc_brain.visibility import forbidden_topics, topic_clause


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


def _resolution_row(
    verdict: models.ClaimPairVerdict, a: models.Claim, b: models.Claim
) -> dict[str, object]:
    """Present a contradiction verdict as a resolution: the winner is the still-open claim, the
    loser the superseded one (valid_to set) — with the credibilities that decided it (FR-5.3).

    This reports an operational resolution written by the correction workflow; it is not a
    valid-time reader and therefore must not reinterpret source-supported interval boundaries.
    """
    winner, loser = (a, b) if a.valid_to is None else (b, a)

    def _side(claim: models.Claim) -> dict[str, object]:
        return {
            "claim_id": str(claim.id),
            "text": claim.text,
            "credibility": float(claim.credibility) if claim.credibility is not None else 0.0,
            "valid_to": claim.valid_to.isoformat() if claim.valid_to else None,
        }

    return {
        "verdict": verdict.verdict,
        "confidence": float(verdict.confidence) if verdict.confidence is not None else 0.0,
        "judge_version": verdict.judge_version,
        "winner": _side(winner),
        "loser": _side(loser),
        "created_at": verdict.created_at.isoformat() if verdict.created_at else None,
    }


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
        now = _now()
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Claim).where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.embedding.is_not(None),
                    active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
                    condition,  # type: ignore[arg-type]
                )
            )
            return [self._to_claim_data(c) for c in rows]

    async def claims_for_document(self, scope: ProjectScope, document_id: str) -> list[ClaimData]:
        """Active, embedded claims sourced from a document (on-ingest detection set)."""
        return await self._fetch(scope, models.Claim.source_document_id == uuid.UUID(document_id))

    async def contradiction_candidates(
        self, scope: ProjectScope, document_id: str, *, limit: int = 200
    ) -> list[ClaimData]:
        """The document's own claims PLUS eligible prior claims from the rest of the project (R19).

        Detection used to run over ``claims_for_document`` alone, so a new document was only ever
        compared against itself — a fact contradicting last quarter's handbook was never noticed, which
        is the entire point of the feature.

        Bounded on purpose: the prior set is the most recent ``limit`` active claims, so ingest cost
        stays proportional to the page rather than to the corpus (R38). Ordering by newest keeps the
        comparison against the knowledge most likely to still be believed.
        """
        own = await self.claims_for_document(scope, document_id)
        now = _now()
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Claim)
                .where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.embedding.is_not(None),
                    active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
                    models.Claim.pending_confirmation.is_(False),
                    # NULL-safe on purpose: `col != value` evaluates to NULL for a row whose
                    # `source_document_id` is NULL, so a plain inequality silently drops every claim
                    # without a source document — agent submissions and corrections among them, which
                    # are exactly the claims most likely to contradict the corpus.
                    or_(
                        models.Claim.source_document_id.is_(None),
                        models.Claim.source_document_id != uuid.UUID(document_id),
                    ),
                )
                .order_by(models.Claim.id.desc())
                .limit(limit)
            )
            prior = [self._to_claim_data(c) for c in rows]
        seen = {claim.id for claim in own}
        return [*own, *(claim for claim in prior if claim.id not in seen)]

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
        never deleted — FR-5.5). One transaction.

        This is an operational lifecycle mutation, not an active-at reader.
        """
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
            from rsc_brain.skills.staleness import mark_claims_stale_in_session

            await mark_claims_stale_in_session(
                session,
                scope,
                [uuid.UUID(winner_id), uuid.UUID(loser_id)],
                reason="contradiction resolved",
            )

    async def claim_relation_keys(
        self,
        scope: ProjectScope,
        claim_ids: Sequence[str],
        *,
        session: AsyncSession | None = None,
    ) -> list[tuple[str, str, str]]:
        """The ``(subject_key, predicate, object_key)`` triple each claim asserts in the graph.

        Only claims with both endpoints resolved to a typed entity produce a graph relation, so a
        claim missing either key contributes nothing to retire (R27).
        """
        if not claim_ids:
            return []
        async with maybe_session_scope(self._sm, session) as work:
            rows = (
                await work.execute(
                    select(
                        models.Claim.subject_entity_key,
                        models.Claim.predicate,
                        models.Claim.object_entity_key,
                    ).where(
                        models.Claim.id.in_([uuid.UUID(i) for i in claim_ids]),
                        models.Claim.project_id == _pid(scope),
                        models.Claim.subject_entity_key.is_not(None),
                        models.Claim.object_entity_key.is_not(None),
                        models.Claim.predicate.is_not(None),
                    )
                )
            ).all()
        return [(str(r[0]), str(r[1]), str(r[2])) for r in rows]

    async def live_relation_keys(
        self,
        scope: ProjectScope,
        keys: Sequence[tuple[str, str, str]],
        *,
        session: AsyncSession | None = None,
    ) -> set[tuple[str, str, str]]:
        """Which of ``keys`` some LIVE claim still asserts.

        Two documents can assert the same relation; retiring the edge because one of their claims was
        superseded would delete a fact the corpus still holds. So retirement asks this first.
        """
        if not keys:
            return set()
        subjects = {uuid.UUID(k[0]) for k in keys}
        objects = {uuid.UUID(k[2]) for k in keys}
        now = _now()
        async with maybe_session_scope(self._sm, session) as work:
            rows = (
                await work.execute(
                    select(
                        models.Claim.subject_entity_key,
                        models.Claim.predicate,
                        models.Claim.object_entity_key,
                    ).where(
                        models.Claim.project_id == _pid(scope),
                        models.Claim.subject_entity_key.in_(subjects),
                        models.Claim.object_entity_key.in_(objects),
                        active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
                        models.Claim.pending_confirmation.is_(False),
                    )
                )
            ).all()
        wanted = set(keys)
        return {t for r in rows if (t := (str(r[0]), str(r[1]), str(r[2]))) in wanted}

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
            from rsc_brain.skills.staleness import mark_claims_stale_in_session

            await mark_claims_stale_in_session(
                session,
                scope,
                [uuid.UUID(i) for i in claim_ids],
                reason="contradiction disputed",
            )

    async def flag_claims_needs_review(
        self,
        scope: ProjectScope,
        claim_ids: Sequence[str],
        *,
        chunk_ids: Sequence[str] = (),
    ) -> tuple[list[str], list[str]]:
        """Mark the chunks behind the given claims ``needs_review`` (SPEC-20 FR-4.4 guardrail: a
        mislabeled fragment the secondary classifier dropped). Excludes them from recall until
        re-approved; surfaced in the SPEC-21 review queue."""
        parsed_claims: list[uuid.UUID] = []
        for claim_id in claim_ids:
            try:
                parsed_claims.append(uuid.UUID(claim_id))
            except (TypeError, ValueError):
                continue
        parsed_chunks: list[uuid.UUID] = []
        for chunk_id in chunk_ids:
            try:
                parsed_chunks.append(uuid.UUID(chunk_id))
            except (TypeError, ValueError):
                continue
        if not parsed_claims and not parsed_chunks:
            return [], []
        async with session_scope(self._sm) as session:
            claim_rows: list[tuple[uuid.UUID, uuid.UUID | None]] = []
            if parsed_claims:
                claim_result = await session.execute(
                    select(models.Claim.id, models.Claim.chunk_id).where(
                        models.Claim.id.in_(list(dict.fromkeys(parsed_claims))),
                        models.Claim.project_id == _pid(scope),
                        models.Claim.chunk_id.is_not(None),
                    )
                )
                claim_rows = list(claim_result.tuples())
            direct_chunks: list[uuid.UUID] = []
            if parsed_chunks:
                direct_chunks = list(
                    await session.scalars(
                        select(models.Chunk.id).where(
                            models.Chunk.id.in_(list(dict.fromkeys(parsed_chunks))),
                            models.Chunk.project_id == _pid(scope),
                        )
                    )
                )
            local_chunks = list(
                dict.fromkeys(
                    [chunk_id for _, chunk_id in claim_rows if chunk_id is not None] + direct_chunks
                )
            )
            if local_chunks:
                await session.execute(
                    update(models.Chunk)
                    .where(
                        models.Chunk.id.in_(local_chunks),
                        models.Chunk.project_id == _pid(scope),
                    )
                    .values(needs_review=True)
                )
            return (
                [str(claim_id) for claim_id, _ in claim_rows],
                [str(chunk_id) for chunk_id in local_chunks],
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

    async def link_correction_hunt(
        self, scope: ProjectScope, correction_id: str, hunt_id: str
    ) -> None:
        """Record which CORRECTION_REVIEW hunt owns a routed correction (SPEC-15 §8.1)."""
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Correction)
                .where(
                    models.Correction.id == uuid.UUID(correction_id),
                    models.Correction.project_id == _pid(scope),
                )
                .values(hunt_id=uuid.UUID(hunt_id))
            )

    async def get_claim(self, scope: ProjectScope, claim_id: str) -> ClaimData | None:
        """One claim, or ``None`` when it is absent **or invisible to this caller**.

        R06: this used to filter by project alone, so every mutation reached by claim id — feedback,
        corrections — operated on claims the caller could not see, and answered differently for a
        hidden claim than for a nonexistent one. Topic visibility belongs here, at the single
        lookup every by-id path goes through, not in each caller.
        """
        forbidden = await forbidden_topics(self._sm, scope)
        async with self._sm() as session:
            claim = await session.scalar(
                select(models.Claim).where(
                    models.Claim.id == uuid.UUID(claim_id),
                    models.Claim.project_id == _pid(scope),
                    topic_clause(models.Claim.tags, scope, forbidden),
                )
            )
            if claim is None:
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
        now = _now()
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Claim)
                .where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.embedding.is_not(None),
                    active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
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
        claim. Returns the new claim id. The close is an operational lifecycle mutation, not a
        source-valid-time decision."""
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
            from rsc_brain.skills.staleness import mark_claims_stale_in_session

            await mark_claims_stale_in_session(
                session,
                scope,
                [old.id, new_claim.id],
                reason="owner correction applied",
            )
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
        self,
        scope: ProjectScope,
        *,
        status: str | None = None,
        target_claim: str | None = None,
        author: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, object]]:
        """Corrections feed (SPEC-19): newest first, filterable by status (the
        ``pending_confirmation`` queue is just ``status='pending_confirmation'``), target claim, or
        author — the console's feed / by-claim / by-person views."""
        forbidden = await forbidden_topics(self._sm, scope)
        query = (
            select(models.Correction)
            .join(models.Claim, models.Claim.id == models.Correction.target_claim)
            .where(
                models.Correction.project_id == _pid(scope),
                # R01: a correction carries no topics of its own — it inherits the visibility of
                # the claim it corrects, in-query, so a hidden claim's correction never appears in
                # the feed or in any count derived from it.
                topic_clause(models.Claim.tags, scope, forbidden),
            )
            .order_by(models.Correction.created_at.desc())
            .limit(limit)
        )
        if status is not None:
            query = query.where(models.Correction.status == status)
        if target_claim is not None:
            query = query.where(models.Correction.target_claim == uuid.UUID(target_claim))
        if author is not None:
            query = query.where(models.Correction.author_id == uuid.UUID(author))
        async with self._sm() as session:
            rows = await session.scalars(query)
            return [
                {
                    "id": str(c.id),
                    "target_claim": str(c.target_claim),
                    "new_claim": str(c.new_claim) if c.new_claim else None,
                    "status": c.status,
                    "role_applied": c.role_applied,
                    "author_id": str(c.author_id) if c.author_id else None,
                    "on_behalf_of": str(c.on_behalf_of) if c.on_behalf_of else None,
                    "hunt_id": str(c.hunt_id) if c.hunt_id else None,
                    "before_text": c.before_text,
                    "after_text": c.after_text,
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                    "resolved_at": c.resolved_at.isoformat() if c.resolved_at else None,
                }
                for c in rows
            ]

    async def list_disputed_claims(
        self, scope: ProjectScope, *, limit: int = 100
    ) -> list[dict[str, object]]:
        """Claims currently flagged ``disputed`` (contradiction ties + expired correction reviews,
        FR-15.6) — the console's disputed list (SPEC-19). Topic-filtered in-query (R01)."""
        forbidden = await forbidden_topics(self._sm, scope)
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Claim)
                .where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.disputed.is_(True),
                    topic_clause(models.Claim.tags, scope, forbidden),
                )
                .order_by(models.Claim.id)
                .limit(limit)
            )
            return [
                {
                    "id": str(c.id),
                    "text": c.text,
                    "tags": list(c.tags),
                    "credibility": float(c.credibility) if c.credibility is not None else 0.0,
                    "valid_to": c.valid_to.isoformat() if c.valid_to else None,
                }
                for c in rows
            ]

    async def list_contradiction_resolutions(
        self, scope: ProjectScope, *, limit: int = 100
    ) -> list[dict[str, object]]:
        """Resolved contradictions (FR-5.3): for each ``contradict`` verdict, the two claims with
        their current credibility + validity — the loser is the one whose ``valid_to`` was set
        (superseded), the winner the one still open. Shows "who won, by what score" (SPEC-19)."""
        pid = _pid(scope)
        forbidden = await forbidden_topics(self._sm, scope)
        claim_a = aliased(models.Claim)
        claim_b = aliased(models.Claim)
        async with self._sm() as session:
            rows = (
                await session.execute(
                    select(models.ClaimPairVerdict, claim_a, claim_b)
                    .join(claim_a, models.ClaimPairVerdict.claim_a == claim_a.id)
                    .join(claim_b, models.ClaimPairVerdict.claim_b == claim_b.id)
                    .where(
                        models.ClaimPairVerdict.project_id == pid,
                        models.ClaimPairVerdict.verdict == "contradict",
                        # A resolution discloses BOTH claims, so both must be visible (R01).
                        topic_clause(claim_a.tags, scope, forbidden),
                        topic_clause(claim_b.tags, scope, forbidden),
                    )
                    .order_by(models.ClaimPairVerdict.created_at.desc())
                    .limit(limit)
                )
            ).all()
        return [_resolution_row(verdict, a, b) for verdict, a, b in rows]

    async def correction_metrics(self, scope: ProjectScope) -> dict[str, object]:
        """The Learning-Layer §7 metrics (SPEC-19): status ratios, revert rate, correction-wars
        (disputed ties), and ownership coverage (% of topics with a registered owner).

        Every figure is computed over the caller's authorized topics only: an aggregate is a side
        channel exactly like a list (R01).
        """
        pid = _pid(scope)
        forbidden = await forbidden_topics(self._sm, scope)
        async with self._sm() as session:
            status_rows = (
                await session.execute(
                    select(models.Correction.status, func.count())
                    .join(models.Claim, models.Claim.id == models.Correction.target_claim)
                    .where(
                        models.Correction.project_id == pid,
                        topic_clause(models.Claim.tags, scope, forbidden),
                    )
                    .group_by(models.Correction.status)
                )
            ).all()
            by_status = {str(s): int(n) for s, n in status_rows}
            total = sum(by_status.values())
            reverted = by_status.get("reverted", 0)
            wars = await session.scalar(
                select(func.count())
                .select_from(models.Claim)
                .where(
                    models.Claim.project_id == pid,
                    models.Claim.disputed.is_(True),
                    topic_clause(models.Claim.tags, scope, forbidden),
                )
            )
            topics = await session.scalars(
                select(models.Topic.slug).where(
                    models.Topic.project_id == pid,
                    models.Topic.slug.in_(sorted(scope.allowed_topics)),
                )
            )
            topic_slugs = set(topics)
            owned = 0
            if topic_slugs:
                persons = await session.scalars(
                    select(models.Person.topics).where(models.Person.project_id == pid)
                )
                covered: set[str] = set()
                for person_topics in persons:
                    covered.update(person_topics or [])
                owned = len(topic_slugs & covered)
        coverage = (owned / len(topic_slugs)) if topic_slugs else 0.0
        return {
            "total": total,
            "by_status": by_status,
            "applied": by_status.get("applied", 0),
            "routed_hunt": by_status.get("routed_hunt", 0),
            "rejected": by_status.get("rejected", 0),
            "revert_rate": (reverted / total) if total else 0.0,
            "correction_wars": int(wars or 0),
            "ownership_coverage": round(coverage, 3),
        }

    async def revert_correction(
        self,
        scope: ProjectScope,
        *,
        old_claim_id: str,
        new_claim_id: str | None,
        cred_restore: float,
    ) -> None:
        """Reactivate the old claim (clear valid_to, restore credibility) and supersede the new
        claim — the reverse of an applied correction (FR-15.8). These are operational lifecycle
        mutations, not active-at readers; source-validity restoration remains a separate follow-up."""
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
            from rsc_brain.skills.staleness import mark_claims_stale_in_session

            await mark_claims_stale_in_session(
                session,
                scope,
                [
                    uuid.UUID(old_claim_id),
                    *([uuid.UUID(new_claim_id)] if new_claim_id is not None else []),
                ],
                reason="owner correction reverted",
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
        """Remaining daily |Δcred| budget for this (principal, claim) — reporting only.

        R33: this read used to be the ENFORCEMENT, with the spend committed in a separate transaction.
        Six synchronised signals each read the same remaining budget and each applied a full delta, so
        the guard that stops an agent grinding a claim's credibility down was exceeded fivefold. Deciding
        and spending now happen together in :meth:`spend_feedback_budget`.
        """
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

    async def spend_feedback_budget(
        self,
        scope: ProjectScope,
        *,
        principal_id: str,
        claim_id: str,
        day: dt.date,
        cap: float,
        requested: float,
    ) -> float:
        """Consume up to ``requested`` of the daily budget and return what was actually granted.

        One statement, so the cap holds under any number of concurrent callers: the ledger row is
        incremented and clamped to ``cap`` in the same UPDATE that reads it, and the grant is the
        difference the statement itself made. ``prev_impact`` carries the pre-update value because
        ``RETURNING`` reports the new row only, and computing the difference from a separate SELECT
        would put the race straight back.
        """
        if requested <= 0 or cap <= 0:
            return 0.0
        table = models.FeedbackDailyImpact.__table__
        capped_new = func.least(cap, table.c.impact + requested)
        statement = (
            pg_insert(models.FeedbackDailyImpact)
            .values(
                project_id=_pid(scope),
                principal_id=principal_id,
                claim_id=uuid.UUID(claim_id),
                day=day,
                impact=min(requested, cap),
                prev_impact=0,
            )
            .on_conflict_do_update(
                index_elements=["project_id", "principal_id", "claim_id", "day"],
                set_={"impact": capped_new, "prev_impact": table.c.impact},
            )
            .returning(table.c.impact, table.c.prev_impact)
        )
        async with session_scope(self._sm) as session:
            row = (await session.execute(statement)).one()
        granted = float(row[0]) - float(row[1] or 0.0)
        return max(0.0, granted)

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
        """Set the claim's new credibility and mark disputed/hunting if requested — one transaction.

        R33: the daily ledger is no longer touched here. Budget is granted by
        :meth:`spend_feedback_budget` BEFORE the move is computed, because a spend decided from a value
        read in another transaction is not a cap.
        """
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
            _ = delta  # granted and recorded by `spend_feedback_budget` before this call
