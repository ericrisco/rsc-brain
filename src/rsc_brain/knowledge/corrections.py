"""Learning Layer — owner-authority corrections (FR-15.x, Bloque B).

`correct_knowledge` lets the **owner of a tag** (a Person RESPONSIBLE_FOR the topic, i.e. the tag
is in ``persons.topics``) authoritatively correct a claim, in one transaction, audited and
reversible. Statuses (§3.5): ``applied`` (owner, immediate), ``pending_confirmation`` (sensitive
tag → needs a second owner; the new claim is invisible to recall), ``routed_to_owner`` (a non-owner
human, or any agent — agents never correct, FR-15.10), ``needs_disambiguation`` (target ambiguous —
never guesses, FR-15.2), ``rejected`` (validation / rate limit / correction war).

Nothing is deleted: the superseded claim stays (``valid_to`` set), so a correction is fully
reversible (FR-15.8). ``dry_run`` previews without mutating.
"""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field

from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.entity_resolution import normalize_name
from rsc_brain.knowledge.graph_sync import GraphSync
from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational.knowledge_store import ClaimData, KnowledgeStore

SENSITIVITY_THRESHOLD = 3
_SUPERSEDED_BY = "SUPERSEDED_BY"
_CORRECTED_BY = "CORRECTED_BY"


@dataclass(frozen=True, slots=True)
class CorrectionOutcome:
    status: str
    explanation: str
    candidates: list[dict[str, str]] = field(default_factory=list)
    correction_id: str | None = None
    new_claim_id: str | None = None


class CorrectionService:
    def __init__(
        self,
        *,
        store: KnowledgeStore,
        graph: AgeGraphStore,
        gateway: ModelGateway,
        config: KnowledgeConfig | None = None,
    ) -> None:
        self._store = store
        self._graph = graph
        self._gateway = gateway
        self._config = config or KnowledgeConfig()
        self._graph_sync = GraphSync(store=store, graph=graph)

    async def correct(
        self,
        scope: ProjectScope,
        *,
        claim_id: str | None = None,
        topic: str | None = None,
        statement: str | None = None,
        correction: str,
        reason: str | None = None,
        on_behalf_of: str | None = None,
        dry_run: bool = False,
    ) -> CorrectionOutcome:
        # Attribution derives from the authenticated scope's *validated* delegation, never from the
        # client-supplied field (R15). A caller that asserts an identity the scope does not carry is
        # refused before any lookup or write: the previous code copied the raw string straight into
        # the durable `corrections.on_behalf_of`, so anyone could attribute a correction to anyone.
        # Revocation is handled by construction — the delegation was validated when the scope was
        # resolved, so a scope resolved after a revocation simply has no `on_behalf_of`.
        if on_behalf_of is not None and on_behalf_of != scope.on_behalf_of:
            return CorrectionOutcome(
                status="rejected",
                explanation="Attribution requires a valid delegation for this operation.",
            )

        target, candidates = await self._resolve_target(scope, claim_id, topic, statement)
        if target is None:
            if candidates:
                return CorrectionOutcome(
                    status="needs_disambiguation",
                    explanation="Multiple claims match; specify claim_id.",
                    candidates=[{"claim_id": c.id, "text": c.text} for c in candidates],
                )
            return CorrectionOutcome(status="rejected", explanation="No matching claim found.")

        # Agents never correct authoritatively — even acting on behalf of an owner (FR-15.10).
        if scope.principal_type is PrincipalType.AGENT:
            correction_id = await self._store.record_correction(
                scope,
                target_claim=target.id,
                new_claim=None,
                # The ACTING agent is provenance too (R15): `author_id=None` here dropped it, so a
                # legitimately delegated suggestion recorded who it was for and never who made it.
                author_id=scope.principal_id,
                on_behalf_of=scope.on_behalf_of,
                role_applied="agent_suggestion",
                status="routed_to_owner",
                before_text=target.text,
                after_text=correction,
                reason=reason,
            )
            return CorrectionOutcome(
                status="routed_to_owner",
                explanation="Agents cannot correct authoritatively; sent to the owner's review queue.",
                correction_id=correction_id,
            )

        is_owner = await self._store.person_owns_any_tag(scope, scope.principal_id, target.tags)
        if not is_owner:
            correction_id = await self._store.record_correction(
                scope,
                target_claim=target.id,
                new_claim=None,
                author_id=scope.principal_id,
                on_behalf_of=scope.on_behalf_of,
                role_applied="non_owner",
                status="routed_hunt",
                before_text=target.text,
                after_text=correction,
                reason=reason,
            )
            return CorrectionOutcome(
                status="routed_to_owner",
                explanation="You do not own this topic; the correction was routed to an owner.",
                correction_id=correction_id,
            )

        rejection = await self._anti_abuse(scope, target)
        if rejection is not None:
            return rejection

        sensitive = bool(
            set(target.tags)
            & await self._store.sensitive_slugs(scope, threshold=SENSITIVITY_THRESHOLD)
        )
        preview = (
            f"Mark '{target.text}' obsolete and record '{correction}' as the correct version"
            + (" (sensitive — needs a second owner's confirmation)." if sensitive else ".")
        )
        if dry_run:
            return CorrectionOutcome(
                status="applied" if not sensitive else "pending_confirmation",
                explanation=f"[dry-run] {preview}",
            )

        new_claim_id = await self._store.apply_owner_correction(
            scope,
            old_claim_id=target.id,
            new_text=correction,
            new_tags=list(target.tags),
            cred_old=self._config.superseded_credibility,
            cred_new=self._config.correction_credibility,
            pending=sensitive,
        )
        status = "pending_confirmation" if sensitive else "applied"
        role = "second_owner" if sensitive else "owner_direct"
        correction_id = await self._store.record_correction(
            scope,
            target_claim=target.id,
            new_claim=new_claim_id,
            author_id=scope.principal_id,
            on_behalf_of=scope.on_behalf_of,
            role_applied=role,
            status=status,
            before_text=json.dumps({"text": target.text, "credibility": target.credibility}),
            after_text=correction,
            reason=reason,
        )
        if not sensitive:
            await self._write_correction_edges(scope, new_claim_id, target.id, scope.principal_id)
            # R27: the corrected claim is closed in Postgres, so its graph relation stops being
            # current too — otherwise a graph expansion keeps serving the text just corrected.
            await self._graph_sync.retire_claims(scope, [target.id])
        return CorrectionOutcome(
            status=status,
            explanation=preview,
            correction_id=correction_id,
            new_claim_id=new_claim_id,
        )

    async def revert(self, scope: ProjectScope, correction_id: str) -> CorrectionOutcome:
        correction = await self._store.get_correction(scope, correction_id)
        if correction is None:
            return CorrectionOutcome(status="rejected", explanation="Correction not found.")
        if correction.status not in {"applied", "pending_confirmation"}:
            return CorrectionOutcome(
                status="rejected", explanation=f"Cannot revert a {correction.status} correction."
            )
        cred_restore = 0.5
        if correction.before_text:
            try:
                cred_restore = float(json.loads(correction.before_text)["credibility"])
            except (ValueError, KeyError, TypeError):
                cred_restore = 0.5
        await self._store.revert_correction(
            scope,
            old_claim_id=str(correction.target_claim),
            new_claim_id=str(correction.new_claim) if correction.new_claim else None,
            cred_restore=cred_restore,
        )
        # A revert closes the correction's claim and reopens the original, so the graph swaps back
        # in the same order (R27).
        if correction.new_claim:
            await self._graph_sync.retire_claims(scope, [str(correction.new_claim)])
        await self._graph_sync.reactivate_claims(scope, [str(correction.target_claim)])
        await self._store.record_correction(
            scope,
            target_claim=str(correction.target_claim),
            new_claim=str(correction.new_claim) if correction.new_claim else None,
            author_id=scope.principal_id,
            on_behalf_of=None,
            role_applied="reverted",
            status="reverted",
            before_text=correction.after_text,
            after_text=correction.before_text,
            reason=f"revert of {correction_id}",
        )
        return CorrectionOutcome(status="reverted", explanation="Correction reverted.")

    async def _resolve_target(
        self,
        scope: ProjectScope,
        claim_id: str | None,
        topic: str | None,
        statement: str | None,
    ) -> tuple[ClaimData | None, list[ClaimData]]:
        has_claim = claim_id is not None
        has_topic = topic is not None and statement is not None
        if has_claim == has_topic:  # both or neither → validation error
            return None, []
        if has_claim and claim_id is not None:
            return await self._store.get_claim(scope, claim_id), []
        if statement is None:  # pragma: no cover - the caller validates exactly one of the two
            raise ValueError("a correction needs either a claim id or a statement")
        gateway = self._gateway.for_project(scope.project_id)  # R12
        embedding = (await gateway.embed([statement]))[0]
        candidates = await self._store.find_candidate_claims(scope, embedding)
        wanted = normalize_name(statement)
        exact = [c for c in candidates if normalize_name(c.text) == wanted]
        if len(exact) == 1:
            return exact[0], []
        if len(candidates) == 1:
            return candidates[0], []
        return None, candidates

    async def _anti_abuse(self, scope: ProjectScope, target: ClaimData) -> CorrectionOutcome | None:
        since = dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
        recent = await self._store.corrections_by_author_since(scope, scope.principal_id, since)
        if recent >= self._config.corrections_per_person_per_day:
            return CorrectionOutcome(status="rejected", explanation="RATE_LIMITED: daily limit.")
        correctors = await self._store.distinct_correctors_of_claim(scope, target.id)
        if correctors >= self._config.correction_war_threshold:
            return CorrectionOutcome(
                status="rejected",
                explanation="Correction war detected; escalated to admin instead of applying.",
            )
        return None

    async def _write_correction_edges(
        self, scope: ProjectScope, new_claim_id: str, old_claim_id: str, person_id: str
    ) -> None:
        await self._graph.create_graph(scope)
        await self._graph.upsert_nodes(
            scope,
            [
                GraphNode(
                    id=new_claim_id, labels=frozenset({"Claim"}), properties={"kind": "claim"}
                ),
                GraphNode(
                    id=old_claim_id, labels=frozenset({"Claim"}), properties={"kind": "claim"}
                ),
                GraphNode(
                    id=person_id, labels=frozenset({"Person"}), properties={"kind": "person"}
                ),
            ],
        )
        await self._graph.upsert_edges(
            scope,
            [
                GraphEdge(source_id=old_claim_id, target_id=new_claim_id, type=_SUPERSEDED_BY),
                GraphEdge(source_id=new_claim_id, target_id=person_id, type=_CORRECTED_BY),
            ],
        )
