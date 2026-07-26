"""Anti-revival tombstones for entity erasure (AUDIT-023 / R43).

Erasing an entity used to delete its row, its aliases and its graph node — and nothing recorded that it
had happened, so the next document naming the same person recreated it as if it never had. The ratified
policy is that erasure never auto-revives and that coming back is an explicit, audited owner decision;
this table is what makes both statements checkable.

Revision ID: e2b6d9a41f07
Revises: d1a7f4c62b95
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e2b6d9a41f07"
down_revision = "d1a7f4c62b95"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erasure_tombstones",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.Column("entity_type", sa.Text(), nullable=True),
        sa.Column(
            "erased_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("erased_by", sa.Uuid(), nullable=True),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_erasure_tombstones"),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
            name="fk_erasure_tombstones_project_id_projects",
        ),
    )
    op.create_index(
        "ix_erasure_tombstones_project_id_normalized_name",
        "erasure_tombstones",
        ["project_id", "normalized_name"],
    )


def downgrade() -> None:
    op.drop_index("ix_erasure_tombstones_project_id_normalized_name", table_name="erasure_tombstones")
    op.drop_table("erasure_tombstones")
