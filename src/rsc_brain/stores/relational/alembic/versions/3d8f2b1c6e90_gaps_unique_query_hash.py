"""gaps: unique (project_id, query_hash) for atomic gap upsert

Revision ID: 3d8f2b1c6e90
Revises: 2c9e1a7b4d83
Create Date: 2026-07-24 08:00:00.000000

SPEC-06 (FR-3.3): registering a gap is an atomic upsert keyed by (project_id, query_hash), so a
recurring unanswered query increments a single row instead of racing new rows. Replaces the
non-unique index with a unique constraint (which still provides the project_id-leading index).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "3d8f2b1c6e90"
down_revision: str | None = "2c9e1a7b4d83"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_gaps_project_id_query_hash", table_name="gaps")
    op.create_unique_constraint(
        op.f("uq_gaps_project_id_query_hash"), "gaps", ["project_id", "query_hash"]
    )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_gaps_project_id_query_hash"), "gaps", type_="unique")
    op.create_index(
        "ix_gaps_project_id_query_hash", "gaps", ["project_id", "query_hash"], unique=False
    )
