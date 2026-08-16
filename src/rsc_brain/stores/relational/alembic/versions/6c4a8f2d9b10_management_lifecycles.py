"""console management lifecycle versions and durable idempotency

Revision ID: 6c4a8f2d9b10
Revises: 0b8d2e6f4a91
Create Date: 2026-08-16 10:00:00.000000

All lifecycle columns are additive, non-null and have legacy-safe server defaults.  Management
commands and audit rows intentionally outlive a deleted project, so the audit FK is removed while
the mandatory project identifier and indexes remain.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "6c4a8f2d9b10"
down_revision: str | None = "0b8d2e6f4a91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects", sa.Column("status", sa.Text(), server_default="active", nullable=False)
    )
    op.add_column(
        "projects", sa.Column("version", sa.Integer(), server_default="1", nullable=False)
    )
    op.add_column("users", sa.Column("version", sa.Integer(), server_default="1", nullable=False))
    op.add_column(
        "project_memberships",
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
    )
    op.add_column(
        "project_memberships",
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "personal_access_tokens",
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
    )
    op.add_column(
        "personal_access_tokens",
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column("topics", sa.Column("status", sa.Text(), server_default="active", nullable=False))
    op.add_column("topics", sa.Column("version", sa.Integer(), server_default="1", nullable=False))

    op.drop_constraint("fk_audit_log_project_id_projects", "audit_log", type_="foreignkey")
    op.create_table(
        "management_commands",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("principal_id", sa.Text(), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("response", postgresql.JSONB(), nullable=False),
        sa.Column("audit_id", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.Text(), server_default="completed", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_management_commands")),
        sa.UniqueConstraint(
            "principal_id",
            "operation",
            "idempotency_key",
            name="uq_management_commands_principal_operation_key",
        ),
    )
    op.create_index(
        "ix_management_commands_project_id_created",
        "management_commands",
        ["project_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_management_commands_project_id_created", table_name="management_commands")
    op.drop_table("management_commands")
    # Newer revisions retain audit evidence after hard tenant deletion. The older FK cannot
    # represent those rows, so a downgrade removes only the now-orphaned evidence before restoring
    # the historical constraint.
    op.execute(
        "DELETE FROM audit_log WHERE NOT EXISTS "
        "(SELECT 1 FROM projects WHERE projects.id = audit_log.project_id)"
    )
    op.create_foreign_key(
        "fk_audit_log_project_id_projects",
        "audit_log",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_column("topics", "version")
    op.drop_column("topics", "status")
    op.drop_column("personal_access_tokens", "version")
    op.drop_column("personal_access_tokens", "status")
    op.drop_column("project_memberships", "version")
    op.drop_column("project_memberships", "status")
    op.drop_column("users", "version")
    op.drop_column("projects", "version")
    op.drop_column("projects", "status")
