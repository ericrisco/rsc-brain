"""Atomic feedback budget, unique document versions, one active ontology (R30, R33, R34).

Three findings share one shape — a value read in one transaction and spent in another — and each needs
the database to hold the invariant the application was only hoping for:

* ``documents``: a unique ``(project_id, logical_id, version)``, so two revisions of one logical
  document cannot both claim version 2. Admission retries the conflict instead of silently duplicating.
* ``feedback_daily_impact.prev_impact``: lets one upsert report how much of a request it granted, which
  is what makes the daily cap hold under concurrent signals.
* ``ontologies``: a unique ``(project_id, name, version)`` plus a partial unique index over
  ``(project_id, name) WHERE active``, so "the active ontology" is a fact rather than whichever row the
  planner happened to return first.

Existing rows are reconciled before each constraint is added: an install that already has colliding
versions or two active ontologies has to upgrade, not fail. Renumbering is deterministic
(each table's own arrival stamp, then ``id``), and among duplicate actives the newest version stays active.

Revision ID: d1a7f4c62b95
Revises: c9f2a6d5b813
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d1a7f4c62b95"
down_revision = "c9f2a6d5b813"
branch_labels = None
depends_on = None

DOC_UNIQUE = "uq_documents_project_logical_version"
ONTOLOGY_UNIQUE = "uq_ontologies_project_name_version"
ONTOLOGY_ACTIVE = "uq_ontologies_project_name_active"

# Each table stamps its arrival under its own name (`ingested_at`, `uploaded_at`), so the ordering
# column is a parameter rather than an assumption.
_RENUMBER = """
WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY project_id, {group} ORDER BY {stamp}, id) AS position
    FROM {table}
)
UPDATE {table} AS t
SET version = ranked.position
FROM ranked
WHERE ranked.id = t.id AND t.version <> ranked.position
"""

_DEACTIVATE_DUPLICATES = """
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY project_id, name ORDER BY version DESC, uploaded_at DESC, id DESC
           ) AS position
    FROM ontologies
    WHERE active
)
UPDATE ontologies AS o
SET active = false
FROM ranked
WHERE ranked.id = o.id AND ranked.position > 1
"""


def upgrade() -> None:
    op.execute(sa.text(_RENUMBER.format(table="documents", group="logical_id", stamp="ingested_at")))
    op.create_unique_constraint(DOC_UNIQUE, "documents", ["project_id", "logical_id", "version"])

    op.add_column(
        "feedback_daily_impact",
        sa.Column("prev_impact", sa.Numeric(), server_default="0", nullable=False),
    )

    op.execute(sa.text(_RENUMBER.format(table="ontologies", group="name", stamp="uploaded_at")))
    op.execute(sa.text(_DEACTIVATE_DUPLICATES))
    op.create_unique_constraint(ONTOLOGY_UNIQUE, "ontologies", ["project_id", "name", "version"])
    op.create_index(
        ONTOLOGY_ACTIVE,
        "ontologies",
        ["project_id", "name"],
        unique=True,
        postgresql_where=sa.text("active"),
    )


def downgrade() -> None:
    op.drop_index(ONTOLOGY_ACTIVE, table_name="ontologies")
    op.drop_constraint(ONTOLOGY_UNIQUE, "ontologies", type_="unique")
    op.drop_column("feedback_daily_impact", "prev_impact")
    op.drop_constraint(DOC_UNIQUE, "documents", type_="unique")
