"""Hunt state machine (SPEC-15, FR-6.3) — the exact PRD lifecycle as an explicit transition table.

    DETECTED → ROUTED → CONSENT_REQUESTED → [SCHEDULED →] AWAITING_ANSWER → ANSWERED → INGESTED
             → RESOLVED

with ``NO_OWNER`` (no responsible person), ``EXPIRED`` (72h → one retry → escalate), and
``DECLINED`` as terminal/branch states. A transition not in the table is illegal and raises — the
machine never lets a hunt reach an undeclared state. Hunt *type* (GAP | CONTRADICTION | MANUAL |
CORRECTION_REVIEW) is orthogonal to the state.
"""

from __future__ import annotations

from collections import deque
from enum import StrEnum


class HuntState(StrEnum):
    DETECTED = "DETECTED"
    ROUTED = "ROUTED"
    NO_OWNER = "NO_OWNER"
    CONSENT_REQUESTED = "CONSENT_REQUESTED"
    SCHEDULED = "SCHEDULED"
    AWAITING_ANSWER = "AWAITING_ANSWER"
    ANSWERED = "ANSWERED"
    INGESTED = "INGESTED"
    RESOLVED = "RESOLVED"
    EXPIRED = "EXPIRED"
    DECLINED = "DECLINED"


class HuntType(StrEnum):
    GAP = "GAP"
    CONTRADICTION = "CONTRADICTION"
    MANUAL = "MANUAL"
    CORRECTION_REVIEW = "CORRECTION_REVIEW"


# Terminal states have no outgoing transitions.
_TRANSITIONS: dict[HuntState, frozenset[HuntState]] = {
    HuntState.DETECTED: frozenset({HuntState.ROUTED, HuntState.NO_OWNER}),
    HuntState.ROUTED: frozenset({HuntState.CONSENT_REQUESTED, HuntState.NO_OWNER}),
    HuntState.NO_OWNER: frozenset(),
    HuntState.CONSENT_REQUESTED: frozenset(
        {HuntState.SCHEDULED, HuntState.AWAITING_ANSWER, HuntState.DECLINED, HuntState.EXPIRED}
    ),
    HuntState.SCHEDULED: frozenset(
        {HuntState.AWAITING_ANSWER, HuntState.EXPIRED, HuntState.DECLINED}
    ),
    HuntState.AWAITING_ANSWER: frozenset(
        {HuntState.ANSWERED, HuntState.EXPIRED, HuntState.DECLINED}
    ),
    HuntState.ANSWERED: frozenset({HuntState.INGESTED}),
    HuntState.INGESTED: frozenset({HuntState.RESOLVED}),
    HuntState.RESOLVED: frozenset(),
    # EXPIRED is re-entrant to AWAITING_ANSWER on the single retry; otherwise terminal.
    HuntState.EXPIRED: frozenset({HuntState.AWAITING_ANSWER}),
    HuntState.DECLINED: frozenset(),
}

_TERMINAL = frozenset({HuntState.RESOLVED, HuntState.NO_OWNER, HuntState.DECLINED})


class IllegalTransitionError(ValueError):
    """Raised on a transition not declared in the state machine (FR-6.3)."""

    def __init__(self, src: HuntState, dst: HuntState) -> None:
        super().__init__(f"illegal hunt transition {src} → {dst}")
        self.src = src
        self.dst = dst


def can_transition(src: HuntState, dst: HuntState) -> bool:
    return dst in _TRANSITIONS.get(src, frozenset())


def check_transition(src: HuntState, dst: HuntState) -> None:
    if not can_transition(src, dst):
        raise IllegalTransitionError(src, dst)


def path_to(src: HuntState, dst: HuntState) -> list[HuntState]:
    """Shortest legal lifecycle path from ``src`` to ``dst`` (inclusive), or ``[]`` if unreachable.

    Lets a synchronous action collapse several legal hops into one — an owner *confirming* a
    correction walks ``AWAITING_ANSWER → ANSWERED → INGESTED → RESOLVED`` in a single click — while
    still refusing any jump the transition table forbids.
    """
    if src == dst:
        return [src]
    seen = {src}
    queue: deque[list[HuntState]] = deque([[src]])
    while queue:
        path = queue.popleft()
        for nxt in _TRANSITIONS.get(path[-1], frozenset()):
            if nxt in seen:
                continue
            extended = [*path, nxt]
            if nxt == dst:
                return extended
            seen.add(nxt)
            queue.append(extended)
    return []


def is_terminal(state: HuntState) -> bool:
    return state in _TERMINAL


def is_open(state: HuntState) -> bool:
    """An open hunt counts against the anti-spam limits (FR-6.5) — anything not yet terminal."""
    return state not in _TERMINAL and state != HuntState.EXPIRED
