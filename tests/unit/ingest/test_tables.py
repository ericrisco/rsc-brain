"""Deterministic tables → claims (FR-1.5): clear header ⇒ row claims; else ⇒ needs_review."""

from __future__ import annotations

from rsc_brain.ingest.tables import table_to_chunks, tables_to_chunks
from rsc_brain.ingest.types import ChunkKind, TableBlock


def test_clear_header_emits_one_chunk_per_row_with_claims() -> None:
    table = TableBlock(
        header=("employee", "salary", "band"),
        rows=(("Ada", "90000", "B"), ("Linus", "85000", "B")),
    )
    chunks = table_to_chunks(table)
    assert len(chunks) == 2
    assert all(c.kind is ChunkKind.TABLE_ROW and not c.needs_review for c in chunks)
    ada = chunks[0]
    # First column is subject; each other column becomes a predicate claim.
    assert {(cl.subject, cl.predicate, cl.object) for cl in ada.claims} == {
        ("Ada", "salary", "90000"),
        ("Ada", "band", "B"),
    }


def test_headerless_table_becomes_single_needs_review_chunk() -> None:
    table = TableBlock(header=("", ""), rows=(("a", "b"),))
    chunks = table_to_chunks(table)
    assert len(chunks) == 1
    assert chunks[0].needs_review is True
    assert chunks[0].claims == ()


def test_single_column_table_is_needs_review() -> None:
    table = TableBlock(header=("only",), rows=(("x",),))
    chunks = table_to_chunks(table)
    assert chunks[0].needs_review is True


def test_ragged_rows_are_needs_review() -> None:
    table = TableBlock(header=("a", "b"), rows=(("1",),))  # row width mismatch
    assert table_to_chunks(table)[0].needs_review is True


def test_tables_to_chunks_handles_every_table() -> None:
    good = TableBlock(header=("k", "v"), rows=(("x", "1"),))
    bad = TableBlock(header=("", ""), rows=(("x", "y"),))
    chunks = tables_to_chunks([good, bad])
    converted = [c for c in chunks if not c.needs_review]
    review = [c for c in chunks if c.needs_review]
    assert len(converted) == 1 and len(review) == 1
