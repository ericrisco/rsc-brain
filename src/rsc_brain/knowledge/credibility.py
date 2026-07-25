"""Claim credibility (FR-5.1) + feedback weighting (FR-5.4) — pure functions.

Initial credibility is computed at ingest (post-D13), replacing the DDL 0.5 default:

    cred₀ = clamp(0.35·authority + 0.25·extraction_confidence + 0.20·corroboration + 0.20·freshness)

``authority`` comes from a versioned per-source table; ``corroboration = min(1, n_sources/3)``;
``freshness`` is the SPEC-06 per-topic exponential decay (passed in). Feedback nudges credibility
toward 1 (``helpful``) or 0 (``wrong``/``outdated``) by alpha, weighted per principal type and capped
per day so a spammy agent cannot move a claim (FR-14.5).
"""

from __future__ import annotations

from collections.abc import Mapping

WEIGHT_AUTHORITY = 0.35
WEIGHT_EXTRACTION = 0.25
WEIGHT_CORROBORATION = 0.20
WEIGHT_FRESHNESS = 0.20


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def corroboration(n_independent_sources: int) -> float:
    """``min(1, n/3)`` — three independent sources saturate corroboration (FR-5.1)."""
    return min(1.0, max(0, n_independent_sources) / 3.0)


#: How much authority a source's POLICY confers, relative to the layout-derived kinds. A manually
#: curated source is a human saying "this is what we mean"; an LLM-tagged folder is a guess that
#: nobody has checked. R20: authority used to be inferred from chunk shape alone — a table row was
#: authoritative and a scanned page was not — so an unvetted upload and a curated source produced the
#: same number, and the document's real provenance never participated.
POLICY_AUTHORITY: Mapping[str, float] = {
    "manual": 0.95,  # a curator chose the tags by hand
    "source_tags": 0.85,  # the source declares its own tags and a human configured it
    "llm_review": 0.75,  # the model proposes, a human confirms when sensitive
    "llm": 0.6,  # the model decides unattended
}


def policy_authority(policy: str | None, *, default: float = 0.6) -> float:
    """Authority conferred by a source's ingestion policy (R20)."""
    if not policy:
        return default
    return POLICY_AUTHORITY.get(policy, default)


def corroborated_authority(
    layout_authority: float, policy: str | None, *, default: float = 0.6
) -> float:
    """Combine what the layout suggests with what the PROVENANCE says.

    The maximum rather than an average: a curated source does not become less authoritative because
    its text happens to be prose, and a table inside an unvetted upload is not evidence that anyone
    checked it. Taking the stronger signal keeps both directions honest.
    """
    return max(layout_authority, policy_authority(policy, default=default))


def authority_for(
    source_kind: str | None,
    *,
    table: Mapping[str, float],
    default: float,
) -> float:
    """Authority for a source kind from the versioned config table (FR-5.1)."""
    if source_kind is None:
        return default
    return table.get(source_kind, default)


def initial_credibility(
    *,
    authority: float,
    extraction_confidence: float | None,
    n_independent_sources: int,
    freshness: float,
) -> float:
    """Compute cred₀ (FR-5.1). Missing extraction confidence is treated as neutral 0.5."""
    extraction = extraction_confidence if extraction_confidence is not None else 0.5
    raw = (
        WEIGHT_AUTHORITY * authority
        + WEIGHT_EXTRACTION * extraction
        + WEIGHT_CORROBORATION * corroboration(n_independent_sources)
        + WEIGHT_FRESHNESS * freshness
    )
    return clamp(raw)


def apply_feedback(credibility: float, signal: str, *, alpha: float) -> float:
    """Nudge credibility by alpha toward 1 (helpful) or 0 (wrong/outdated) — FR-5.4."""
    target = 1.0 if signal == "helpful" else 0.0
    return clamp(credibility * (1.0 - alpha) + alpha * target)


def capped_feedback(
    credibility: float,
    signal: str,
    *,
    alpha: float,
    remaining_daily_budget: float,
) -> tuple[float, float]:
    """Apply feedback but never move credibility by more than the remaining daily budget for this
    (principal, claim). Returns (new_credibility, delta_consumed). This is what makes 10 000 agent
    ``wrong`` signals move a claim no further than the daily cap (FR-14.5)."""
    if remaining_daily_budget <= 0:
        return credibility, 0.0
    proposed = apply_feedback(credibility, signal, alpha=alpha)
    delta = proposed - credibility
    if abs(delta) <= remaining_daily_budget:
        return proposed, abs(delta)
    # Clip the move to the remaining budget, preserving direction.
    direction = 1.0 if delta > 0 else -1.0
    clipped = clamp(credibility + direction * remaining_daily_budget)
    return clipped, abs(clipped - credibility)
