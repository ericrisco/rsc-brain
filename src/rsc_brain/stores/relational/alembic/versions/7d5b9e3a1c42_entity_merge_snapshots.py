"""lossless tenant-safe entity merge snapshots (AUDIT-012)

Revision ID: 7d5b9e3a1c42
Revises: 6c4a8f2d9b10
Create Date: 2026-08-21 04:35:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7d5b9e3a1c42"
down_revision: str | None = "6c4a8f2d9b10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _legacy_violations() -> dict[str, int]:
    connection = op.get_bind()
    checks = {
        "self proposal": """
            SELECT count(*) FROM entity_merge_proposals
            WHERE canonical_entity_id = duplicate_entity_id
        """,
        "cross-type proposal": """
            SELECT count(*) FROM entity_merge_proposals p
            JOIN entities c ON c.id = p.canonical_entity_id
            JOIN entities d ON d.id = p.duplicate_entity_id
            WHERE c.project_id IS DISTINCT FROM p.project_id
               OR d.project_id IS DISTINCT FROM p.project_id
               OR c.type IS DISTINCT FROM d.type
        """,
        "invalid merged_into": """
            SELECT count(*) FROM entities d
            JOIN entities c ON c.id = d.merged_into
            WHERE d.project_id IS DISTINCT FROM c.project_id
               OR d.type IS DISTINCT FROM c.type
               OR d.id = c.id
        """,
    }
    return {
        name: int(connection.execute(sa.text(statement)).scalar() or 0)
        for name, statement in checks.items()
    }


def upgrade() -> None:
    violations = {name: count for name, count in _legacy_violations().items() if count}
    if violations:
        detail = ", ".join(f"{name}={count}" for name, count in sorted(violations.items()))
        raise RuntimeError(
            "entity-merge integrity violations must be resolved by an operator before upgrade: "
            + detail
        )

    op.drop_constraint("fk_entities_merged_into_entities", "entities", type_="foreignkey")
    op.create_unique_constraint(
        "uq_entities_project_type_id",
        "entities",
        ["project_id", "type", "id"],
    )
    op.create_check_constraint(
        op.f("ck_entities_merged_into_not_self"),
        "entities",
        "merged_into IS NULL OR merged_into <> id",
    )
    op.execute(
        "ALTER TABLE entities ADD CONSTRAINT fk_entities_project_type_merged_into_entities "
        "FOREIGN KEY (project_id, type, merged_into) "
        "REFERENCES entities (project_id, type, id) "
        "ON DELETE SET NULL (merged_into)"
    )
    op.create_check_constraint(
        op.f("ck_entity_merge_proposals_distinct_entities"),
        "entity_merge_proposals",
        "canonical_entity_id <> duplicate_entity_id",
    )
    op.create_unique_constraint(
        "uq_entity_merge_proposals_project_id_id",
        "entity_merge_proposals",
        ["project_id", "id"],
    )
    op.create_table(
        "entity_merge_snapshots",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("proposal_id", sa.Uuid(), nullable=False),
        sa.Column("canonical_entity_id", sa.Uuid(), nullable=False),
        sa.Column("duplicate_entity_id", sa.Uuid(), nullable=False),
        sa.Column("canonical_graph_node_id", sa.Text(), nullable=False),
        sa.Column("duplicate_graph_node_id", sa.Text(), nullable=False),
        sa.Column("previous_proposal_status", sa.Text(), nullable=False),
        sa.Column("aliases_before", postgresql.JSONB(), nullable=False),
        sa.Column("aliases_after", postgresql.JSONB(), nullable=False),
        sa.Column("graph_before", postgresql.JSONB(), nullable=False),
        sa.Column("graph_after", postgresql.JSONB(), nullable=False),
        sa.Column("duplicate_node_before", postgresql.JSONB(), nullable=False),
        sa.Column("duplicate_node_after", postgresql.JSONB(), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "applied_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_by", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "canonical_entity_id <> duplicate_entity_id",
            name=op.f("ck_entity_merge_snapshots_distinct_entities"),
        ),
        sa.CheckConstraint(
            "previous_proposal_status = 'needs_review'",
            name=op.f("ck_entity_merge_snapshots_previous_status"),
        ),
        sa.CheckConstraint(
            "snapshot_version = 1",
            name=op.f("ck_entity_merge_snapshots_version"),
        ),
        sa.CheckConstraint(
            "(reversed_at IS NULL AND reversed_by IS NULL) OR "
            "(reversed_at IS NOT NULL AND reversed_by IS NOT NULL)",
            name=op.f("ck_entity_merge_snapshots_reversal_pair"),
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name="fk_entity_merge_snapshots_project_id_projects",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "proposal_id"],
            ["entity_merge_proposals.project_id", "entity_merge_proposals.id"],
            name="fk_merge_snapshots_project_proposal",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "canonical_entity_id"],
            ["entities.project_id", "entities.id"],
            name="fk_merge_snapshots_project_canonical",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "duplicate_entity_id"],
            ["entities.project_id", "entities.id"],
            name="fk_merge_snapshots_project_duplicate",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_entity_merge_snapshots"),
    )
    op.create_index(
        "ix_entity_merge_snapshots_project_id_id",
        "entity_merge_snapshots",
        ["project_id", "id"],
    )
    op.create_index(
        "uq_entity_merge_snapshots_active_proposal",
        "entity_merge_snapshots",
        ["project_id", "proposal_id"],
        unique=True,
        postgresql_where=sa.text("reversed_at IS NULL"),
    )


def downgrade() -> None:
    connection = op.get_bind()
    snapshots = int(
        connection.execute(sa.text("SELECT count(*) FROM entity_merge_snapshots")).scalar() or 0
    )
    if snapshots:
        raise RuntimeError("refusing downgrade: entity merge snapshot history would be lost")
    op.drop_index("uq_entity_merge_snapshots_active_proposal", table_name="entity_merge_snapshots")
    op.drop_index("ix_entity_merge_snapshots_project_id_id", table_name="entity_merge_snapshots")
    op.drop_table("entity_merge_snapshots")
    op.drop_constraint(
        "uq_entity_merge_proposals_project_id_id",
        "entity_merge_proposals",
        type_="unique",
    )
    op.drop_constraint(
        op.f("ck_entity_merge_proposals_distinct_entities"),
        "entity_merge_proposals",
        type_="check",
    )
    op.drop_constraint(
        "fk_entities_project_type_merged_into_entities", "entities", type_="foreignkey"
    )
    op.drop_constraint(
        op.f("ck_entities_merged_into_not_self"),
        "entities",
        type_="check",
    )
    op.drop_constraint("uq_entities_project_type_id", "entities", type_="unique")
    op.create_foreign_key(
        "fk_entities_merged_into_entities",
        "entities",
        "entities",
        ["merged_into"],
        ["id"],
        ondelete="SET NULL",
    )
