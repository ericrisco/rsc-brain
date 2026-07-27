"""The embedding cache belongs to a project (AUDIT-022 / F-025).

Keyed by text digest alone, `embedding_cache` was a cross-tenant confirmation oracle — through the asking
tenant's own usage counter, not through timing: a string another project had embedded cost nothing, a new
one cost a provider call, so a project could confirm another's exact content by reading its own bill. It
also made erasure undecidable, since no entry belonged to anyone.

**Existing rows are deleted, not migrated.** A pre-existing entry has no owner, and there is no honest way
to invent one: attributing it to a project would grant that project a vector derived from text it may never
have seen, and keeping it unattributed would preserve exactly the oracle this migration removes. A cache is
derived data — dropping it costs re-embedding on next use and never costs correctness, which is the whole
reason it is safe to be strict here.

Revision ID: f3c8e2a91d47
Revises: e2b6d9a41f07
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f3c8e2a91d47"
down_revision = "e2b6d9a41f07"
branch_labels = None
depends_on = None

UNIQUE = "uq_embedding_cache_project_text_model_dim"
#: The name the creating migration actually deployed — not the one the naming convention would derive.
#: Dropping a constraint by a guessed name fails at upgrade time, on the operator's instance.
OLD_UNIQUE = "uq_embedding_cache_hash_model_dim"


def upgrade() -> None:
    # Unattributable by construction: no owner exists to assign, so the entries go.
    op.execute(sa.text("DELETE FROM embedding_cache"))
    op.add_column("embedding_cache", sa.Column("project_id", sa.Uuid(), nullable=False))
    op.create_foreign_key(
        "fk_embedding_cache_project_id_projects",
        "embedding_cache",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # The cascade is what makes project erasure complete for the cache without a second delete path.
    with op.batch_alter_table("embedding_cache") as batch:
        batch.drop_constraint(OLD_UNIQUE, type_="unique")
        batch.create_unique_constraint(
            UNIQUE, ["project_id", "text_hash", "model", "dimension"]
        )


def downgrade() -> None:
    # Same reasoning in reverse: a downgraded install must not inherit rows whose owner it is about to
    # forget, because that is the oracle again.
    op.execute(sa.text("DELETE FROM embedding_cache"))
    with op.batch_alter_table("embedding_cache") as batch:
        batch.drop_constraint(UNIQUE, type_="unique")
        batch.create_unique_constraint(OLD_UNIQUE, ["text_hash", "model", "dimension"])
    op.drop_constraint("fk_embedding_cache_project_id_projects", "embedding_cache", type_="foreignkey")
    op.drop_column("embedding_cache", "project_id")
