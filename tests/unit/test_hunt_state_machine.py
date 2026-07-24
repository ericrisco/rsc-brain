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
    path_to,
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


def test_path_to_collapses_legal_multi_hop() -> None:
    # An owner confirming a correction walks the full happy path in one action.
    assert path_to(HuntState.AWAITING_ANSWER, HuntState.RESOLVED) == [
        HuntState.AWAITING_ANSWER,
        HuntState.ANSWERED,
        HuntState.INGESTED,
        HuntState.RESOLVED,
    ]
    # Every consecutive hop the BFS returns is itself a legal transition.
    for src, dst in pairwise(path_to(HuntState.AWAITING_ANSWER, HuntState.RESOLVED)):
        assert can_transition(src, dst)
    assert path_to(HuntState.AWAITING_ANSWER, HuntState.DECLINED) == [
        HuntState.AWAITING_ANSWER,
        HuntState.DECLINED,
    ]
    assert path_to(HuntState.RESOLVED, HuntState.RESOLVED) == [HuntState.RESOLVED]  # identity
    assert path_to(HuntState.RESOLVED, HuntState.AWAITING_ANSWER) == []  # unreachable from terminal


def test_open_states_count_for_anti_spam() -> None:
    assert is_open(HuntState.AWAITING_ANSWER)
    assert is_open(HuntState.CONSENT_REQUESTED)
    assert not is_open(HuntState.RESOLVED)
    assert not is_open(HuntState.EXPIRED)
    assert not is_open(HuntState.NO_OWNER)
