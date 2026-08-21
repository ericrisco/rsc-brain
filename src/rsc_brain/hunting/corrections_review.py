"""CORRECTION_REVIEW hunts (SPEC-15, FR-15.6 / FR-15.3 b,c).

When a **non-owner** proposes a correction (SPEC-08 routes it as ``routed_hunt``), the claim is
marked ``disputed`` and a ``CORRECTION_REVIEW`` hunt goes to the tag owner. The owner then:

* **confirms** ⇒ the correction is applied as FR-15.4 (old claim superseded, corrected claim at the
  correction credibility; provenance = proposer + confirmer), ``corrections.status=applied``;
* **rejects** ⇒ the claim's ``disputed`` flag is cleared (credibility restored),
  ``corrections.status=rejected``;
* **expires** ⇒ the claim stays ``disputed`` (visible in the console), ``corrections.status=expired``.

No owner for the tag ⇒ ``NO_OWNER`` + admin alert, claim left ``disputed`` (FR-15.3c).
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntOutcome, HuntService
from rsc_brain.hunting.state_machine import (
    HuntState,
    HuntType,
    IllegalTransitionError,
    path_to,
)
from rsc_brain.knowledge.graph_sync import GraphSync
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.knowledge_store import CorrectionApplyError, KnowledgeStore


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


class CorrectionReviewService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        hunts: HuntService,
        config: KnowledgeConfig | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._hunts = hunts
        self._store = KnowledgeStore(sessionmaker)
        self._graph_sync = GraphSync(store=self._store, graph=AgeGraphStore(sessionmaker))
        self._directory = PersonDirectory(sessionmaker)
        self._config = config or KnowledgeConfig()

    async def open_review(self, scope: ProjectScope, correction_id: str) -> HuntOutcome:
        """Open a CORRECTION_REVIEW for a non-owner's proposed correction. Marks the target claim
        disputed and routes to the tag owner (NO_OWNER if none)."""
        correction = await self._store.get_correction(scope, correction_id)
        if correction is None:
            return HuntOutcome(hunt_id="", state=HuntState.NO_OWNER)
        target = await self._store.get_claim(scope, str(correction.target_claim))
        tags = list(target.tags) if target is not None else []
        await self._store.mark_disputed(
            scope, [str(correction.target_claim)], hunting_candidate=True
        )
        question = (
            f"Review a proposed correction to claim {correction.target_claim}: "
            f"{correction.after_text!r}"
        )
        outcome = await self._hunts._open(
            scope,
            hunt_type=HuntType.CORRECTION_REVIEW,
            question=question,
            topics=tags,
            correction_id=correction_id,
        )
        if outcome.hunt_id:
            await self._store.link_correction_hunt(scope, correction_id, outcome.hunt_id)
        return outcome

    async def confirm(self, scope: ProjectScope, hunt_id: str) -> HuntOutcome:
        """Owner confirms ⇒ apply the correction transactionally (FR-15.4) + close the hunt."""
        hunt = await self._require_awaiting(scope, hunt_id)
        if hunt is None or hunt.correction_id is None:
            return HuntOutcome(hunt_id=hunt_id, state=HuntState.EXPIRED)
        correction = await self._store.get_correction(scope, str(hunt.correction_id))
        if correction is None:  # pragma: no cover - the hunt's FK guarantees it
            raise RuntimeError(f"hunt {hunt_id} references a correction that no longer exists")
        # The corrected claim inherits the target's tags (FR-15.4) so topic permissions are
        # preserved — never strip them to an untagged claim.
        target = await self._store.get_claim(scope, str(correction.target_claim))
        try:
            await self._store.apply_owner_correction(
                scope,
                correction_id=str(hunt.correction_id),
                old_claim_id=str(correction.target_claim),
                new_text=correction.after_text or "",
                new_tags=list(target.tags) if target is not None else [],
                cred_old=self._config.superseded_credibility,
                cred_new=self._config.correction_credibility,
                pending=False,
                final_status="applied",
            )
        except CorrectionApplyError:
            # Another authoritative correction won the serialized target, or the target is not yet
            # effective. The store has durably recorded why; close this stale review without a
            # second replacement or a generic 500.
            await self._close(scope, hunt_id, HuntState.EXPIRED)
            return HuntOutcome(hunt_id=hunt_id, state=HuntState.EXPIRED)
        # If AGE fails, leave the hunt awaiting: retrying confirm reuses the same correction/new
        # claim and retries graph convergence before closing the hunt (AUDIT-107).
        await self._graph_sync.retire_claims(scope, [str(correction.target_claim)])
        await self._close(scope, hunt_id, HuntState.RESOLVED)
        return HuntOutcome(hunt_id=hunt_id, state=HuntState.RESOLVED)

    async def reject(self, scope: ProjectScope, hunt_id: str) -> HuntOutcome:
        """Owner rejects ⇒ clear the claim's disputed flag (restore) + record the rejection."""
        hunt = await self._require_awaiting(scope, hunt_id)
        if hunt is None or hunt.correction_id is None:
            return HuntOutcome(hunt_id=hunt_id, state=HuntState.EXPIRED)
        correction = await self._store.get_correction(scope, str(hunt.correction_id))
        if correction is None:  # pragma: no cover - the hunt's FK guarantees it
            raise RuntimeError(f"hunt {hunt_id} references a correction that no longer exists")
        await self._store.set_disputed(scope, [str(correction.target_claim)], disputed=False)
        await self._store.set_correction_status(scope, str(hunt.correction_id), status="rejected")
        await self._close(scope, hunt_id, HuntState.DECLINED)
        return HuntOutcome(hunt_id=hunt_id, state=HuntState.DECLINED)

    async def expire(self, scope: ProjectScope, hunt_id: str) -> HuntOutcome:
        """Review expires ⇒ the claim stays disputed (visible in the console)."""
        hunt = await self._require_awaiting(scope, hunt_id)
        if hunt is None or hunt.correction_id is None:
            return HuntOutcome(hunt_id=hunt_id, state=HuntState.EXPIRED)
        await self._store.set_correction_status(scope, str(hunt.correction_id), status="expired")
        # The target claim keeps its `disputed` flag on purpose (no restore).
        await self._close(scope, hunt_id, HuntState.EXPIRED)
        return HuntOutcome(hunt_id=hunt_id, state=HuntState.EXPIRED)

    async def _require_awaiting(self, scope: ProjectScope, hunt_id: str) -> models.Hunt | None:
        async with self._sm() as session:
            hunt = await session.get(models.Hunt, uuid.UUID(hunt_id))
            if hunt is None or hunt.project_id != _pid(scope):
                return None
            return hunt if hunt.state == HuntState.AWAITING_ANSWER.value else None

    async def _close(self, scope: ProjectScope, hunt_id: str, final: HuntState) -> None:
        """Persist ``final`` after validating it is reachable from the hunt's current state along a
        legal lifecycle path (``confirm`` collapses ANSWERED → INGESTED → RESOLVED into one hop)."""
        async with session_scope(self._sm) as session:
            live = await session.get(models.Hunt, uuid.UUID(hunt_id))
            if live is None:
                return
            current = HuntState(live.state)
            if not path_to(current, final):
                raise IllegalTransitionError(current, final)
            live.state = final.value
            live.magic_token_hash = None
