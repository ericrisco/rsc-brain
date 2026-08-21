"""Durable correction validity snapshots (AUDIT-107).

A correction used to overwrite the target claim's source-declared ``valid_to`` and retain no typed
copy. Revert then guessed ``NULL``, which could extend an expired source fact indefinitely. The
capture timestamp is the presence marker: both stored boundaries may legitimately be NULL, whereas
legacy corrections have no capture timestamp and must fail closed.

Revision ID: 7d5e9a3c1b42
Revises: 6c4a8f2d9b10
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "7d5e9a3c1b42"
down_revision = "7d2f9a4c1b83"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "corrections",
        sa.Column("target_valid_from_before", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "corrections",
        sa.Column("target_valid_to_before", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "corrections",
        sa.Column("validity_snapshot_captured_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("corrections", sa.Column("lifecycle_error", sa.Text(), nullable=True))
    op.add_column("corrections", sa.Column("reverted_by", sa.Uuid(), nullable=True))


def downgrade() -> None:
    op.drop_column("corrections", "reverted_by")
    op.drop_column("corrections", "lifecycle_error")
    op.drop_column("corrections", "validity_snapshot_captured_at")
    op.drop_column("corrections", "target_valid_to_before")
    op.drop_column("corrections", "target_valid_from_before")
