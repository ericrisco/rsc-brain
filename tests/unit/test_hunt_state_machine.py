"""Hunt state machine (SPEC-15, FR-6.3, pure)."""

from __future__ import annotations

from itertools import pairwise

import pytest

from rsc_brain.hunting.state_machine import (
    HuntState,
    IllegalTransitionError,
    can_transition,
    check_transition,
    is_open,
    is_terminal,
)


def test_happy_path_transitions_are_legal() -> None:
    path = [
        HuntState.DETECTED,
        HuntState.ROUTED,
        HuntState.CONSENT_REQUESTED,
        HuntState.AWAITING_ANSWER,
        HuntState.ANSWERED,
        HuntState.INGESTED,
        HuntState.RESOLVED,
    ]
    for src, dst in pairwise(path):
        assert can_transition(src, dst)


def test_illegal_transitions_raise() -> None:
    assert not can_transition(HuntState.DETECTED, HuntState.RESOLVED)
    assert not can_transition(HuntState.RESOLVED, HuntState.AWAITING_ANSWER)  # terminal
    with pytest.raises(IllegalTransitionError):
        check_transition(HuntState.ANSWERED, HuntState.DECLINED)


def test_expiry_retry_and_terminals() -> None:
    assert can_transition(HuntState.AWAITING_ANSWER, HuntState.EXPIRED)
    assert can_transition(HuntState.EXPIRED, HuntState.AWAITING_ANSWER)  # the single retry
    assert is_terminal(HuntState.RESOLVED)
    assert is_terminal(HuntState.NO_OWNER)
    assert is_terminal(HuntState.DECLINED)


def test_open_states_count_for_anti_spam() -> None:
    assert is_open(HuntState.AWAITING_ANSWER)
    assert is_open(HuntState.CONSENT_REQUESTED)
    assert not is_open(HuntState.RESOLVED)
    assert not is_open(HuntState.EXPIRED)
    assert not is_open(HuntState.NO_OWNER)
