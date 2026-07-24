"""token usage counters + embedding cache (SPEC-22, FR-9.5/9.6)

``token_usage`` — per-capability, per-day token + call counters (``brain usage``, budgets).
``embedding_cache`` — text→vector by SHA-256(text)+model+dimension, so the same text is never
re-embedded. Both additive; idempotent from a v0.4 dump (NFR-8).

Revision ID: f1a2b3c4d5e6
Revises: e4c9d1a7f682
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "e4c9d1a7f682"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "token_usage",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("capability", sa.Text(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("tokens", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("calls", sa.Integer(), server_default="0", nullable=False),
        sa.UniqueConstraint("capability", "day", name="uq_token_usage_capability_day"),
    )
    op.create_table(
        "embedding_cache",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("text_hash", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("dimension", sa.Integer(), nullable=False),
        sa.Column("embedding", postgresql.ARRAY(sa.Float()), nullable=False),
        sa.UniqueConstraint(
            "text_hash", "model", "dimension", name="uq_embedding_cache_hash_model_dim"
        ),
    )


def downgrade() -> None:
    op.drop_table("embedding_cache")
    op.drop_table("token_usage")
