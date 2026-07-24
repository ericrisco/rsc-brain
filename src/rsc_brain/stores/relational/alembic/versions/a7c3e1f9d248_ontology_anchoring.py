"""ontology anchoring (SPEC-24, D17 / FR-17.x)

Optional, per-project, off by default: `entities` gain a nullable `ontology_uri` + `ontology_valid`
anchor (open-world — unanchored entities are untouched), and an `ontologies` table stores the
versioned OWL/RDF/SKOS files. Purely additive: a v0.4 dump upgrades cleanly (NFR-8) and nothing
changes for installs that never enable the layer.

Revision ID: a7c3e1f9d248
Revises: f1a2b3c4d5e6
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c3e1f9d248"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("entities", sa.Column("ontology_uri", sa.Text(), nullable=True))
    op.add_column(
        "entities",
        sa.Column("ontology_valid", sa.Boolean(), server_default="false", nullable=False),
    )
    op.create_table(
        "ontologies",
        sa.Column(
            "id",
            sa.Uuid(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
            primary_key=True,
        ),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("format", sa.Text(), nullable=False),  # owl | rdf | skos | turtle
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("uri_base", sa.Text(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column(
            "uploaded_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Index("ix_ontologies_project_id_id", "project_id", "id"),
    )


def downgrade() -> None:
    op.drop_table("ontologies")
    op.drop_column("entities", "ontology_valid")
    op.drop_column("entities", "ontology_uri")
