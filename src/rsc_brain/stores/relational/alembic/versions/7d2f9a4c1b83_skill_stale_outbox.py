"""durable skill ownership and stale-notification outbox

Revision ID: 7d2f9a4c1b83
Revises: 6c4a8f2d9b10
Create Date: 2026-08-21 08:20:00.000000

The expansion is compatible with the previous writer: every new column on an existing table is
nullable or has a server default. The outbox is tenant-qualified at both references and owns one
row per monotonic stale generation.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7d2f9a4c1b83"
down_revision: str | None = "6c4a8f2d9b10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "skills", sa.Column("stale_generation", sa.Integer(), server_default="0", nullable=False)
    )
    op.create_unique_constraint("uq_skills_project_id_id", "skills", ["project_id", "id"])
    op.add_column("audit_log", sa.Column("resource_type", sa.Text(), nullable=True))
    op.add_column("audit_log", sa.Column("resource_id", sa.Uuid(), nullable=True))
    op.create_table(
        "skill_stale_notifications",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("owner_person_id", sa.Uuid(), nullable=True),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_skill_stale_notifications_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "skill_id"],
            ["skills.project_id", "skills.id"],
            name="fk_stale_notice_project_skill",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "owner_person_id"],
            ["persons.project_id", "persons.id"],
            name="fk_stale_notice_project_owner",
            ondelete="SET NULL (owner_person_id)",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_skill_stale_notifications")),
        sa.UniqueConstraint(
            "project_id",
            "skill_id",
            "generation",
            name=op.f("uq_skill_stale_notifications_project_id_skill_id_generation"),
        ),
    )
    op.create_index(
        "ix_skill_stale_notifications_project_due",
        "skill_stale_notifications",
        ["project_id", "state", "next_attempt_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_skill_stale_notifications_project_due", table_name="skill_stale_notifications"
    )
    op.drop_table("skill_stale_notifications")
    op.drop_column("audit_log", "resource_id")
    op.drop_column("audit_log", "resource_type")
    op.drop_constraint("uq_skills_project_id_id", "skills", type_="unique")
    op.drop_column("skills", "stale_generation")
