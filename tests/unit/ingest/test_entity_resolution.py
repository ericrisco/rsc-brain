"""Deterministic entity ids + normalization (FR-1.9 v0.1 part)."""

from __future__ import annotations

from rsc_brain.ingest.entity_resolution import entity_id, normalize_name


def test_normalization_casefolds_collapses_and_strips_punctuation() -> None:
    assert normalize_name("  Acme,  Corp.  ") == "acme corp"
    assert normalize_name("María López") == "maría lópez"
    assert normalize_name("AT&T") == "at t"


def test_same_type_and_name_are_stable() -> None:
    assert entity_id("org", "Acme Corp") == entity_id("org", "acme  corp")


def test_different_type_gives_a_different_id() -> None:
    assert entity_id("org", "Mercury") != entity_id("planet", "Mercury")


def test_ids_are_uuid5_deterministic_across_calls() -> None:
    first = entity_id("person", "Jane Doe")
    second = entity_id("person", "jane doe")
    assert first == second
    assert first.version == 5
