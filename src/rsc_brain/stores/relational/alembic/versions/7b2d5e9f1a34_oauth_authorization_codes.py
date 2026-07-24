"""oauth authorization codes + invitation kind (password reset)

Revision ID: 7b2d5e9f1a34
Revises: 6a1c4d7e8b02
Create Date: 2026-07-24 15:30:00.000000

SPEC-10 (v0.2, E2.5): the OAuth 2.1 authorization server needs a short-lived, single-use,
PKCE-bound authorization code store; and the identity-lifecycle reset reuses the ``invitations``
single-use mechanism, distinguished by a ``kind`` column (invitation | password_reset).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7b2d5e9f1a34"
down_revision: str | None = "6a1c4d7e8b02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "oauth_authorization_codes",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("membership_id", sa.Uuid(), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=True),
        sa.Column("scope", sa.Text(), nullable=True),
        sa.Column("code_challenge", sa.Text(), nullable=True),
        sa.Column("code_challenge_method", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["client_id"], ["oauth_clients.id"],
            name=op.f("fk_oauth_authorization_codes_client_id_oauth_clients"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["membership_id"], ["project_memberships.id"],
            name=op.f("fk_oauth_authorization_codes_membership_id_project_memberships"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_authorization_codes")),
        sa.UniqueConstraint("code_hash", name=op.f("uq_oauth_authorization_codes_code_hash")),
    )
    op.add_column(
        "invitations",
        sa.Column("kind", sa.Text(), server_default="invitation", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("invitations", "kind")
    op.drop_table("oauth_authorization_codes")
