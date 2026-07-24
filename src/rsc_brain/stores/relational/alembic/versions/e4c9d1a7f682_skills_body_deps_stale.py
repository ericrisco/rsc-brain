"""skills: body, depends_on, stale (SPEC-20, FR-7.1/7.2)

Completes the DDL §5.2 ``skills`` table with what FR-7.1/7.2 need beyond the base columns: the
markdown ``body`` (the skill's instructions), ``depends_on`` (entity/topic ids the skill's context
is built from — the graph-sync key), and the ``stale`` marker (+ reason/timestamp) set when that
subgraph changes. A pure additive migration — idempotent from a v0.3 dump (NFR-8).

Revision ID: e4c9d1a7f682
Revises: c3a8d5f2b641
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e4c9d1a7f682"
down_revision: str | None = "c3a8d5f2b641"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("skills", sa.Column("body", sa.Text(), nullable=True))
    op.add_column(
        "skills",
        sa.Column(
            "depends_on",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column(
        "skills",
        sa.Column("stale", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column("skills", sa.Column("stale_reason", sa.Text(), nullable=True))
    op.add_column("skills", sa.Column("stale_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    for column in ("stale_at", "stale_reason", "stale", "depends_on", "body"):
        op.drop_column("skills", column)
