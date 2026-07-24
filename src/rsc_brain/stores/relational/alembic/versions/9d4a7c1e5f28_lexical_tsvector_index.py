"""lexical tsvector GIN indexes on chunks + claims (hybrid search)

Revision ID: 9d4a7c1e5f28
Revises: 8c3f6a2d4e17
Create Date: 2026-07-24 18:00:00.000000

SPEC-12 (v0.2, E4.6): the lexical half of hybrid search (FR-3.7). A GIN index over
``to_tsvector('simple', text)`` on chunks + claims. The ``simple`` configuration (no stemming, no
stopwords) is deliberate — it preserves exact identifiers (invoice numbers, NIF, product codes,
clause names) that stemming dictionaries would mangle, which is the whole point of the spec.
Idempotent (IF NOT EXISTS), so it applies cleanly from scratch and over a v0.1 dump (NFR-8).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "9d4a7c1e5f28"
down_revision: str | None = "8c3f6a2d4e17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_chunks_text_tsv "
        "ON chunks USING gin (to_tsvector('simple', text))"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_claims_text_tsv "
        "ON claims USING gin (to_tsvector('simple', text))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_claims_text_tsv")
    op.execute("DROP INDEX IF EXISTS ix_chunks_text_tsv")
