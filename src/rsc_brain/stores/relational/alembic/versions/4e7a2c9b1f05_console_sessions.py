"""console sessions (SPEC-07 single-identity console login)

Revision ID: 4e7a2c9b1f05
Revises: 3d8f2b1c6e90
Create Date: 2026-07-24 09:50:00.000000

SPEC-07: a DB-backed console session token (hashed, short-lived, revocable) resolved on every
request like a PAT, so a disabled user or logout stops resolving in <5s (FR-4.12).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4e7a2c9b1f05"
down_revision: str | None = "3d8f2b1c6e90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "console_sessions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_console_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_console_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_console_sessions_token_hash")),
    )


def downgrade() -> None:
    op.drop_table("console_sessions")
