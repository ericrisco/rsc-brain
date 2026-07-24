"""hunting: person directory fields + hunt lifecycle columns

Revision ID: c3a8d5f2b641
Revises: b2f7c4a8e935
Create Date: 2026-07-24 21:00:00.000000

SPEC-15 (v0.3, E7). Extends ``persons`` with ``quiet_hours``/``language`` (FR-6.1) and ``hunts``
with the full lifecycle: type (GAP|CONTRADICTION|MANUAL|CORRECTION_REVIEW), the one-time magic-link
token hash, retry count, per-transition timestamps, the escalation deadline, and the correction it
reviews (FR-15.6). All project-scoped already. Idempotent (NFR-8).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3a8d5f2b641"
down_revision: str | None = "b2f7c4a8e935"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "persons", sa.Column("quiet_hours", sa.JSON(), server_default=sa.text("'{}'::json"))
    )
    op.add_column("persons", sa.Column("language", sa.Text(), nullable=True))

    op.add_column(
        "hunts", sa.Column("hunt_type", sa.Text(), server_default="GAP", nullable=False)
    )
    op.add_column("hunts", sa.Column("magic_token_hash", sa.Text(), nullable=True))
    op.add_column("hunts", sa.Column("retries", sa.Integer(), server_default="0", nullable=False))
    op.add_column("hunts", sa.Column("correction_id", sa.Uuid(), nullable=True))
    op.add_column("hunts", sa.Column("consent_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("hunts", sa.Column("asked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("hunts", sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("hunts", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("hunts", sa.Column("claim_id", sa.Uuid(), nullable=True))


def downgrade() -> None:
    for column in ("claim_id", "expires_at", "answered_at", "asked_at", "consent_requested_at",
                   "correction_id", "retries", "magic_token_hash", "hunt_type"):
        op.drop_column("hunts", column)
    op.drop_column("persons", "language")
    op.drop_column("persons", "quiet_hours")
