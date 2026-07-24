"""Deterministic table → claims conversion (FR-1.5). No LLM in any branch.

A table with a clear header (col 0 = subject, cols 1.. = predicates) becomes one ``table_row``
chunk per row, each carrying one structured claim per predicate column. A table without a clear
header becomes a single ``needs_review`` chunk that is persisted (auditable) but **never enters
the active graph or the queryable vector index**.
"""

from __future__ import annotations

from collections.abc import Sequence

from rsc_brain.ingest.types import ChunkKind, ClaimTriple, ProposedChunk, TableBlock


def _render_table(table: TableBlock) -> str:
    """Render a table back to a compact text form (for the needs_review chunk body)."""
    lines: list[str] = []
    if table.caption:
        lines.append(table.caption)
    if table.header:
        lines.append(" | ".join(table.header))
    lines.extend(" | ".join(row) for row in table.rows)
    return "\n".join(lines)


def table_to_chunks(table: TableBlock) -> list[ProposedChunk]:
    """Convert one table to chunks: row-claims when the header is clear, else one needs_review."""
    if not table.has_clear_header:
        return [
            ProposedChunk(
                kind=ChunkKind.TABLE_ROW,
                text=_render_table(table),
                page=table.page,
                bbox=table.bbox,
                cut_type="table",
                extraction_confidence=table.extraction_confidence,
                needs_review=True,
            )
        ]

    subject_col, *predicate_cols = table.header
    chunks: list[ProposedChunk] = []
    for row in table.rows:
        subject = row[0]
        claims: list[ClaimTriple] = []
        parts: list[str] = []
        for column_index, predicate in enumerate(predicate_cols, start=1):
            value = row[column_index]
            claims.append(
                ClaimTriple(
                    text=f"{subject} — {predicate}: {value}",
                    subject=subject,
                    predicate=predicate,
                    object=value,
                )
            )
            parts.append(f"{predicate}: {value}")
        chunks.append(
            ProposedChunk(
                kind=ChunkKind.TABLE_ROW,
                text=f"{subject_col}={subject}; " + "; ".join(parts),
                page=table.page,
                bbox=table.bbox,
                cut_type="table_row",
                extraction_confidence=table.extraction_confidence,
                claims=tuple(claims),
            )
        )
    return chunks


def tables_to_chunks(tables: Sequence[TableBlock]) -> list[ProposedChunk]:
    """Convert all tables in a document (FR-1.5). Every table is either converted or retained
    as needs_review — never silently dropped."""
    chunks: list[ProposedChunk] = []
    for table in tables:
        chunks.extend(table_to_chunks(table))
    return chunks
