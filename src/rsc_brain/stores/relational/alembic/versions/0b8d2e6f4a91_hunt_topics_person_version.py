"""persist hunt topic scope and version directory people

The console needs two pieces of authority that cannot safely be inferred in the browser:

* a hunt's immutable topic snapshot, especially for gap-less manual hunts; and
* a monotonic person version for optimistic concurrency on edits and deletes.

Both columns are additive, non-null and have legacy-writer-safe defaults.  Old application
revisions can continue inserting rows while the expanded schema is live.  Downgrade removes only
the expansion and restores the exact pre-feature write shape.

Revision ID: 0b8d2e6f4a91
Revises: f3c8e2a91d47
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0b8d2e6f4a91"
down_revision: str | None = "f3c8e2a91d47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hunts",
        sa.Column(
            "topics",
            postgresql.ARRAY(sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column(
        "persons",
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("persons", "version")
    op.drop_column("hunts", "topics")
