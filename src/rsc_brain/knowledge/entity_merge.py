"""Alias-merge of duplicate entities (SPEC-09, FR-1.9 P1).

A *proposer* looks at the live entities of a project (same type only) and proposes merges with a
confidence. The :class:`EntityMergeService` then either **auto-applies** high-confidence proposals
(config threshold) or queues low-confidence ones as ``needs_review`` for an owner to ``confirm`` or
``reject``. Applying a merge re-points the duplicate's relational aliases + graph edges onto the
canonical entity, tombstones the duplicate, and writes an audit row. A merge never crosses a
project (:class:`~rsc_brain.stores.relational.entity_store.CrossProjectMergeError`, FR-12.4).

Two proposers ship: :class:`DeterministicMergeProposer` (char-bigram Dice similarity over names +
aliases — drives CI, no model) and :class:`LlmMergeProposer` (a versioned prompt via the gateway —
the seam for a live model, blocked-by-resource in CI). Both are conservative: the point is to never
merge two genuinely distinct entities, so ambiguous cases wait for a human.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.audit import record_audit
from rsc_brain.config.models import Capability, KnowledgeConfig
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.review.states import (
    PROPOSAL_APPLIED,
    PROPOSAL_AUTO_APPLIED,
    PROPOSAL_OPEN,
    PROPOSAL_REJECTED,
)
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational.entity_store import EntityRow, EntityStore

MERGE_PROMPT_VERSION = "entity-merge-v1"


@dataclass(frozen=True, slots=True)
class MergeCandidate:
    canonical_id: str
    duplicate_id: str
    confidence: float
    reason: str


@dataclass(frozen=True, slots=True)
class ProposeSummary:
    auto_applied: list[str] = field(default_factory=list)
    queued: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class MergeOutcome:
    status: str
    explanation: str
    proposal_id: str | None = None
    repointed_edges: int = 0


def _bigrams(text: str) -> Counter[str]:
    return Counter(text[i : i + 2] for i in range(len(text) - 1))


def dice_coefficient(a: str, b: str) -> float:
    """Sørensen-Dice similarity over character bigrams (0..1). Robust to short surface
    differences (punctuation, casing already normalised out by the caller)."""
    if a == b:
        return 1.0
    if len(a) < 2 or len(b) < 2:
        return 1.0 if a == b else 0.0
    bg_a, bg_b = _bigrams(a), _bigrams(b)
    overlap = sum((bg_a & bg_b).values())
    total = sum(bg_a.values()) + sum(bg_b.values())
    return (2.0 * overlap) / total if total else 0.0


def _surface_forms(entity: EntityRow) -> set[str]:
    forms = {normalize_name(entity.name)}
    forms.update(normalize_name(a) for a in entity.aliases)
    return {f for f in forms if f}


def entity_similarity(a: EntityRow, b: EntityRow) -> float:
    """Best pairwise similarity across the two entities' surface forms (name + aliases). An exact
    shared form (e.g. one lists the other's name as an alias) scores 1.0."""
    forms_a, forms_b = _surface_forms(a), _surface_forms(b)
    if forms_a & forms_b:
        return 1.0
    best = 0.0
    for fa in forms_a:
        for fb in forms_b:
            best = max(best, dice_coefficient(fa, fb))
    return best


def _orient(a: EntityRow, b: EntityRow) -> tuple[EntityRow, EntityRow]:
    """Pick the canonical (fuller record): more aliases, then longer name, then stable by id."""
    key_a = (len(a.aliases), len(a.name), b.id)
    key_b = (len(b.aliases), len(b.name), a.id)
    return (a, b) if key_a >= key_b else (b, a)


class EntityMergeProposer(Protocol):
    async def propose(self, entities: Sequence[EntityRow]) -> list[MergeCandidate]: ...


class DeterministicMergeProposer:
    """No-model proposer: proposes a merge for every same-type pair whose similarity clears
    ``min_similarity``. Confidence is the similarity itself."""

    def __init__(self, *, min_similarity: float) -> None:
        self._min = min_similarity

    async def propose(self, entities: Sequence[EntityRow]) -> list[MergeCandidate]:
        by_type: dict[str, list[EntityRow]] = {}
        for entity in entities:
            by_type.setdefault(entity.type, []).append(entity)
        candidates: list[MergeCandidate] = []
        for group in by_type.values():
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    score = entity_similarity(group[i], group[j])
                    if score >= self._min:
                        canonical, duplicate = _orient(group[i], group[j])
                        candidates.append(
                            MergeCandidate(
                                canonical_id=canonical.id,
                                duplicate_id=duplicate.id,
                                confidence=round(score, 4),
                                reason=f"name similarity {score:.2f}: "
                                f"'{duplicate.name}' ~ '{canonical.name}'",
                            )
                        )
        return candidates


class _MergePair(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a: str
    b: str
    confidence: float = 0.5


class _MergePairsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pairs: list[_MergePair] = []


class LlmMergeProposer:
    """Model-assisted proposer (seam). Asks the gateway which same-type entities are the same
    real-world thing, with a confidence. Live use is blocked-by-resource; the parsing +
    orientation are exercised via a canned completion, mirroring SPEC-08's ``LlmJudge``."""

    def __init__(self, gateway: ModelGateway, *, min_confidence: float) -> None:
        self._gateway = gateway
        self._min = min_confidence

    async def propose(self, entities: Sequence[EntityRow]) -> list[MergeCandidate]:
        by_id = {e.id: e for e in entities}
        by_type: dict[str, list[EntityRow]] = {}
        for entity in entities:
            by_type.setdefault(entity.type, []).append(entity)
        candidates: list[MergeCandidate] = []
        for etype, group in by_type.items():
            if len(group) < 2:
                continue
            listing = "\n".join(
                f"- id={e.id} name={e.name!r} aliases={list(e.aliases)}" for e in group
            )
            messages = [
                {
                    "role": "system",
                    "content": f"[{MERGE_PROMPT_VERSION}] You deduplicate knowledge-graph "
                    "entities. Identify pairs that are the SAME real-world entity. Be "
                    "conservative — only pairs you are certain about.",
                },
                {"role": "user", "content": f"Entities of type {etype!r}:\n{listing}"},
            ]
            try:
                out = await self._gateway.complete_structured(
                    Capability.EXTRACTOR, messages, _MergePairsOut
                )
            except GatewayError:
                continue  # a proposer failure yields no merge — never a wrong merge
            for pair in out.pairs:
                left, right = by_id.get(pair.a), by_id.get(pair.b)
                if left is None or right is None or pair.confidence < self._min:
                    continue
                canonical, duplicate = _orient(left, right)
                candidates.append(
                    MergeCandidate(
                        canonical_id=canonical.id,
                        duplicate_id=duplicate.id,
                        confidence=round(pair.confidence, 4),
                        reason=f"llm merge ({pair.confidence:.2f})",
                    )
                )
        return candidates


class EntityMergeService:
    def __init__(
        self,
        *,
        store: EntityStore,
        graph: AgeGraphStore,
        # Optional: resolving a proposal proposes nothing, and the console path needs to build
        # this service for resolution alone (R25).
        proposer: EntityMergeProposer | None = None,
        sessionmaker: async_sessionmaker[AsyncSession],
        method: str = "deterministic",
        config: KnowledgeConfig | None = None,
    ) -> None:
        self._store = store
        self._graph = graph
        self._proposer = proposer
        self._sm = sessionmaker
        self._method = method
        self._config = config or KnowledgeConfig()

    async def propose(self, scope: ProjectScope) -> ProposeSummary:
        if self._proposer is None:
            raise ValueError("this service was built for resolution only and has no proposer")
        entities = await self._store.list_active_entities(scope)
        candidates = await self._proposer.propose(entities)
        auto_applied: list[str] = []
        queued: list[str] = []
        for candidate in candidates:
            if candidate.confidence >= self._config.merge_auto_apply_confidence:
                await self._apply(scope, candidate, status=PROPOSAL_AUTO_APPLIED)
                auto_applied.append(candidate.duplicate_id)
            else:
                proposal_id, _ = await self._store.create_proposal(
                    scope,
                    canonical_id=candidate.canonical_id,
                    duplicate_id=candidate.duplicate_id,
                    confidence=candidate.confidence,
                    method=self._method,
                    status=PROPOSAL_OPEN,
                    reason=candidate.reason,
                )
                queued.append(proposal_id)
        return ProposeSummary(auto_applied=auto_applied, queued=queued)

    async def confirm(
        self, scope: ProjectScope, proposal_id: str, *, resolved_by: str | None = None
    ) -> MergeOutcome:
        proposal = await self._store.get_proposal(scope, proposal_id)
        if proposal is None:
            return MergeOutcome(status="rejected", explanation="Proposal not found.")
        if proposal.status != PROPOSAL_OPEN:
            return MergeOutcome(
                status="rejected",
                explanation=f"Cannot confirm a {proposal.status} proposal.",
                proposal_id=proposal_id,
            )
        candidate = MergeCandidate(
            canonical_id=proposal.canonical_entity_id,
            duplicate_id=proposal.duplicate_entity_id,
            confidence=proposal.confidence,
            reason=proposal.reason or "",
        )
        edges = await self._apply(
            scope,
            candidate,
            status=PROPOSAL_APPLIED,
            proposal_id=proposal_id,
            resolved_by=resolved_by,
        )
        return MergeOutcome(
            status="applied",
            explanation="Merged the duplicate entity into the canonical one.",
            proposal_id=proposal_id,
            repointed_edges=edges,
        )

    async def reject(
        self, scope: ProjectScope, proposal_id: str, *, resolved_by: str | None = None
    ) -> MergeOutcome:
        proposal = await self._store.get_proposal(scope, proposal_id)
        if proposal is None:
            return MergeOutcome(status="rejected", explanation="Proposal not found.")
        if proposal.status != PROPOSAL_OPEN:
            return MergeOutcome(
                status="rejected",
                explanation=f"Cannot reject a {proposal.status} proposal.",
                proposal_id=proposal_id,
            )
        await self._store.set_proposal_status(
            scope,
            proposal_id,
            status=PROPOSAL_REJECTED,
            resolved_by=resolved_by or scope.principal_id,
        )
        await record_audit(
            self._sm, scope, action="entity_merge_reject", tool="entities", result_count=0
        )
        return MergeOutcome(
            status="rejected", explanation="Proposal rejected.", proposal_id=proposal_id
        )

    async def _apply(
        self,
        scope: ProjectScope,
        candidate: MergeCandidate,
        *,
        status: str,
        proposal_id: str | None = None,
        resolved_by: str | None = None,
    ) -> int:
        result = await self._store.apply_merge(
            scope,
            canonical_id=candidate.canonical_id,
            duplicate_id=candidate.duplicate_id,
            confidence=candidate.confidence,
        )
        # Graph node ids are deterministic uuid5(type, name) (SPEC-05); re-point the duplicate's
        # edges onto the canonical node and tombstone the duplicate node.
        canonical_node = str(entity_id(result.canonical_type, result.canonical_name))
        duplicate_node = str(entity_id(result.canonical_type, result.duplicate_name))
        edges = await self._graph.merge_nodes(scope, canonical_node, duplicate_node)
        if proposal_id is not None:
            await self._store.set_proposal_status(
                scope, proposal_id, status=status, resolved_by=resolved_by or scope.principal_id
            )
        elif status == PROPOSAL_AUTO_APPLIED:
            await self._store.create_proposal(
                scope,
                canonical_id=candidate.canonical_id,
                duplicate_id=candidate.duplicate_id,
                confidence=candidate.confidence,
                method=self._method,
                status=PROPOSAL_AUTO_APPLIED,
                reason=candidate.reason,
            )
        await record_audit(
            self._sm, scope, action="entity_merge", tool="entities", result_count=edges
        )
        return edges
