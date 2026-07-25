"""project-qualified relational references (AUDIT-039 / R17)

Every tenant-owned foreign key was ID-only, so a write that bypassed the service layer could
permanently attach one project's child to another project's parent — and the resulting row is
invisible to every scope check that compares only the row's own ``project_id``. The worst case is
``entity_merge_proposals``: applying a proposal rewrites entity identity, so one whose duplicate
lived in another project would merge one tenant's entity into another's.

Each reference becomes ``(project_id, <column>) -> parent (project_id, id)``, which the database
enforces. Two details this depends on:

* the parent needs a unique key on ``(project_id, id)`` to be referenced that way — added here, and
  cheap since ``id`` is already unique;
* a composite ``ON DELETE SET NULL`` would try to null ``project_id`` too, which is NOT NULL. PG15+
  can restrict which columns are nulled, so those references use
  ``ON DELETE SET NULL (<column>)`` — the tenant stays, only the reference goes.

Pre-existing violations block the upgrade with a per-relation report instead of being repaired:
choosing which tenant owns a fact is an operator decision (plan §7 — no silent reassignment). The
same report is available before upgrading via ``brain db preflight``.

The relation list below is FROZEN as literal data. Deriving it from the mapped models would make
this migration mean something different after any later schema change; a migration describes one
transition, so it carries its own inventory.

Revision ID: e6c2a9f4b715
Revises: d5b1f7c3a920
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "e6c2a9f4b715"
down_revision: str | None = "d5b1f7c3a920"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (child table, child column, parent table, ON DELETE action, existing ID-only constraint name)
RELATIONS: tuple[tuple[str, str, str, str, str], ...] = (
    ("chunks", "document_id", "documents", "CASCADE", "fk_chunks_document_id_documents"),
    ("claim_pair_verdicts", "claim_a", "claims", "CASCADE", "fk_claim_pair_verdicts_claim_a_claims"),
    ("claim_pair_verdicts", "claim_b", "claims", "CASCADE", "fk_claim_pair_verdicts_claim_b_claims"),
    ("claims", "chunk_id", "chunks", "CASCADE", "fk_claims_chunk_id_chunks"),
    ("corrections", "target_claim", "claims", "CASCADE", "fk_corrections_target_claim_claims"),
    ("documents", "source_id", "sources", "SET NULL", "fk_documents_source_id_sources"),
    ("entity_aliases", "entity_id", "entities", "CASCADE", "fk_entity_aliases_entity_id_entities"),
    (
        "entity_merge_proposals",
        "canonical_entity_id",
        "entities",
        "CASCADE",
        "fk_entity_merge_proposals_canonical_entity_id_entities",
    ),
    (
        "entity_merge_proposals",
        "duplicate_entity_id",
        "entities",
        "CASCADE",
        "fk_entity_merge_proposals_duplicate_entity_id_entities",
    ),
    (
        "feedback_daily_impact",
        "claim_id",
        "claims",
        "CASCADE",
        "fk_feedback_daily_impact_claim_id_claims",
    ),
    ("hunts", "gap_id", "gaps", "SET NULL", "fk_hunts_gap_id_gaps"),
    ("hunts", "person_id", "persons", "SET NULL", "fk_hunts_person_id_persons"),
    ("ingest_errors", "document_id", "documents", "CASCADE", "fk_ingest_errors_document_id_documents"),
    ("ingest_runs", "document_id", "documents", "CASCADE", "fk_ingest_runs_document_id_documents"),
    ("skills", "owner_person_id", "persons", "SET NULL", "fk_skills_owner_person_id_persons"),
)

PARENTS: tuple[str, ...] = (
    "chunks",
    "claims",
    "documents",
    "entities",
    "gaps",
    "persons",
    "sources",
)


def _qualified_name(child: str, column: str, parent: str) -> str:
    return f"fk_{child}_project_id_{column}_{parent}"


def _violations() -> dict[str, int]:
    connection = op.get_bind()
    found: dict[str, int] = {}
    for child, column, parent, _ondelete, _name in RELATIONS:
        count = connection.execute(
            text(
                f"""
                SELECT count(*) FROM {child} c
                JOIN {parent} p ON p.id = c.{column}
                WHERE c.project_id IS DISTINCT FROM p.project_id
                """  # noqa: S608 - identifiers are frozen literals above, never input
            )
        ).scalar()
        if count:
            found[f"{child}.{column} -> {parent}"] = int(count)
    return found


def upgrade() -> None:
    violations = _violations()
    if violations:
        report = "\n".join(f"  {name}: {count} row(s)" for name, count in sorted(violations.items()))
        raise RuntimeError(
            "cross-project references exist and must be resolved by an operator before the "
            "project-qualified constraints can be added (no row is reassigned automatically):\n"
            + report
        )

    for parent in PARENTS:
        op.create_unique_constraint(f"uq_{parent}_project_id_id", parent, ["project_id", "id"])

    for child, column, parent, ondelete, existing in RELATIONS:
        op.drop_constraint(existing, child, type_="foreignkey")
        action = f"SET NULL ({column})" if ondelete == "SET NULL" else ondelete
        op.execute(
            f"ALTER TABLE {child} "
            f"ADD CONSTRAINT {_qualified_name(child, column, parent)} "
            f"FOREIGN KEY (project_id, {column}) "
            f"REFERENCES {parent} (project_id, id) ON DELETE {action}"
        )


def downgrade() -> None:
    for child, column, parent, ondelete, existing in RELATIONS:
        op.drop_constraint(_qualified_name(child, column, parent), child, type_="foreignkey")
        op.execute(
            f"ALTER TABLE {child} ADD CONSTRAINT {existing} "
            f"FOREIGN KEY ({column}) REFERENCES {parent} (id) ON DELETE {ondelete}"
        )
    for parent in PARENTS:
        op.drop_constraint(f"uq_{parent}_project_id_id", parent, type_="unique")
