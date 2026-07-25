"""Report disagreement between the relational store and the graph (AUDIT-039 / R35).

The write paths now commit both halves in one transaction, so a divergence cannot be *introduced* any
more. That is not the same as knowing there is none: an install upgraded from an earlier version, a
manual repair, a partial restore, or a bug in a future change can all leave the two stores saying
different things, and until now nobody could ask.

Read-only, project-scoped, and shaped like the tenant preflight (R17): it reports, and deciding what to
do about a divergence is an operator's call.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, edge_type
from rsc_brain.stores.relational import models


@dataclass(frozen=True, slots=True)
class DivergenceReport:
    """What each store asserts that the other does not."""

    project_id: str
    #: Live claims whose relation is missing from the graph — recall would answer, expansion would not.
    claims_without_relations: int
    #: Live graph relations no live claim supports — the graph answering with a retired fact.
    relations_without_claims: int
    #: The claim identities behind ``claims_without_relations``, capped for a readable report.
    examples: tuple[str, ...] = ()

    @property
    def diverged(self) -> bool:
        return bool(self.claims_without_relations or self.relations_without_claims)

    def explain(self) -> str:
        if not self.diverged:
            return f"project {self.project_id}: the relational store and the graph agree."
        return (
            f"project {self.project_id}: {self.claims_without_relations} live claim(s) have no graph "
            f"relation and {self.relations_without_claims} live relation(s) have no live claim. "
            "Re-ingesting the affected documents rewrites both halves (publish is idempotent); "
            f"examples: {', '.join(self.examples) or 'n/a'}"
        )


#: A report is a diagnostic, not a scan of the whole corpus: it bounds its own work and says so.
_SAMPLE = 500


async def divergence_report(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> DivergenceReport:
    """Compare the claims that assert a relation against the relations the graph actually holds."""
    pid = uuid.UUID(scope.project_id)
    async with sessionmaker() as session:
        rows = (
            await session.execute(
                select(
                    models.Claim.id,
                    models.Claim.subject_entity_key,
                    models.Claim.predicate,
                    models.Claim.object_entity_key,
                )
                .where(
                    models.Claim.project_id == pid,
                    models.Claim.valid_to.is_(None),
                    models.Claim.pending_confirmation.is_(False),
                    models.Claim.subject_entity_key.is_not(None),
                    models.Claim.object_entity_key.is_not(None),
                    models.Claim.predicate.is_not(None),
                )
                .limit(_SAMPLE)
            )
        ).all()
    graph = AgeGraphStore(sessionmaker)
    expected = {
        (str(r[1]), str(r[2]), str(r[3])): str(r[0]) for r in rows
    }  # one claim id per relation is enough to point an operator at it
    missing: list[str] = []
    for (subject, predicate, obj), claim_id in expected.items():
        present = await graph.run_cypher(
            scope,
            f"MATCH (a {{id: $src}})-[r:{edge_type(predicate)}]->(b {{id: $dst}}) "
            "WHERE r.superseded IS NULL RETURN count(r) AS result",
            {"src": subject, "dst": obj},
        )
        found = present[0]["result"] if present else 0
        if not found:
            missing.append(claim_id)
    orphaned = await _relations_without_claims(graph, scope, set(expected))
    return DivergenceReport(
        project_id=scope.project_id,
        claims_without_relations=len(missing),
        relations_without_claims=orphaned,
        examples=tuple(missing[:5]),
    )


async def _relations_without_claims(
    graph: AgeGraphStore, scope: ProjectScope, expected: set[tuple[str, str, str]]
) -> int:
    """Live entity→entity relations that no sampled live claim asserts.

    Only relations between typed entity nodes are compared: provenance edges (``SUPERSEDES``,
    ``CORRECTED_BY``) describe decisions rather than facts, and no claim asserts them.
    """
    asserted = {(subject, edge_type(predicate), obj) for subject, predicate, obj in expected}
    triples = await graph.relation_triples(scope, limit=_SAMPLE)
    return sum(1 for triple in triples if triple not in asserted)
