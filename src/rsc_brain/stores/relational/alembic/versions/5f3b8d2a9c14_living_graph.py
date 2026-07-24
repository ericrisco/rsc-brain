"""living graph: claim flags + verdict cache + corrections + feedback ledger

Revision ID: 5f3b8d2a9c14
Revises: 4e7a2c9b1f05
Create Date: 2026-07-24 11:10:00.000000

SPEC-08 (v0.2): credibility/contradictions/correction. Adds the living-graph state flags on
claims, the per-pair contradiction verdict cache, the corrections audit table (DDL §3.8), and the
per-(principal, claim, day) feedback impact ledger. All new tables are project-scoped (project_id
NOT NULL + composite index, FR-12.2).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5f3b8d2a9c14"
down_revision: str | None = "4e7a2c9b1f05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for column in ("disputed", "pending_confirmation", "hunting_candidate"):
        op.add_column(
            "claims",
            sa.Column(column, sa.Boolean(), server_default="false", nullable=False),
        )

    op.create_table(
        "claim_pair_verdicts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("claim_a", sa.Uuid(), nullable=False),
        sa.Column("claim_b", sa.Uuid(), nullable=False),
        sa.Column("judge_version", sa.Text(), nullable=False),
        sa.Column("verdict", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Numeric(), server_default="0.5", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_claim_pair_verdicts_project_id_projects"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["claim_a"], ["claims.id"],
            name=op.f("fk_claim_pair_verdicts_claim_a_claims"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["claim_b"], ["claims.id"],
            name=op.f("fk_claim_pair_verdicts_claim_b_claims"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_claim_pair_verdicts")),
        sa.UniqueConstraint(
            "project_id", "claim_a", "claim_b", "judge_version",
            name=op.f("uq_claim_pair_verdicts_project_id_claim_a_claim_b_judge_version"),
        ),
    )
    op.create_index(
        "ix_claim_pair_verdicts_project_id_id", "claim_pair_verdicts", ["project_id", "id"]
    )

    op.create_table(
        "corrections",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("target_claim", sa.Uuid(), nullable=False),
        sa.Column("new_claim", sa.Uuid(), nullable=True),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column("on_behalf_of", sa.Uuid(), nullable=True),
        sa.Column("role_applied", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("before_text", sa.Text(), nullable=True),
        sa.Column("after_text", sa.Text(), nullable=True),
        sa.Column("hunt_id", sa.Uuid(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_corrections_project_id_projects"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["target_claim"], ["claims.id"],
            name=op.f("fk_corrections_target_claim_claims"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_corrections")),
    )
    op.create_index("ix_corrections_project_id_id", "corrections", ["project_id", "id"])

    op.create_table(
        "feedback_daily_impact",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("principal_id", sa.Text(), nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("impact", sa.Numeric(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_feedback_daily_impact_project_id_projects"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"], ["claims.id"],
            name=op.f("fk_feedback_daily_impact_claim_id_claims"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feedback_daily_impact")),
        sa.UniqueConstraint(
            "project_id", "principal_id", "claim_id", "day",
            name=op.f("uq_feedback_daily_impact_project_id_principal_id_claim_id_day"),
        ),
    )
    op.create_index(
        "ix_feedback_daily_impact_project_id_id", "feedback_daily_impact", ["project_id", "id"]
    )


def downgrade() -> None:
    op.drop_table("feedback_daily_impact")
    op.drop_table("corrections")
    op.drop_index("ix_claim_pair_verdicts_project_id_id", table_name="claim_pair_verdicts")
    op.drop_table("claim_pair_verdicts")
    for column in ("hunting_candidate", "pending_confirmation", "disputed"):
        op.drop_column("claims", column)
