"""The tenant-integrity relation map and its migration preflight (AUDIT-039 / R17).

The preflight is a safety mechanism, so it needs its own evidence: an untested guard is a guard
nobody can rely on. What is reachable to assert is the map itself (does it see every relation, and
is each one project-qualified?) and the preflight's answer on a schema that already carries the
constraints — which is necessarily clean, because the database now refuses the rows it looks for.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.tenant_integrity import (
    PROJECT_COLUMN,
    cross_project_violations,
    parent_tables,
    tenant_relations,
    violation_report,
)

from .conftest import Harness

pytestmark = pytest.mark.integration


def test_the_map_sees_every_tenant_owned_relation_and_qualifies_it() -> None:
    """Derived from the mapped schema, so a relation added later is covered without editing this."""
    relations = tenant_relations()
    assert relations, "the relation map is empty — every check built on it would be vacuous"

    expected = {
        (table.name, constraint.referred_table.name)
        for table in models.Base.metadata.sorted_tables
        if PROJECT_COLUMN in table.c
        for constraint in table.foreign_key_constraints
        if constraint.referred_table.name != table.name
        and PROJECT_COLUMN in constraint.referred_table.c
    }
    assert {(r.child, r.parent) for r in relations} == expected

    for relation in relations:
        columns = {
            c.name
            for constraint in models.Base.metadata.tables[relation.child].foreign_key_constraints
            if constraint.referred_table.name == relation.parent
            for c in constraint.columns
        }
        assert PROJECT_COLUMN in columns, (
            f"{relation.child}.{relation.column} -> {relation.parent} is not project-qualified"
        )


def test_every_parent_is_referenced_by_its_project_qualified_key() -> None:
    """A parent can only be referenced by ``(project_id, id)`` if it declares that unique key."""
    for parent in parent_tables():
        table = models.Base.metadata.tables[parent]
        unique_keys = {
            tuple(sorted(c.name for c in constraint.columns))
            for constraint in table.constraints
            if constraint.__class__.__name__ == "UniqueConstraint"
        }
        assert ("id", PROJECT_COLUMN) in unique_keys, f"{parent} lacks a (project_id, id) key"


async def test_preflight_reports_nothing_on_a_constrained_schema(
    build_harness: Callable[..., Harness],
) -> None:
    """The migrated schema has no cross-project reference — and can no longer acquire one."""
    harness = build_harness()
    engine = harness.sm.kw["bind"]
    async with engine.connect() as connection:
        violations = await connection.run_sync(cross_project_violations)
    assert violations == {}


def test_the_report_names_every_relation_and_its_row_count() -> None:
    """An operator has to be able to act on it, so each relation and count appears verbatim."""
    report = violation_report(
        {"chunks.document_id -> documents": 3, "claims.chunk_id -> chunks": 1}
    )
    assert "chunks.document_id -> documents: 3 row(s)" in report
    assert "claims.chunk_id -> chunks: 1 row(s)" in report
    assert "no row is reassigned automatically" in report
