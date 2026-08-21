"""ordered claim occurrences, supersession lineage and durable publish drafts

Revision ID: 7d4e9a2c1b63
Revises: 6c4a8f2d9b10
Create Date: 2026-08-21 06:15:00.000000

Existing claim IDs and credibility values are never rewritten. Legacy provenance is backfilled from
the claim's concrete chunk, while chunk ordinals are derived deterministically within each document.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7d4e9a2c1b63"
down_revision: str | None = "7d5b9e3a1c42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHUNK_ORDINAL_INDEX = "uq_chunks_project_document_ordinal"


def upgrade() -> None:
    op.add_column("chunks", sa.Column("ordinal", sa.Integer(), nullable=True))
    op.execute(
        """
        WITH ordered AS (
            SELECT id, row_number() OVER (PARTITION BY project_id, document_id ORDER BY id) - 1 AS n
            FROM chunks
        )
        UPDATE chunks SET ordinal = ordered.n FROM ordered WHERE chunks.id = ordered.id
        """
    )
    op.alter_column("chunks", "ordinal", nullable=False, server_default="0")
    # Chunks is corpus-sized. Build the backing index without blocking readers/writers, then attach
    # the semantic constraint with only a short catalogue lock.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE UNIQUE INDEX CONCURRENTLY uq_chunks_project_document_ordinal "
            "ON chunks (project_id, document_id, ordinal)"
        )
    op.execute(
        "ALTER TABLE chunks ADD CONSTRAINT uq_chunks_project_document_ordinal "
        "UNIQUE USING INDEX uq_chunks_project_document_ordinal"
    )

    op.add_column("ingest_runs", sa.Column("publish_draft", postgresql.JSONB(), nullable=True))

    op.create_table(
        "claim_occurrences",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("chunk_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_claim_occurrences"),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name="fk_claim_occurrences_project_id_projects",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "claim_id"],
            ["claims.project_id", "claims.id"],
            name="fk_claim_occurrences_project_id_claim_id_claims",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "document_id"],
            ["documents.project_id", "documents.id"],
            name="fk_claim_occurrences_project_id_document_id_documents",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "chunk_id"],
            ["chunks.project_id", "chunks.id"],
            name="fk_claim_occurrences_project_id_chunk_id_chunks",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "project_id",
            "claim_id",
            "document_id",
            "chunk_id",
            name="uq_claim_occurrence_claim_doc_chunk",
        ),
    )
    op.create_index(
        "ix_claim_occurrences_project_document",
        "claim_occurrences",
        ["project_id", "document_id"],
    )
    op.create_index(
        "ix_claim_occurrences_project_claim",
        "claim_occurrences",
        ["project_id", "claim_id"],
    )

    op.create_table(
        "claim_supersessions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("previous_claim_id", sa.Uuid(), nullable=False),
        sa.Column("replacement_claim_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "previous_claim_id <> replacement_claim_id",
            name="ck_claim_supersessions_distinct_claims",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_claim_supersessions"),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name="fk_claim_supersessions_project_id_projects",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "previous_claim_id"],
            ["claims.project_id", "claims.id"],
            name="fk_claim_supersessions_project_previous_claim",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "replacement_claim_id"],
            ["claims.project_id", "claims.id"],
            name="fk_claim_supersessions_project_replacement_claim",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "project_id", "previous_claim_id", name="uq_claim_supersession_previous"
        ),
    )
    op.create_index(
        "ix_claim_supersessions_project_replacement",
        "claim_supersessions",
        ["project_id", "replacement_claim_id"],
    )

    op.execute(
        """
        INSERT INTO claim_occurrences (project_id, claim_id, document_id, chunk_id)
        SELECT c.project_id, c.id, ch.document_id, ch.id
        FROM claims AS c
        JOIN chunks AS ch ON ch.project_id = c.project_id AND ch.id = c.chunk_id
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("ix_claim_supersessions_project_replacement", table_name="claim_supersessions")
    op.drop_table("claim_supersessions")
    op.drop_index("ix_claim_occurrences_project_claim", table_name="claim_occurrences")
    op.drop_index("ix_claim_occurrences_project_document", table_name="claim_occurrences")
    op.drop_table("claim_occurrences")
    op.drop_column("ingest_runs", "publish_draft")
    op.drop_constraint(CHUNK_ORDINAL_INDEX, "chunks", type_="unique")
    op.drop_column("chunks", "ordinal")
