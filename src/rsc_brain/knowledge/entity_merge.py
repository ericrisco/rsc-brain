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

import datetime as dt
import uuid
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.audit import record_audit_in_session
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
from rsc_brain.stores.age_graph_store import (
    AgeGraphStore,
    GraphEdgeState,
    GraphMergeConflictError,
    GraphNodeMergeState,
)
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.entity_store import (
    AliasState,
    EntityRow,
    EntityStore,
    MergeInvariantError,
    MergeReversalConflictError,
)

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
    #: `applied` | `rejected` | `refused`. T022 re-audit: `refused` used to be reported as `rejected`,
    #: so a caller could not tell "the proposal is now rejected" from "your request was declined because
    #: someone already applied it" — the explanation said so in prose and the status said the opposite.
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


def choose_canonical(entities: Sequence[EntityRow]) -> EntityRow:
    """Choose by semantic richness; UUID is only the final stable tie-breaker."""
    if not entities:
        raise MergeInvariantError("canonical selection needs at least one entity")
    if len({entity.type for entity in entities}) != 1:
        raise MergeInvariantError("merge entities must have the same type")
    return sorted(
        entities,
        key=lambda entity: (
            -len(entity.aliases),
            -len(entity.name),
            entity.normalized_name,
            entity.id,
        ),
    )[0]


def _orient(a: EntityRow, b: EntityRow) -> tuple[EntityRow, EntityRow]:
    canonical = choose_canonical((a, b))
    return (canonical, b if canonical.id == a.id else a)


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
                outcome = await self.apply_candidate(
                    scope,
                    candidate,
                    status=PROPOSAL_AUTO_APPLIED,
                )
                if outcome.status == "applied":
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
                proposal = await self._store.get_proposal(scope, proposal_id)
                if proposal is not None and proposal.status == PROPOSAL_OPEN:
                    queued.append(proposal_id)
        return ProposeSummary(auto_applied=auto_applied, queued=queued)

    async def apply_candidate(
        self,
        scope: ProjectScope,
        candidate: MergeCandidate,
        *,
        status: str = PROPOSAL_AUTO_APPLIED,
        resolved_by: str | None = None,
    ) -> MergeOutcome:
        """Create an observable open proposal, then apply it through the ordinary lifecycle.

        Auto and ontology candidates use this entry point. Proposal creation is deliberately its
        own durable step: a process interruption can leave an open proposal, but never a merge with
        no proposal. Retrying the same pair reuses that proposal and either completes it once or
        observes its already-resolved state.
        """
        if status not in {PROPOSAL_APPLIED, PROPOSAL_AUTO_APPLIED}:
            raise ValueError("an applied candidate needs an applied proposal status")
        proposal_id, _ = await self._store.create_proposal(
            scope,
            canonical_id=candidate.canonical_id,
            duplicate_id=candidate.duplicate_id,
            confidence=candidate.confidence,
            method=self._method,
            status=PROPOSAL_OPEN,
            reason=candidate.reason,
        )
        return await self._apply_proposal(
            scope,
            proposal_id,
            status=status,
            resolved_by=resolved_by,
        )

    async def confirm(
        self, scope: ProjectScope, proposal_id: str, *, resolved_by: str | None = None
    ) -> MergeOutcome:
        return await self._apply_proposal(
            scope,
            proposal_id,
            status=PROPOSAL_APPLIED,
            resolved_by=resolved_by,
        )

    async def reject(
        self, scope: ProjectScope, proposal_id: str, *, resolved_by: str | None = None
    ) -> MergeOutcome:
        async with session_scope(self._sm) as unit:
            proposal = await self._locked_proposal(unit, scope, proposal_id)
            if proposal is None:
                return MergeOutcome(status="refused", explanation="Proposal not found.")
            if proposal.status != PROPOSAL_OPEN:
                return MergeOutcome(
                    status="refused",
                    explanation=f"Cannot reject a {proposal.status} proposal.",
                    proposal_id=proposal_id,
                )
            proposal.status = PROPOSAL_REJECTED
            proposal.resolved_by = resolved_by or scope.principal_id
            proposal.resolved_at = _now()
            await record_audit_in_session(
                unit,
                scope,
                action="entity_merge_reject",
                tool="entities",
                result_count=0,
                trace_id=proposal_id,
            )
        return MergeOutcome(
            status="rejected", explanation="Proposal rejected.", proposal_id=proposal_id
        )

    async def reverse(
        self,
        scope: ProjectScope,
        proposal_id: str,
        *,
        resolved_by: str | None = None,
    ) -> MergeOutcome:
        """Restore one applied cycle exactly, refusing to overwrite later writes."""
        async with session_scope(self._sm) as unit:
            proposal = await self._locked_proposal(unit, scope, proposal_id)
            if proposal is None:
                return MergeOutcome(status="refused", explanation="Proposal not found.")
            if proposal.status not in {PROPOSAL_APPLIED, PROPOSAL_AUTO_APPLIED}:
                return MergeOutcome(
                    status="refused",
                    explanation=f"Cannot reverse a {proposal.status} proposal.",
                    proposal_id=proposal_id,
                )
            snapshot = await unit.scalar(
                select(models.EntityMergeSnapshot)
                .where(
                    models.EntityMergeSnapshot.project_id == _pid(scope),
                    models.EntityMergeSnapshot.proposal_id == uuid.UUID(proposal_id),
                    models.EntityMergeSnapshot.reversed_at.is_(None),
                )
                .with_for_update()
            )
            if snapshot is None:
                raise MergeReversalConflictError("active merge snapshot is missing")

            aliases_before = tuple(AliasState.from_json(value) for value in snapshot.aliases_before)
            aliases_after = tuple(AliasState.from_json(value) for value in snapshot.aliases_after)
            graph_before = tuple(GraphEdgeState.from_json(value) for value in snapshot.graph_before)
            graph_after = tuple(GraphEdgeState.from_json(value) for value in snapshot.graph_after)
            node_before = GraphNodeMergeState.from_json(snapshot.duplicate_node_before)
            node_after = GraphNodeMergeState.from_json(snapshot.duplicate_node_after)
            canonical_id = str(snapshot.canonical_entity_id)
            duplicate_id = str(snapshot.duplicate_entity_id)
            if (
                proposal.canonical_entity_id != snapshot.canonical_entity_id
                or proposal.duplicate_entity_id != snapshot.duplicate_entity_id
            ):
                raise MergeReversalConflictError("proposal changed after merge")
            current_node_ids = await self._graph_node_ids(
                unit,
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                applied=True,
            )
            canonical_node = snapshot.canonical_graph_node_id
            duplicate_node = snapshot.duplicate_graph_node_id
            if current_node_ids != (canonical_node, duplicate_node):
                raise MergeReversalConflictError("entity identity changed after merge")

            current_graph = await self._graph.active_incident_edges(
                scope,
                (canonical_node, duplicate_node),
                session=unit,
            )
            if current_graph != graph_after:
                raise MergeReversalConflictError("graph changed after merge")
            current_node = await self._graph.merge_marker_state(
                scope,
                duplicate_node,
                session=unit,
            )
            if current_node != node_after:
                raise MergeReversalConflictError("graph node changed after merge")
            await self._store.restore_alias_states(
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                before=aliases_before,
                expected_after=aliases_after,
                session=unit,
            )
            try:
                await self._graph.restore_merged_nodes(
                    scope,
                    canonical_node,
                    duplicate_node,
                    before=graph_before,
                    expected_after=graph_after,
                    node_before=node_before,
                    expected_node_after=node_after,
                    merge_id=proposal_id,
                    reversal_id=str(snapshot.id),
                    session=unit,
                )
            except GraphMergeConflictError as exc:
                raise MergeReversalConflictError("graph changed after merge") from exc

            reversed_by = resolved_by or scope.principal_id
            proposal.status = snapshot.previous_proposal_status
            proposal.resolved_by = None
            proposal.resolved_at = None
            snapshot.reversed_at = _now()
            snapshot.reversed_by = reversed_by
            await record_audit_in_session(
                unit,
                scope,
                action="entity_unmerge",
                tool="entities",
                result_count=len(graph_before),
                trace_id=str(snapshot.id),
            )
        return MergeOutcome(
            status="reversed",
            explanation="Restored the exact pre-merge entity and graph state.",
            proposal_id=proposal_id,
            repointed_edges=len(graph_before),
        )

    async def _apply_proposal(
        self,
        scope: ProjectScope,
        proposal_id: str,
        *,
        status: str,
        resolved_by: str | None,
    ) -> MergeOutcome:
        """Apply all relational, graph, lifecycle, snapshot and audit effects in one transaction."""
        async with session_scope(self._sm) as unit:
            proposal = await self._locked_proposal(unit, scope, proposal_id)
            if proposal is None:
                return MergeOutcome(status="refused", explanation="Proposal not found.")
            if proposal.status != PROPOSAL_OPEN:
                return MergeOutcome(
                    status="refused",
                    explanation=f"Cannot confirm a {proposal.status} proposal.",
                    proposal_id=proposal_id,
                )
            candidate = MergeCandidate(
                canonical_id=str(proposal.canonical_entity_id),
                duplicate_id=str(proposal.duplicate_entity_id),
                confidence=float(proposal.confidence),
                reason=proposal.reason or "",
            )
            await self._store.validate_pair(
                scope,
                canonical_id=candidate.canonical_id,
                duplicate_id=candidate.duplicate_id,
                session=unit,
                lock=True,
            )
            aliases_before = await self._store.alias_states(
                scope,
                (candidate.canonical_id, candidate.duplicate_id),
                session=unit,
            )
            canonical_node, duplicate_node = await self._graph_node_ids(
                unit,
                scope,
                canonical_id=candidate.canonical_id,
                duplicate_id=candidate.duplicate_id,
                applied=False,
            )
            graph_before = await self._graph.active_incident_edges(
                scope,
                (canonical_node, duplicate_node),
                session=unit,
            )
            node_before = await self._graph.merge_marker_state(
                scope,
                duplicate_node,
                session=unit,
            )
            await self._store.apply_merge(
                scope,
                canonical_id=candidate.canonical_id,
                duplicate_id=candidate.duplicate_id,
                confidence=candidate.confidence,
                session=unit,
            )
            edges = await self._graph.merge_nodes(
                scope,
                canonical_node,
                duplicate_node,
                merge_id=proposal_id,
                session=unit,
            )
            aliases_after = await self._store.alias_states(
                scope,
                (candidate.canonical_id, candidate.duplicate_id),
                session=unit,
            )
            graph_after = await self._graph.active_incident_edges(
                scope,
                (canonical_node, duplicate_node),
                session=unit,
            )
            node_after = await self._graph.merge_marker_state(
                scope,
                duplicate_node,
                session=unit,
            )
            snapshot = models.EntityMergeSnapshot(
                project_id=_pid(scope),
                proposal_id=proposal.id,
                canonical_entity_id=proposal.canonical_entity_id,
                duplicate_entity_id=proposal.duplicate_entity_id,
                canonical_graph_node_id=canonical_node,
                duplicate_graph_node_id=duplicate_node,
                previous_proposal_status=proposal.status,
                aliases_before=[state.as_json() for state in aliases_before],
                aliases_after=[state.as_json() for state in aliases_after],
                graph_before=[state.as_json() for state in graph_before],
                graph_after=[state.as_json() for state in graph_after],
                duplicate_node_before=node_before.as_json(),
                duplicate_node_after=node_after.as_json(),
            )
            unit.add(snapshot)
            proposal.status = status
            proposal.resolved_by = resolved_by or scope.principal_id
            proposal.resolved_at = _now()
            await unit.flush()
            await record_audit_in_session(
                unit,
                scope,
                action="entity_merge",
                tool="entities",
                result_count=edges,
                trace_id=str(snapshot.id),
            )
        return MergeOutcome(
            status="applied",
            explanation="Merged the duplicate entity into the canonical one.",
            proposal_id=proposal_id,
            repointed_edges=edges,
        )

    async def _locked_proposal(
        self,
        session: AsyncSession,
        scope: ProjectScope,
        proposal_id: str,
    ) -> models.EntityMergeProposal | None:
        proposal: models.EntityMergeProposal | None = await session.scalar(
            select(models.EntityMergeProposal)
            .where(
                models.EntityMergeProposal.id == uuid.UUID(proposal_id),
                models.EntityMergeProposal.project_id == _pid(scope),
            )
            .with_for_update()
        )
        return proposal

    async def _graph_node_ids(
        self,
        session: AsyncSession,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        applied: bool,
    ) -> tuple[str, str]:
        if applied:
            canonical, duplicate = await self._store.locked_applied_pair(
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                session=session,
            )
        else:
            canonical, duplicate = await self._store.validate_pair(
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                session=session,
            )
        return (
            str(entity_id(canonical.type, canonical.name)),
            str(entity_id(duplicate.type, duplicate.name)),
        )


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)
