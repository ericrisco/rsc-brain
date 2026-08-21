"""Preserve OKF concept type and producer extensions on skills.

Revision ID: a7e1c9d4f260
Revises: 6c4a8f2d9b10
Create Date: 2026-08-21 06:35:00.000000

Both columns are additive and carry legacy-safe defaults. Existing rows were emitted as skills and
had no extension storage, so ``Skill`` and an empty mapping are the exact non-invented backfill.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a7e1c9d4f260"
down_revision: str | None = "6c4a8f2d9b10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "skills", sa.Column("okf_type", sa.Text(), server_default="Skill", nullable=False)
    )
    op.add_column(
        "skills",
        sa.Column(
            "okf_extensions",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("skills", "okf_extensions")
    op.drop_column("skills", "okf_type")
