"""Reciprocal Rank Fusion (SPEC-12, FR-3.7, pure)."""

from __future__ import annotations

from rsc_brain.recall.retriever import _rrf_fuse


def test_document_ranked_high_in_both_lists_wins() -> None:
    vector = ["a", "b", "c"]
    lexical = ["b", "d", "a"]
    fused = _rrf_fuse([vector, lexical], k=60, limit=4)
    # "b" is #2+#1, "a" is #1+#3 → both beat singletons; "b" edges "a" (better combined ranks).
    assert fused[0] == "b"
    assert set(fused[:2]) == {"a", "b"}


def test_single_list_round_trips_in_order() -> None:
    assert _rrf_fuse([["x", "y", "z"]], k=60, limit=10) == ["x", "y", "z"]


def test_limit_is_respected() -> None:
    assert _rrf_fuse([["a", "b", "c", "d"]], k=10, limit=2) == ["a", "b"]


def test_empty_inputs() -> None:
    assert _rrf_fuse([], k=60, limit=5) == []
    assert _rrf_fuse([[], []], k=60, limit=5) == []


def test_ties_keep_first_appearance_order() -> None:
    # Two docs each appear once at rank 1 in different lists → equal score → stable by first-seen.
    assert _rrf_fuse([["a"], ["b"]], k=60, limit=5) == ["a", "b"]
