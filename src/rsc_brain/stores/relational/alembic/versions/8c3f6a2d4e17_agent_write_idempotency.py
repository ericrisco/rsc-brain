"""agent write idempotency + per-principal usage/rate windows

Revision ID: 8c3f6a2d4e17
Revises: 7b2d5e9f1a34
Create Date: 2026-07-24 17:00:00.000000

SPEC-11 (v0.2, E4.5): submit_knowledge idempotency (a retry with the same key never duplicates
claims, FR-14.4) and per-principal quotas (FR-14.7) — a sliding per-minute rate window and a daily
recall/write usage ledger, both in Postgres (shared across workers, no extra service). All
project-scoped (FR-12.2).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "8c3f6a2d4e17"
down_revision: str | None = "7b2d5e9f1a34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_write_idempotency",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("principal_id", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column(
            "claim_ids", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_agent_write_idempotency_project_id_projects"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_write_idempotency")),
        sa.UniqueConstraint(
            "project_id", "principal_id", "idempotency_key",
            name=op.f("uq_agent_write_idempotency_project_principal_key"),
        ),
    )

    op.create_table(
        "principal_daily_usage",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("principal_id", sa.Text(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("recalls", sa.Integer(), server_default="0", nullable=False),
        sa.Column("writes", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_principal_daily_usage_project_id_projects"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_principal_daily_usage")),
        sa.UniqueConstraint(
            "project_id", "principal_id", "day",
            name=op.f("uq_principal_daily_usage_project_principal_day"),
        ),
    )

    op.create_table(
        "principal_rate_window",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("principal_id", sa.Text(), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), server_default="0", nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_principal_rate_window")),
        sa.UniqueConstraint(
            "principal_id", "window_start", name=op.f("uq_principal_rate_window_principal_start")
        ),
    )


def downgrade() -> None:
    op.drop_table("principal_rate_window")
    op.drop_table("principal_daily_usage")
    op.drop_table("agent_write_idempotency")
