"""Permission-aware retriever (FR-3.1/3.2/3.3/3.5) — the recall pillar.

Flow: embed the query → **vector search with the permission filter in the SQL** (project + allowed
topics minus forbidden sensitive tags, FR-4.2/4.14) → k-hop graph expansion to connected documents
(same tag filter) → score (FR-3.2) → abstain below τ and register a gap (FR-3.3) → assemble
fragments with provenance under the token budget (FR-3.5). The brain never redacts: it returns
fragments, never synthesized prose, and never dumps the graph.

Denied and nonexistent are indistinguishable: both yield ``RecallResult(found=False)`` (FR-4.3).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import RecallConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.chunker import approx_tokens
from rsc_brain.recall.gaps import register_gap
from rsc_brain.recall.interfaces import Fragment, RecallResult
from rsc_brain.recall.permissions import chunk_visibility_clause, sensitive_tags
from rsc_brain.recall.scoring import score_fragment
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, graph_name
from rsc_brain.stores.relational import models


@dataclass(frozen=True, slots=True)
class _ClaimAggregate:
    claim_ids: tuple[str, ...]
    credibility: float | None
    importance: float | None
    valid_from: dt.date | None


@dataclass(frozen=True, slots=True)
class _Candidate:
    chunk_id: str
    text: str
    tags: tuple[str, ...]
    page: int | None
    document_id: str
    document_title: str
    similarity: float
    claim_ids: tuple[str, ...]
    credibility: float | None
    importance: float | None
    valid_from: dt.date | None


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


class PgRetriever:
    """Concrete :class:`~rsc_brain.recall.interfaces.Retriever` over pgvector + AGE."""

    def __init__(
        self,
        *,
        sessionmaker: async_sessionmaker[AsyncSession],
        gateway: ModelGateway,
        graph_store: AgeGraphStore,
        config: RecallConfig | None = None,
        contradiction_resolver: object | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._gateway = gateway
        self._graph = graph_store
        self._config = config or RecallConfig()
        # Optional on-consume contradiction re-check (FR-3.4). None keeps SPEC-06 behaviour.
        self._resolver = contradiction_resolver

    async def _detect_on_consume(
        self, scope: ProjectScope, candidates: Sequence[_Candidate]
    ) -> None:
        """FR-3.4: run recovered-context claim pairs through the resolver (cache → only unseen
        pairs judged). No-op unless a resolver is configured (opt-in)."""
        if self._resolver is None:
            return
        claim_ids = [cid for candidate in candidates for cid in candidate.claim_ids]
        if claim_ids:
            from rsc_brain.knowledge.contradictions import ContradictionResolver

            assert isinstance(self._resolver, ContradictionResolver)
            await self._resolver.resolve_ids(scope, claim_ids)

    async def recall(
        self,
        scope: ProjectScope,
        query: str,
        *,
        top_k: int = 8,
        topics_hint: Sequence[str] | None = None,
        as_of: dt.date | None = None,
        include_historical: bool = False,
        include_superseded: bool = False,
    ) -> RecallResult:
        # Temporal window (include_historical/as_of) is honored in SPEC-13/17; here recall returns
        # current knowledge. `include_superseded` surfaces valid_to-set claims in the provenance,
        # but ONLY for an admin (curator) — otherwise it is ignored (FR-5.5, admin-only).
        del include_historical
        show_superseded = include_superseded and scope.can_curate
        as_of = as_of or dt.datetime.now(dt.UTC).date()
        # A caller with no topic access can match nothing (fail closed → indistinguishable).
        if not scope.allowed_topics:
            await register_gap(self._sm, scope, query, topics=topics_hint or ())
            return RecallResult(found=False, gap_registered=True)

        vector = (await self._gateway.embed([query]))[0]
        forbidden = await sensitive_tags(self._sm, scope.project_id)

        candidate_ids = await self._vector_candidates(scope, vector, forbidden, top_k)
        candidate_ids = await self._expand_k_hop(scope, forbidden, candidate_ids)
        candidates = await self._load_candidates(
            scope, vector, candidate_ids, show_superseded=show_superseded
        )
        await self._detect_on_consume(scope, candidates)

        if not candidates:
            await register_gap(self._sm, scope, query, topics=topics_hint or ())
            return RecallResult(found=False, gap_registered=True)

        scored = sorted(
            (self._score(candidate, as_of) for candidate in candidates),
            key=lambda item: item[1],
            reverse=True,
        )
        if scored[0][1] < self._config.tau:
            await register_gap(self._sm, scope, query, topics=topics_hint or ())
            return RecallResult(found=False, gap_registered=True)

        return RecallResult(found=True, fragments=self._assemble(scored), gap_registered=False)

    # --- steps ---------------------------------------------------------------

    def _visible_search(
        self, scope: ProjectScope, vector: Sequence[float], forbidden: frozenset[str], limit: int
    ) -> Select[tuple[uuid.UUID, float]]:
        distance = models.Chunk.embedding.cosine_distance(list(vector))
        return (
            select(models.Chunk.id, (1 - distance).label("sim"))
            .where(
                chunk_visibility_clause(scope, forbidden),
                models.Chunk.embedding.is_not(None),
                models.Chunk.needs_review.is_(False),
            )
            .order_by(distance)
            .limit(limit)
        )

    async def _vector_candidates(
        self, scope: ProjectScope, vector: Sequence[float], forbidden: frozenset[str], top_k: int
    ) -> list[str]:
        async with self._sm() as session:
            rows = await session.execute(self._visible_search(scope, vector, forbidden, top_k))
            return [str(cid) for cid, _ in rows.all()]

    async def _expand_k_hop(
        self, scope: ProjectScope, forbidden: frozenset[str], seed_ids: list[str]
    ) -> list[str]:
        """Add chunks from documents connected in the graph to the seeds' documents (k-hop,
        FR-3.1). No-op when k_hop==0 or the project graph has no such connections."""
        if self._config.k_hop <= 0 or not seed_ids:
            return seed_ids
        seed_docs = await self._documents_of(scope, seed_ids)
        neighbor_docs = await self._neighbor_documents(scope, seed_docs)
        extra_docs = neighbor_docs - seed_docs
        if not extra_docs:
            return seed_ids
        extra_chunks = await self._visible_chunks_of_documents(scope, forbidden, extra_docs)
        return list(dict.fromkeys([*seed_ids, *extra_chunks]))

    async def _documents_of(self, scope: ProjectScope, chunk_ids: list[str]) -> set[str]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Chunk.document_id).where(
                    models.Chunk.id.in_([uuid.UUID(c) for c in chunk_ids]),
                    models.Chunk.project_id == uuid.UUID(scope.project_id),
                )
            )
            return {str(d) for d in rows}

    async def _neighbor_documents(self, scope: ProjectScope, docs: set[str]) -> set[str]:
        if not docs:
            return set()
        graph = graph_name(scope.project_id)
        depth = int(self._config.k_hop)
        cypher = (
            f"MATCH (a)-[*1..{depth}]-(b) WHERE a.source_document_id IN $docs "
            "AND b.suppressed IS NULL RETURN DISTINCT b.source_document_id AS result"
        )
        del graph  # graph name is resolved inside run_cypher from the scope
        try:
            rows = await self._graph.run_cypher(scope, cypher, {"docs": sorted(docs)})
        except Exception:  # pragma: no cover - a missing graph degrades to no expansion
            return set()
        return {str(row["result"]) for row in rows if row.get("result")}

    async def _visible_chunks_of_documents(
        self, scope: ProjectScope, forbidden: frozenset[str], docs: set[str]
    ) -> list[str]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Chunk.id).where(
                    chunk_visibility_clause(scope, forbidden),
                    models.Chunk.document_id.in_([uuid.UUID(d) for d in docs]),
                    models.Chunk.embedding.is_not(None),
                    models.Chunk.needs_review.is_(False),
                )
            )
            return [str(c) for c in rows]

    async def _load_candidates(
        self,
        scope: ProjectScope,
        vector: Sequence[float],
        candidate_ids: list[str],
        *,
        show_superseded: bool = False,
    ) -> list[_Candidate]:
        if not candidate_ids:
            return []
        distance = models.Chunk.embedding.cosine_distance(list(vector))
        async with self._sm() as session:
            rows = await session.execute(
                select(
                    models.Chunk.id,
                    models.Chunk.text,
                    models.Chunk.tags,
                    models.Chunk.page,
                    models.Chunk.document_id,
                    models.Document.title,
                    (1 - distance).label("sim"),
                )
                .join(models.Document, models.Chunk.document_id == models.Document.id)
                .where(
                    models.Chunk.id.in_([uuid.UUID(c) for c in candidate_ids]),
                    models.Chunk.project_id == uuid.UUID(scope.project_id),
                )
            )
            candidates: list[_Candidate] = []
            for cid, text, tags, page, document_id, title, sim in rows.all():
                claim = await self._claim_aggregate(
                    session, scope, cid, show_superseded=show_superseded
                )
                candidates.append(
                    _Candidate(
                        chunk_id=str(cid),
                        text=text,
                        tags=tuple(tags),
                        page=page,
                        document_id=str(document_id),
                        document_title=title or str(document_id),
                        similarity=float(sim),
                        claim_ids=claim.claim_ids,
                        credibility=claim.credibility,
                        importance=claim.importance,
                        valid_from=claim.valid_from,
                    )
                )
            return candidates

    async def _claim_aggregate(
        self,
        session: AsyncSession,
        scope: ProjectScope,
        chunk_id: uuid.UUID,
        *,
        show_superseded: bool = False,
    ) -> _ClaimAggregate:
        conditions = [
            models.Claim.chunk_id == chunk_id,
            models.Claim.project_id == uuid.UUID(scope.project_id),
            models.Claim.pending_confirmation.is_(False),  # never surface unconfirmed claims
        ]
        if not show_superseded:
            # Exclude superseded (valid_to set) claims from the provenance (FR-5.5, admin-only).
            conditions.append(models.Claim.valid_to.is_(None))
        rows = await session.execute(
            select(
                models.Claim.id,
                models.Claim.credibility,
                models.Claim.importance,
                models.Claim.valid_from,
            ).where(*conditions)
        )
        claim_ids: list[str] = []
        credibilities: list[float] = []
        importances: list[float] = []
        valid_from: dt.date | None = None
        for cid, credibility, importance, claim_valid_from in rows.all():
            claim_ids.append(str(cid))
            if credibility is not None:
                credibilities.append(float(credibility))
            if importance is not None:
                importances.append(float(importance))
            if claim_valid_from is not None:
                claim_date = claim_valid_from.date()
                valid_from = claim_date if valid_from is None else min(valid_from, claim_date)
        return _ClaimAggregate(
            claim_ids=tuple(claim_ids),
            credibility=_mean(credibilities),
            importance=_mean(importances),
            valid_from=valid_from,
        )

    def _score(self, candidate: _Candidate, as_of: dt.date) -> tuple[_Candidate, float]:
        score = score_fragment(
            similarity=candidate.similarity,
            credibility=candidate.credibility,
            importance=candidate.importance,
            valid_from=candidate.valid_from,
            as_of=as_of,
            tags=candidate.tags,
            weights=self._config.weights,
            default_half_life_days=self._config.half_life_days,
            half_life_by_topic=self._config.half_life_by_topic,
        )
        return candidate, score

    def _assemble(self, scored: list[tuple[_Candidate, float]]) -> tuple[Fragment, ...]:
        """Fragments in descending score under the token budget — trimmed by score, never a
        silent provenance truncation."""
        budget = self._config.answer_token_budget
        used = 0
        fragments: list[Fragment] = []
        for candidate, score in scored:
            cost = approx_tokens(candidate.text)
            if fragments and used + cost > budget:
                break
            used += cost
            fragments.append(
                Fragment(
                    text=candidate.text,
                    document_id=candidate.document_id,
                    score=round(score, 6),
                    provenance={
                        "document": candidate.document_title,
                        "page": candidate.page,
                        "claim_ids": list(candidate.claim_ids),
                        "credibility": round(candidate.credibility or 0.5, 4),
                        "tags": list(candidate.tags),
                    },
                    valid_from=candidate.valid_from,
                    untrusted_data=True,
                )
            )
        return tuple(fragments)
