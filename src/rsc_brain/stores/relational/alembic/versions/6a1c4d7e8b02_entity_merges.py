"""entity merges: merged_into pointer + merge-proposal queue

Revision ID: 6a1c4d7e8b02
Revises: 5f3b8d2a9c14
Create Date: 2026-07-24 14:00:00.000000

SPEC-09 (v0.2, E6.2): LLM/deterministic alias-merge with an admin confirmation queue (FR-1.9 P1).
A merge tombstones the duplicate entity via ``entities.merged_into`` (never deleted — reversible,
FR-5.5 spirit) and records the proposal in ``entity_merge_proposals``. Both are project-scoped
(project_id NOT NULL + composite index, FR-12.2); a merge never crosses project_id (FR-12.4).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "6a1c4d7e8b02"
down_revision: str | None = "5f3b8d2a9c14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("entities", sa.Column("merged_into", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_entities_merged_into_entities"),
        "entities",
        "entities",
        ["merged_into"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "entity_merge_proposals",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("canonical_entity_id", sa.Uuid(), nullable=False),
        sa.Column("duplicate_entity_id", sa.Uuid(), nullable=False),
        sa.Column("confidence", sa.Numeric(), server_default="0.5", nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("resolved_by", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_entity_merge_proposals_project_id_projects"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["canonical_entity_id"], ["entities.id"],
            name=op.f("fk_entity_merge_proposals_canonical_entity_id_entities"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["duplicate_entity_id"], ["entities.id"],
            name=op.f("fk_entity_merge_proposals_duplicate_entity_id_entities"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_entity_merge_proposals")),
        sa.UniqueConstraint(
            "project_id", "canonical_entity_id", "duplicate_entity_id",
            name=op.f("uq_entity_merge_proposals_project_canonical_duplicate"),
        ),
    )
    op.create_index(
        "ix_entity_merge_proposals_project_id_id", "entity_merge_proposals", ["project_id", "id"]
    )
    op.create_index(
        "ix_entity_merge_proposals_project_id_status",
        "entity_merge_proposals",
        ["project_id", "status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_entity_merge_proposals_project_id_status", table_name="entity_merge_proposals"
    )
    op.drop_index("ix_entity_merge_proposals_project_id_id", table_name="entity_merge_proposals")
    op.drop_table("entity_merge_proposals")
    op.drop_constraint(op.f("fk_entities_merged_into_entities"), "entities", type_="foreignkey")
    op.drop_column("entities", "merged_into")
