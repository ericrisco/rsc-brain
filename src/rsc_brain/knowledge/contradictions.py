"""Contradiction detection + resolution (FR-5.2/5.3/5.5).

Candidates are claim pairs with cosine similarity > threshold AND a shared entity (proxied by a
shared normalized subject/object) — both required. Each pair's verdict is cached per ordered pair
+ judge version; only uncached pairs hit the judge. On ``contradict`` the higher-credibility claim
wins (+boost, cap 1.0); the loser is degraded (xfactor) and superseded (`valid_to=now`, a
``SUPERSEDES`` graph edge) — never deleted (FR-5.5). A near-tie (`|deltacred| < tie_delta`) marks both
``disputed`` and a hunting candidate (the hunt is SPEC-15).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.ingest.entity_resolution import normalize_name
from rsc_brain.knowledge.credibility import clamp
from rsc_brain.knowledge.judge import Judge, Verdict
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational.knowledge_store import ClaimData, KnowledgeStore

_CLAIM_LABEL = "Claim"
_SUPERSEDES = "SUPERSEDES"


@dataclass(frozen=True, slots=True)
class ResolutionSummary:
    pairs_examined: int = 0
    judge_calls: int = 0
    contradictions: int = 0
    superseded: list[str] = field(default_factory=list)
    disputed: list[str] = field(default_factory=list)


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _entities(claim: ClaimData) -> set[str]:
    return {normalize_name(v) for v in (claim.subject, claim.object) if v}


def candidate_pairs(
    claims: Sequence[ClaimData], *, sim_threshold: float
) -> list[tuple[ClaimData, ClaimData]]:
    """Pairs with sim > threshold AND ≥1 shared entity (both conditions mandatory, FR-5.2)."""
    pairs: list[tuple[ClaimData, ClaimData]] = []
    for i in range(len(claims)):
        for j in range(i + 1, len(claims)):
            a, b = claims[i], claims[j]
            if not (_entities(a) & _entities(b)):
                continue
            if cosine_similarity(a.embedding, b.embedding) > sim_threshold:
                pairs.append((a, b))
    return pairs


class ContradictionResolver:
    def __init__(
        self,
        *,
        store: KnowledgeStore,
        graph: AgeGraphStore,
        judge: Judge,
        config: KnowledgeConfig | None = None,
    ) -> None:
        self._store = store
        self._graph = graph
        self._judge = judge
        self._config = config or KnowledgeConfig()

    async def resolve_document(self, scope: ProjectScope, document_id: str) -> ResolutionSummary:
        """Detect + resolve contradictions among a document's active claims (on-ingest hook)."""
        return await self.resolve_claims(
            scope, await self._store.claims_for_document(scope, document_id)
        )

    async def resolve_ids(self, scope: ProjectScope, claim_ids: Sequence[str]) -> ResolutionSummary:
        """Detect + resolve among a set of claim ids (on-consume hook, FR-3.4)."""
        return await self.resolve_claims(scope, await self._store.claims_by_ids(scope, claim_ids))

    async def resolve_claims(
        self, scope: ProjectScope, claims: Sequence[ClaimData]
    ) -> ResolutionSummary:
        """Detect + resolve contradictions among a set of active claims."""
        pairs = candidate_pairs(claims, sim_threshold=self._config.contradiction_sim_threshold)
        judge_calls = 0
        contradictions = 0
        superseded: list[str] = []
        disputed: list[str] = []
        for a, b in pairs:
            verdict = await self._store.get_verdict(scope, a.id, b.id, self._judge.version)
            if verdict is None:
                result = await self._judge.judge(a.text, b.text)
                judge_calls += 1
                verdict = result.verdict.value
                await self._store.put_verdict(
                    scope, a.id, b.id, self._judge.version, verdict, result.confidence
                )
            if verdict != Verdict.CONTRADICT.value:
                continue
            contradictions += 1
            outcome = await self._resolve_pair(scope, a, b)
            superseded.extend(outcome[0])
            disputed.extend(outcome[1])
        return ResolutionSummary(
            pairs_examined=len(pairs),
            judge_calls=judge_calls,
            contradictions=contradictions,
            superseded=superseded,
            disputed=disputed,
        )

    async def _resolve_pair(
        self, scope: ProjectScope, a: ClaimData, b: ClaimData
    ) -> tuple[list[str], list[str]]:
        if abs(a.credibility - b.credibility) < self._config.tie_delta:
            # Tie → both disputed; a hunting candidate if the topic is sensitive or recalled.
            await self._store.mark_disputed(scope, [a.id, b.id], hunting_candidate=True)
            return [], [a.id, b.id]
        winner, loser = (a, b) if a.credibility >= b.credibility else (b, a)
        winner_cred = clamp(winner.credibility + self._config.winner_boost)
        loser_cred = clamp(loser.credibility * self._config.loser_factor)
        await self._store.apply_resolution(
            scope,
            winner_id=winner.id,
            loser_id=loser.id,
            winner_cred=winner_cred,
            loser_cred=loser_cred,
        )
        await self._write_supersedes(scope, winner.id, loser.id)
        return [loser.id], []

    async def _write_supersedes(self, scope: ProjectScope, winner_id: str, loser_id: str) -> None:
        """Record the SUPERSEDES provenance edge (winner → loser) in the project graph."""
        await self._graph.create_graph(scope)
        await self._graph.upsert_nodes(
            scope,
            [
                GraphNode(
                    id=winner_id, labels=frozenset({_CLAIM_LABEL}), properties={"kind": "claim"}
                ),
                GraphNode(
                    id=loser_id, labels=frozenset({_CLAIM_LABEL}), properties={"kind": "claim"}
                ),
            ],
        )
        await self._graph.upsert_edges(
            scope, [GraphEdge(source_id=winner_id, target_id=loser_id, type=_SUPERSEDES)]
        )
