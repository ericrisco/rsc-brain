"""Gap query-hash normalization (FR-3.3): trivially different phrasings collapse to one gap."""

from __future__ import annotations

from rsc_brain.recall.gaps import query_hash


def test_hash_is_case_and_whitespace_insensitive() -> None:
    assert query_hash("What is the SLA?") == query_hash("  what is the   sla?  ")


def test_hash_distinguishes_different_queries() -> None:
    assert query_hash("vacation policy") != query_hash("salary bands")


def test_hash_is_hex_sha256() -> None:
    digest = query_hash("anything")
    assert len(digest) == 64
    int(digest, 16)  # hex-parseable
