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
from typing import Any

from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import RecallConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.chunker import approx_tokens
from rsc_brain.ontology.recall import OntologyRecall
from rsc_brain.recall.gaps import register_gap
from rsc_brain.recall.interfaces import Fragment, RecallResult
from rsc_brain.recall.permissions import chunk_visibility_clause, sensitive_tags
from rsc_brain.recall.reranker import Decision, Reranker, decide
from rsc_brain.recall.scoring import score_fragment
from rsc_brain.recall.temporal_intent import TemporalKind, TemporalMode, classify
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.temporal import active_at_clause, is_active_at


@dataclass(frozen=True, slots=True)
class _ClaimAggregate:
    claim_ids: tuple[str, ...]
    credibility: float | None
    importance: float | None
    valid_from: dt.date | None
    valid_to: dt.date | None = None
    is_current: bool = True
    had_claims: bool = False  # the chunk had claims BEFORE the temporal window was applied
    # R22: the text of the claims that SURVIVED the window. Rendering the whole chunk instead means a
    # chunk holding both a current and a retired sentence answers with the retired one.
    claim_texts: tuple[str, ...] = ()
    # R24: any surviving claim is contested. A consumer that cannot see this cannot tell a disputed
    # fact from a settled one.
    disputed: bool = False


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
    valid_to: dt.date | None = None
    is_current: bool = True
    disputed: bool = False


#: Ceiling on how many chunks one recall may retrieve before filtering (R23 surplus meets R38 bounds).
MAX_RETRIEVAL_WIDTH = 200


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _midnight(day: dt.date) -> dt.datetime:
    """UTC midnight for a date — the ``valid_from``/``valid_to`` columns are tz-aware datetimes."""
    return dt.datetime.combine(day, dt.time.min, tzinfo=dt.UTC)


def _rrf_fuse(ranked_lists: Sequence[Sequence[str]], *, k: int, limit: int) -> list[str]:
    """Reciprocal Rank Fusion (FR-3.7): ``score(d) = Σ 1/(k + rank_via(d))`` over each via's
    ranked ids (rank is 1-based). Returns the top ``limit`` ids by fused score; ties keep the
    order of first appearance (stable), so a single non-empty list round-trips unchanged."""
    scores: dict[str, float] = {}
    order: dict[str, int] = {}
    seen = 0
    for ranked in ranked_lists:
        for rank, doc_id in enumerate(ranked, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
            if doc_id not in order:
                order[doc_id] = seen
                seen += 1
    fused = sorted(scores, key=lambda d: (-scores[d], order[d]))
    return fused[:limit]


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
        ontology: OntologyRecall | None = None,
        reranker: Reranker | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._gateway = gateway
        self._graph = graph_store
        self._config = config or RecallConfig()
        # spec `reranked-abstention`: None keeps the SPEC-06 blended-threshold behaviour exactly.
        self._reranker = reranker
        # Optional on-consume contradiction re-check (FR-3.4). None keeps SPEC-06 behaviour.
        self._resolver = contradiction_resolver
        # Optional bounded ontology query-expansion (SPEC-24, FR-17.5). None (default) OR a project
        # with ontology.enabled=false means no expansion — recall is identical to the base pipeline.
        self._ontology = ontology

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

            if not isinstance(self._resolver, ContradictionResolver):  # pragma: no cover
                raise TypeError("the on-consume contradiction hook needs a ContradictionResolver")
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
        eligible_chunk_ids: Sequence[str] | None = None,
    ) -> RecallResult:
        # Temporal intent (FR-16.1): default `current` (only knowledge valid now); a query or the
        # explicit params can widen to historical/as_of/range. `include_superseded` surfaces
        # valid_to-set claims in the provenance, but ONLY for an admin (curator) — otherwise it is
        # ignored (FR-5.5, admin-only). The window is applied IN the SQL (FR-16.2), never post-hoc.
        now = dt.datetime.now(dt.UTC).date()
        mode = classify(query, as_of=as_of, include_historical=include_historical)
        show_superseded = include_superseded and scope.can_curate
        score_as_of = mode.as_of or now  # freshness anchor stays inside the filtered set (FR-3.2)
        # A caller with no topic access can match nothing (fail closed → indistinguishable).
        if not scope.allowed_topics:
            await register_gap(self._sm, scope, query, topics=topics_hint or ())
            return RecallResult(found=False, gap_registered=True)

        eligible_ids: frozenset[uuid.UUID] | None = None
        if eligible_chunk_ids is not None:
            try:
                eligible_ids = frozenset(uuid.UUID(chunk_id) for chunk_id in eligible_chunk_ids)
            except ValueError:
                eligible_ids = frozenset()
            if not eligible_ids:
                return RecallResult(found=False, gap_registered=False)

        # Accounting follows the caller's project (R12), never the process.
        vector = (await self._gateway.for_project(scope.project_id).embed([query]))[0]
        forbidden = await sensitive_tags(self._sm, scope.project_id)
        hard_windows = await self._hard_window_map(scope)

        # R23: retrieve a BOUNDED SURPLUS, not exactly the page. Relevance ranking happens before the
        # temporal filter can run (the filter needs each chunk's claims), so retrieving exactly `top_k`
        # lets stale-but-similar chunks occupy the page and starve the eligible answer out of it. The
        # surplus is what the temporal filter then removes; the page is cut after scoring, below.
        retrieval_width = min(top_k * self._config.temporal_refill_factor, MAX_RETRIEVAL_WIDTH)
        vector_ids = await self._vector_candidates(
            scope, vector, forbidden, retrieval_width, eligible_ids
        )
        if self._config.hybrid_enabled:
            # Hybrid (FR-3.7): fuse the vector list with a lexical (tsvector) list by RRF, so exact
            # identifiers embeddings miss still surface. Both vias carry the SAME in-query filter.
            lexical_ids = await self._lexical_candidates(
                scope,
                query,
                forbidden,
                max(self._config.lexical_candidates, retrieval_width),
                eligible_ids,
            )
            candidate_ids = _rrf_fuse(
                [vector_ids, lexical_ids], k=self._config.rrf_k, limit=retrieval_width
            )
        else:
            candidate_ids = vector_ids
        candidate_ids = await self._ontology_expand(
            scope, query, forbidden, candidate_ids, eligible_ids
        )
        candidate_ids = await self._expand_k_hop(scope, forbidden, candidate_ids, eligible_ids)
        if eligible_ids is not None:
            candidate_ids = [
                chunk_id for chunk_id in candidate_ids if uuid.UUID(chunk_id) in eligible_ids
            ]
        candidates = await self._load_candidates(
            scope,
            vector,
            candidate_ids,
            show_superseded=show_superseded,
            mode=mode,
            now=now,
            hard_windows=hard_windows,
        )
        await self._detect_on_consume(scope, candidates)

        if not candidates:
            await register_gap(self._sm, scope, query, topics=topics_hint or ())
            return RecallResult(found=False, gap_registered=True)

        scored = sorted(
            (self._score(candidate, score_as_of) for candidate in candidates),
            key=lambda item: item[1],
            reverse=True,
        )
        # spec `reranked-abstention`: the reranker decides ONLY whether to answer (FR-3.3). The
        # blend above still decides order (FR-3.2), and this runs on candidates the in-query
        # permission filter already reduced (FR-4.2) — it can never widen what a caller may see.
        # `None` means the seam had no opinion (unavailable provider, nothing to score), and the
        # blended threshold governs, so a degraded provider never silently answers or refuses
        # everything.
        # AUDIT-096: the verdict AND the reason, from one scoring call. Until this, the reason was
        # computed nowhere and the result carried no trace of it, so an install whose reranker route
        # was down reverted to the blended threshold — the one measured incapable of meeting G4 —
        # with nothing anywhere to say so. The failure that hid behind it twice is worse than a silent
        # regression: a G4 measurement cannot tell a judge that scored badly from one that never ran.
        verdict: bool | None = None
        degraded: str | None = None
        decision: Decision | None = None
        if self._reranker is not None:
            page = scored[: self._config.rerank_candidates]
            decision = await decide(
                self._reranker,
                query,
                [candidate.text for candidate, _ in page],
                self._config.tau_rerank,
            )
            verdict, degraded = decision.abstains, decision.degradation
        should_abstain = verdict if verdict is not None else scored[0][1] < self._config.tau
        if should_abstain:
            await register_gap(self._sm, scope, query, topics=topics_hint or ())
            return RecallResult(found=False, gap_registered=True, degraded=degraded)

        # AUDIT-124: honour the reranker's per-passage judgement in the PAYLOAD, not only in the
        # verdict. It used to decide whether to answer while the blend decided what to return, so a
        # query could answer `found=true` and hand back fragments the reranker had scored 0.1 —
        # measured, with the passage that justified answering absent from the result entirely. The
        # confirmed passage now leads, and a candidate the reranker refused is not served as evidence
        # for an answer it did not support. Unscored candidates keep the blend's order: not judged is
        # not the same as judged irrelevant (AUDIT-100).
        answer = self._honour_the_verdict(scored, decision)
        # The page is cut HERE, after the temporal filter has removed what is not eligible (R23).
        return RecallResult(
            found=True,
            fragments=self._assemble(answer[:top_k]),
            gap_registered=False,
            degraded=degraded,
        )

    def _honour_the_verdict(
        self, scored: list[tuple[Any, float]], decision: Decision | None
    ) -> list[tuple[Any, float]]:
        """Lead with what was confirmed; drop what the reranker judged below the threshold."""
        if decision is None or decision.scores is None:
            return scored
        page = scored[: len(decision.scores)]
        rest = scored[len(decision.scores) :]
        threshold = self._config.tau_rerank
        kept = [
            candidate
            for index, candidate in enumerate(page)
            if (score := decision.scores[index]) is None or score >= threshold
        ]
        if decision.confirmed is not None and decision.confirmed < len(page):
            winner = page[decision.confirmed]
            kept = [winner, *(candidate for candidate in kept if candidate is not winner)]
        # A page where the reranker refused everything cannot happen on an answer path, but if it did,
        # returning nothing while saying `found` would be the worst of both: keep the blend's order.
        return [*kept, *rest] if kept else scored

    # --- steps ---------------------------------------------------------------

    def _visible_search(
        self,
        scope: ProjectScope,
        vector: Sequence[float],
        forbidden: frozenset[str],
        limit: int,
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
    ) -> Select[tuple[uuid.UUID, float]]:
        distance = models.Chunk.embedding.cosine_distance(list(vector))
        query = (
            select(models.Chunk.id, (1 - distance).label("sim"))
            .where(
                chunk_visibility_clause(scope, forbidden),
                models.Chunk.embedding.is_not(None),
                models.Chunk.needs_review.is_(False),
            )
            .order_by(distance)
            .limit(limit)
        )
        if eligible_chunk_ids is not None:
            query = query.where(models.Chunk.id.in_(eligible_chunk_ids))
        return query

    async def _vector_candidates(
        self,
        scope: ProjectScope,
        vector: Sequence[float],
        forbidden: frozenset[str],
        top_k: int,
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
    ) -> list[str]:
        async with self._sm() as session:
            rows = await session.execute(
                self._visible_search(scope, vector, forbidden, top_k, eligible_chunk_ids)
            )
            return [str(cid) for cid, _ in rows.all()]

    def _lexical_search(
        self,
        scope: ProjectScope,
        query: str,
        forbidden: frozenset[str],
        limit: int,
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
    ) -> Select[tuple[uuid.UUID, float]]:
        # `simple` config: no stemming/stopwords, so exact identifiers survive tokenisation. The
        # SAME visibility filter as the vector via (project + topics + FR-4.14) is IN the query.
        tsv = func.to_tsvector("simple", models.Chunk.text)
        tsq = func.plainto_tsquery("simple", query)
        statement = (
            select(models.Chunk.id, func.ts_rank(tsv, tsq).label("rank"))
            .where(
                chunk_visibility_clause(scope, forbidden),
                # Only published (embedded) chunks are recallable — an unapproved doc's chunks are
                # unembedded, so this preserves the D13 gate on the lexical via too (SPEC-05).
                models.Chunk.embedding.is_not(None),
                models.Chunk.needs_review.is_(False),
                tsv.op("@@")(tsq),
            )
            .order_by(func.ts_rank(tsv, tsq).desc())
            .limit(limit)
        )
        if eligible_chunk_ids is not None:
            statement = statement.where(models.Chunk.id.in_(eligible_chunk_ids))
        return statement

    async def _lexical_candidates(
        self,
        scope: ProjectScope,
        query: str,
        forbidden: frozenset[str],
        limit: int,
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
    ) -> list[str]:
        if not query.strip():
            return []
        async with self._sm() as session:
            rows = await session.execute(
                self._lexical_search(scope, query, forbidden, limit, eligible_chunk_ids)
            )
            return [str(cid) for cid, _ in rows.all()]

    async def _ontology_expand(
        self,
        scope: ProjectScope,
        query: str,
        forbidden: frozenset[str],
        seed_ids: list[str],
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
    ) -> list[str]:
        """FR-17.5: fold in chunks matching the query's ontology descendants (e.g. "contracts" →
        "leases"/"sales"). No-op unless the layer is enabled. Each descendant label is resolved
        through the SAME visibility-filtered lexical search, so the tag-based permission cut applies
        to the expansion exactly as to the base set (FR-17.8 — the ontology never widens visibility)."""
        if self._ontology is None:
            return seed_ids
        extra_labels = await self._ontology.expand_query_labels(scope, query)
        if not extra_labels:
            return seed_ids
        expanded = list(seed_ids)
        for label in extra_labels:
            expanded.extend(
                await self._lexical_candidates(
                    scope,
                    label,
                    forbidden,
                    self._config.lexical_candidates,
                    eligible_chunk_ids,
                )
            )
        return list(dict.fromkeys(expanded))

    async def _expand_k_hop(
        self,
        scope: ProjectScope,
        forbidden: frozenset[str],
        seed_ids: list[str],
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
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
        extra_chunks = await self._visible_chunks_of_documents(
            scope, forbidden, extra_docs, eligible_chunk_ids
        )
        return list(dict.fromkeys([*seed_ids, *extra_chunks]))[:MAX_RETRIEVAL_WIDTH]

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
        depth = int(self._config.k_hop)
        if not docs or depth < 1:
            return set()
        # AGE cannot assert that every relation in a variable-length path is live: it has neither
        # path variables nor ALL/NONE over an edge list. Advance one bounded hop at a time so the
        # traversed relation is named and a retired edge can never widen current recall (AUDIT-106).
        cypher = (
            "MATCH (a)-[r]-(b) WHERE a.source_document_id IN $docs "
            "AND r.superseded IS NULL AND b.suppressed IS NULL "
            "AND b.source_document_id IS NOT NULL "
            "RETURN DISTINCT b.source_document_id AS result "
            f"LIMIT {MAX_RETRIEVAL_WIDTH}"
        )
        seen = set(docs)
        neighbors: set[str] = set()
        frontier = set(docs)
        try:
            for _ in range(depth):
                if not frontier:
                    break
                rows = await self._graph.run_cypher(
                    scope,
                    cypher,
                    {"docs": sorted(frontier)},
                )
                hop = {str(row["result"]) for row in rows if row.get("result")}
                frontier = hop - seen
                seen.update(frontier)
                neighbors.update(frontier)
        except Exception:  # pragma: no cover - a missing graph degrades to no expansion
            return set()
        return neighbors

    async def _visible_chunks_of_documents(
        self,
        scope: ProjectScope,
        forbidden: frozenset[str],
        docs: set[str],
        eligible_chunk_ids: frozenset[uuid.UUID] | None = None,
    ) -> list[str]:
        async with self._sm() as session:
            query = select(models.Chunk.id).where(
                chunk_visibility_clause(scope, forbidden),
                models.Chunk.document_id.in_([uuid.UUID(d) for d in docs]),
                models.Chunk.embedding.is_not(None),
                models.Chunk.needs_review.is_(False),
            )
            if eligible_chunk_ids is not None:
                query = query.where(models.Chunk.id.in_(eligible_chunk_ids))
            # The width cap is applied last, after every narrowing filter, so a bounded expansion
            # keeps the chunks it is allowed to see rather than a prefix of the unfiltered set.
            rows = await session.scalars(query.order_by(models.Chunk.id).limit(MAX_RETRIEVAL_WIDTH))
            return [str(c) for c in rows]

    async def _hard_window_map(self, scope: ProjectScope) -> dict[str, int]:
        """`{topic_slug: hard_window_days}` for the project's topics that set a horizon (FR-16.3)."""
        async with self._sm() as session:
            rows = await session.execute(
                select(models.Topic.slug, models.Topic.hard_window_days).where(
                    models.Topic.project_id == uuid.UUID(scope.project_id),
                    models.Topic.hard_window_days.is_not(None),
                )
            )
            return {slug: days for slug, days in rows.all() if days is not None}

    async def _load_candidates(
        self,
        scope: ProjectScope,
        vector: Sequence[float],
        candidate_ids: list[str],
        *,
        show_superseded: bool = False,
        mode: TemporalMode | None = None,
        now: dt.date | None = None,
        hard_windows: dict[str, int] | None = None,
    ) -> list[_Candidate]:
        if not candidate_ids:
            return []
        mode = mode or TemporalMode(TemporalKind.CURRENT)
        now = now or dt.datetime.now(dt.UTC).date()
        hard_windows = hard_windows or {}
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
                # The strictest horizon among this chunk's tagged topics (only bites in `current`).
                windows = [hard_windows[t] for t in tags if t in hard_windows]
                window = min(windows) if windows else None
                claim = await self._claim_aggregate(
                    session,
                    scope,
                    cid,
                    show_superseded=show_superseded,
                    mode=mode,
                    now=now,
                    hard_window_days=window,
                )
                # Drop a chunk only if it HAD claims that the temporal window all removed (e.g. an
                # obsolete price). A chunk that never had claims (plain prose) stays recallable.
                if claim.had_claims and not claim.claim_ids:
                    continue
                # R22: render the surviving CLAIMS, not the chunk they came from. The temporal filter
                # selects claims, so returning the chunk hands back whatever else it contains —
                # including the sentence the store has already retired. A chunk with no claims at all
                # (plain prose) still renders as itself.
                rendered = "\n".join(claim.claim_texts) if claim.claim_texts else text
                candidates.append(
                    _Candidate(
                        chunk_id=str(cid),
                        text=rendered,
                        tags=tuple(tags),
                        page=page,
                        document_id=str(document_id),
                        document_title=title or str(document_id),
                        similarity=float(sim),
                        claim_ids=claim.claim_ids,
                        credibility=claim.credibility,
                        importance=claim.importance,
                        valid_from=claim.valid_from,
                        valid_to=claim.valid_to,
                        is_current=claim.is_current,
                        disputed=claim.disputed,
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
        mode: TemporalMode | None = None,
        now: dt.date | None = None,
        hard_window_days: int | None = None,
    ) -> _ClaimAggregate:
        mode = mode or TemporalMode(TemporalKind.CURRENT)
        # The real current instant — a claim superseded earlier TODAY (valid_to a timestamp today)
        # must count as expired, so we compare against now, not midnight (the `now` date param only
        # anchors the classifier/score elsewhere).
        del now
        now_ts = dt.datetime.now(dt.UTC)
        # The permission boundary (project + pending) is always in the query; the temporal window
        # is a per-claim relevance cut on this already-authorized, chunk-scoped set (FR-16.2).
        base: list[Any] = [
            models.Claim.chunk_id == chunk_id,
            models.Claim.project_id == uuid.UUID(scope.project_id),
            models.Claim.pending_confirmation.is_(False),  # never surface unconfirmed claims
        ]
        conditions: list[Any] = [
            *base,
            *self._temporal_conditions(mode, now_ts, show_superseded, hard_window_days),
        ]
        rows = (
            await session.execute(
                select(
                    models.Claim.id,
                    models.Claim.credibility,
                    models.Claim.importance,
                    models.Claim.valid_from,
                    models.Claim.valid_to,
                    models.Claim.text,
                    models.Claim.disputed,
                )
                .where(*conditions)
                .order_by(models.Claim.valid_from.nulls_last(), models.Claim.id)
            )
        ).all()
        had_claims = bool(await session.scalar(select(models.Claim.id).where(*base).limit(1)))

        claim_ids: list[str] = []
        claim_texts: list[str] = []
        credibilities: list[float] = []
        importances: list[float] = []
        valid_from: dt.date | None = None
        valid_to: dt.date | None = None
        any_open = False
        any_current = False
        any_disputed = False
        for cid, credibility, importance, cvf, cvt, claim_text, claim_disputed in rows:
            claim_ids.append(str(cid))
            if claim_text:
                claim_texts.append(str(claim_text))
            any_disputed = any_disputed or bool(claim_disputed)
            if credibility is not None:
                credibilities.append(float(credibility))
            if importance is not None:
                importances.append(float(importance))
            if cvf is not None:
                cvf_d = cvf.date()
                valid_from = cvf_d if valid_from is None else min(valid_from, cvf_d)
            if cvt is None:
                any_open = True
            else:
                cvt_d = cvt.date()
                valid_to = cvt_d if valid_to is None else max(valid_to, cvt_d)
            any_current = any_current or is_active_at(cvf, cvt, now_ts)
        # Historical reads can include past or future claims, but only an interval containing now is
        # labelled current. A null end is therefore insufficient for a future-start claim.
        is_current = any_current
        return _ClaimAggregate(
            claim_ids=tuple(claim_ids),
            credibility=_mean(credibilities),
            importance=_mean(importances),
            valid_from=valid_from,
            valid_to=None if any_open else valid_to,
            is_current=is_current,
            had_claims=had_claims,
            claim_texts=tuple(claim_texts),
            disputed=any_disputed,
        )

    @staticmethod
    def _temporal_conditions(
        mode: TemporalMode, now_ts: dt.datetime, show_superseded: bool, hard_window_days: int | None
    ) -> list[Any]:
        vf, vt = models.Claim.valid_from, models.Claim.valid_to
        if mode.kind is TemporalKind.AS_OF and mode.as_of is not None:
            anchor = _midnight(mode.as_of)
            return [active_at_clause(vf, vt, anchor)]
        if mode.kind is TemporalKind.RANGE and mode.start and mode.end:
            # AUDIT-123: `[start, end)`. This was `vf <= end`, so a claim whose validity begins at
            # the instant that ENDS the range was counted as valid during it — measured on the
            # corpus, "the Acme support SLA in 2023" returned the claim effective 2024-01-01. Every
            # other valid-time comparison in this product is half-open; this one was not, and it
            # only became reachable when AUDIT-117 let a natural question produce a RANGE at all.
            return [
                or_(vf.is_(None), vf < _midnight(mode.end)),
                or_(vt.is_(None), vt > _midnight(mode.start)),
            ]
        if mode.kind is TemporalKind.HISTORICAL:
            return []  # the whole timeline (expired claims included, labelled by valid_to)
        # CURRENT (default): exclude expired/superseded unless an admin asked to see them, and
        # apply the per-topic hard horizon (FR-16.3).
        # An administrator may widen the end side to inspect superseded knowledge, but a future
        # start is never current knowledge and may not enter this candidate set.
        conds: list[Any] = [or_(vf.is_(None), vf <= now_ts)]
        if not show_superseded:
            conds.append(active_at_clause(vf, vt, now_ts))
        if hard_window_days is not None:
            cutoff = now_ts - dt.timedelta(days=hard_window_days)
            conds.append(or_(vf.is_(None), vf >= cutoff))
        return conds

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
                        "chunk_id": candidate.chunk_id,
                        "page": candidate.page,
                        "claim_ids": list(candidate.claim_ids),
                        "credibility": round(candidate.credibility or 0.5, 4),
                        "tags": list(candidate.tags),
                        # R24: carried in the provenance AND on the fragment, so neither a client
                        # reading the payload nor one reading the typed field can miss it.
                        "disputed": candidate.disputed,
                    },
                    valid_from=candidate.valid_from,
                    valid_to=candidate.valid_to,
                    is_current=candidate.is_current,
                    disputed=candidate.disputed,
                    untrusted_data=True,
                )
            )
        return tuple(fragments)
