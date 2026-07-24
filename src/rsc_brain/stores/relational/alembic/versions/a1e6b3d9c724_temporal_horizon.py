"""temporal horizon: topics.hard_window_days + bitemporal claims index

Revision ID: a1e6b3d9c724
Revises: 9d4a7c1e5f28
Create Date: 2026-07-24 19:15:00.000000

SPEC-13 (v0.2, FR-16): a per-topic hard horizon (``topics.hard_window_days``, NULL = no window,
the D16 default) and a bitemporal index ``(project_id, valid_from, valid_to)`` on claims so the
validity filter (and SPEC-17's as_of reconstruction) is index-backed. Idempotent (NFR-8).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1e6b3d9c724"
down_revision: str | None = "9d4a7c1e5f28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("topics", sa.Column("hard_window_days", sa.Integer(), nullable=True))
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_claims_project_id_valid "
        "ON claims (project_id, valid_from, valid_to)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_claims_project_id_valid")
    op.drop_column("topics", "hard_window_days")
