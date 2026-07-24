"""audit_log: optional query_text + duration_ms (console observability)

Revision ID: b2f7c4a8e935
Revises: a1e6b3d9c724
Create Date: 2026-07-24 20:15:00.000000

SPEC-14 (v0.2, E13.2): the recall stream (FR-13.3) needs the query text (only when a project opts
in via ``query_text_logging`` — FR-13.9, default ON) and the recall duration for the p95 dashboard
(FR-13.2). Both nullable; ``query_text`` stays NULL whenever logging is OFF (server-side control —
the text is then never persisted). Idempotent (NFR-8).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2f7c4a8e935"
down_revision: str | None = "a1e6b3d9c724"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_log", sa.Column("query_text", sa.Text(), nullable=True))
    op.add_column("audit_log", sa.Column("duration_ms", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("audit_log", "duration_ms")
    op.drop_column("audit_log", "query_text")
