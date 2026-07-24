"""Real `report_feedback` application (FR-5.4 + FR-14.5), replacing the SPEC-06 stub.

Each signal nudges the claim's credibility by alpha — alpha=0.1 for humans, alpha_agent=0.03 for agents —
capped by the remaining daily budget per (principal, claim), so 10 000 agent `wrong` signals move
a claim no further than the daily cap. A human `wrong`/`outdated` that leaves credibility below the
threshold marks the claim `disputed` + a hunting candidate; **agent feedback never disputes or
triggers hunting** (only humans do).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass

from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.knowledge.credibility import capped_feedback
from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

_NEGATIVE_SIGNALS = {"wrong", "outdated"}


@dataclass(frozen=True, slots=True)
class FeedbackResult:
    applied: int
    disputed: list[str]


async def apply_report_feedback(
    store: KnowledgeStore,
    scope: ProjectScope,
    *,
    claim_ids: Sequence[str],
    signal: str,
    config: KnowledgeConfig | None = None,
    day: dt.date | None = None,
) -> FeedbackResult:
    config = config or KnowledgeConfig()
    day = day or dt.datetime.now(dt.UTC).date()
    is_human = scope.principal_type is PrincipalType.HUMAN
    alpha = config.feedback_alpha_human if is_human else config.feedback_alpha_agent

    applied = 0
    disputed: list[str] = []
    for claim_id in claim_ids:
        claim = await store.get_claim(scope, claim_id)
        if claim is None:
            continue
        remaining = await store.feedback_budget_remaining(
            scope, scope.principal_id, claim_id, day, config.feedback_daily_cap
        )
        new_cred, delta = capped_feedback(
            claim.credibility, signal, alpha=alpha, remaining_daily_budget=remaining
        )
        # Only a human negative signal that drives credibility below the threshold disputes.
        mark = (
            is_human
            and signal in _NEGATIVE_SIGNALS
            and new_cred < config.human_wrong_disputed_below
        )
        await store.apply_feedback(
            scope,
            principal_id=scope.principal_id,
            claim_id=claim_id,
            day=day,
            new_credibility=new_cred,
            delta=delta,
            disputed=mark,
            hunting_candidate=mark,
        )
        applied += 1
        if mark:
            disputed.append(claim_id)
    return FeedbackResult(applied=applied, disputed=disputed)
