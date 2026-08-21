"""durable idle-prompt marker for periodic skill maintenance

Revision ID: a7e4c2d91b63
Revises: 6c4a8f2d9b10
Create Date: 2026-08-21 01:00:00.000000

Audit rows cannot be lifecycle markers because retention deliberately deletes them. The nullable
timestamps are additive: legacy skills remain eligible for delivery, and old writers remain
compatible while rolling forward or back.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7e4c2d91b63"
down_revision: str | None = "7d5e9a3c1b42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "skills",
        sa.Column("proposal_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "skills",
        sa.Column("idle_prompted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("skills", "idle_prompted_at")
    op.drop_column("skills", "proposal_notified_at")
