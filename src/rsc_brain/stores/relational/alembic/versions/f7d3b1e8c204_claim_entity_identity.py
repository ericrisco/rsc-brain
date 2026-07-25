"""deterministic entity identity on claims (AUDIT-035 / R16)

A claim recorded only the *names* of its endpoints, while graph identity is ``entity_id(type,
name)``. Two entities can share a normalized name and differ by type, so a claim about one of them
authorized the other: a name is not an identity. Recording the same deterministic key the graph node
carries makes entity-level authorization exact.

Nullable and additive: claims written before this (and any claim whose endpoint could not be
resolved to a typed entity) keep NULL keys, and the authorization rule falls back to matching by name
only when that name resolves to exactly one identity — an ambiguous name authorizes nothing, which is
the safe direction.

Not a foreign key: the key is an identity derived from (type, name), not a reference to a row.

Revision ID: f7d3b1e8c204
Revises: e6c2a9f4b715
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f7d3b1e8c204"
down_revision: str | None = "e6c2a9f4b715"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("claims", sa.Column("subject_entity_key", sa.Uuid(), nullable=True))
    op.add_column("claims", sa.Column("object_entity_key", sa.Uuid(), nullable=True))
    op.create_index(
        "ix_claims_project_id_subject_entity_key", "claims", ["project_id", "subject_entity_key"]
    )
    op.create_index(
        "ix_claims_project_id_object_entity_key", "claims", ["project_id", "object_entity_key"]
    )


def downgrade() -> None:
    op.drop_index("ix_claims_project_id_object_entity_key", table_name="claims")
    op.drop_index("ix_claims_project_id_subject_entity_key", table_name="claims")
    op.drop_column("claims", "object_entity_key")
    op.drop_column("claims", "subject_entity_key")
