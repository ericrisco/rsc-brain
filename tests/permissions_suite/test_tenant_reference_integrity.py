"""Tenant-qualified relational references (AUDIT-039 / R17, task T001 RED).

Every tenant-owned child row must be qualified by the SAME project as its parent, enforced by the
DATABASE and not merely by application code. Today every foreign key is ID-only
(``src/rsc_brain/stores/relational/models.py:223-295, 336-344, 496-639``), so a write that bypasses
the service layer — a bug, a migration, a repair script, a future code path that forgets
``ProjectScope.require`` — can permanently attach project A's child to project B's parent. Once
written, that row is invisible to every scope check that only compares ``project_id`` on the row
itself.

Two complementary proofs, because neither alone is sufficient:

1. **Enumeration** over the live database catalogue: for every relation where child and parent are
   both tenant-owned, the deployed foreign key must carry ``project_id`` on both sides. This is what
   makes the guarantee total rather than sampled — a relation added later is covered automatically.
2. **Behaviour** on representatives spanning the three model ranges named in the finding: a direct
   SQL insert of a cross-project child is rejected by the database, and the legitimate same-project
   insert still succeeds.

Deliberately NOT here: the migration preflight that must report pre-existing cross-project rows
without silently reassigning ownership. That entry point is authored by the migration task (T006);
asserting against it now would fail on import rather than on behaviour. It is recorded as
outstanding coverage, not as covered.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

PROJECT_COLUMN = "project_id"


def _tenant_owned_relations() -> list[tuple[str, str, tuple[str, ...]]]:
    """Every (child table, parent table, child fk columns) where BOTH sides are tenant-owned.

    Derived from the mapped schema so a relation added later is covered without editing this test.
    """
    relations: list[tuple[str, str, tuple[str, ...]]] = []
    for table in models.Base.metadata.sorted_tables:
        if PROJECT_COLUMN not in table.c:
            continue
        for constraint in table.foreign_key_constraints:
            parent = constraint.referred_table
            if parent.name == table.name or PROJECT_COLUMN not in parent.c:
                continue
            relations.append((table.name, parent.name, tuple(c.name for c in constraint.columns)))
    return sorted(relations)


async def test_every_tenant_owned_relation_is_project_qualified(
    build_harness: Callable[..., Harness],
) -> None:
    """R17 — the deployed foreign key must include ``project_id`` on both sides.

    Asserted against the live catalogue (``pg_constraint``), not the Python models: the schema the
    database actually enforces is the only thing that stops a bypassing write.
    """
    harness = build_harness()
    relations = _tenant_owned_relations()
    assert relations, "the tenant-owned relation enumeration is empty — the check would be vacuous"

    query = text(
        """
        SELECT
            con.conname,
            (SELECT array_agg(att.attname ORDER BY att.attname)
               FROM unnest(con.conkey) AS k(attnum)
               JOIN pg_attribute att
                 ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS child_columns,
            (SELECT array_agg(att.attname ORDER BY att.attname)
               FROM unnest(con.confkey) AS k(attnum)
               JOIN pg_attribute att
                 ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS parent_columns
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        WHERE con.contype = 'f' AND child.relname = :child AND parent.relname = :parent
        """
    )

    unqualified: list[str] = []
    async with harness.sm() as session:
        for child, parent, fk_columns in relations:
            rows = (await session.execute(query, {"child": child, "parent": parent})).all()
            qualified = any(
                PROJECT_COLUMN in (row.child_columns or [])
                and PROJECT_COLUMN in (row.parent_columns or [])
                for row in rows
            )
            if not qualified:
                unqualified.append(f"{child}.{'+'.join(fk_columns)} -> {parent}")

    assert not unqualified, (
        f"{len(unqualified)} of {len(relations)} tenant-owned relations are enforced by an ID-only "
        "foreign key, so a bypassing write can attach a child to another project's parent: "
        f"{unqualified}"
    )


async def _two_projects(harness: Harness) -> tuple[str, str]:
    a = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    b = await harness.setup_project(unique_slug("globex"), [("general", 0)])
    return a, b


async def _document(harness: Harness, project_id: str) -> str:
    async with harness.sm() as session:
        doc = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id=unique_slug("doc"),
            checksum=unique_slug("sum"),
            status="processed",
        )
        session.add(doc)
        await session.commit()
        return str(doc.id)


async def _claim(harness: Harness, project_id: str) -> str:
    async with harness.sm() as session:
        claim = models.Claim(project_id=uuid.UUID(project_id), text="the SLA is 24h")
        session.add(claim)
        await session.commit()
        return str(claim.id)


async def _entity(harness: Harness, project_id: str, name: str) -> str:
    async with harness.sm() as session:
        entity = models.Entity(
            project_id=uuid.UUID(project_id),
            name=name,
            normalized_name=name.lower(),
            type="org",
        )
        session.add(entity)
        await session.commit()
        return str(entity.id)


async def _insert_raw(harness: Harness, statement: str, params: dict[str, object]) -> None:
    """A write that bypasses the service layer entirely — the threat model this requirement covers."""
    async with harness.sm() as session:
        await session.execute(text(statement), params)
        await session.commit()


CHUNK_INSERT = (
    "INSERT INTO chunks (id, project_id, document_id, kind, text) "
    "VALUES (:id, :project_id, :parent, 'prose', 'leaked')"
)
CORRECTION_INSERT = (
    "INSERT INTO corrections (id, project_id, target_claim, status) "
    "VALUES (:id, :project_id, :parent, 'applied')"
)


async def test_cross_project_child_insert_is_rejected_by_the_database(
    build_harness: Callable[..., Harness],
) -> None:
    """R17 — representatives from each model range named in the finding.

    chunks -> documents (range 223-295) and corrections -> claims (range 496-639). Both inserts are
    raw SQL: the guarantee under test is the schema's, so the test must not route through the
    application checks that already exist.
    """
    harness = build_harness()
    a, b = await _two_projects(harness)

    parent_document_in_b = await _document(harness, b)
    parent_claim_in_b = await _claim(harness, b)

    for label, statement, parent in (
        ("chunks -> documents", CHUNK_INSERT, parent_document_in_b),
        ("corrections -> claims", CORRECTION_INSERT, parent_claim_in_b),
    ):
        with pytest.raises(IntegrityError):
            await _insert_raw(
                harness,
                statement,
                {"id": uuid.uuid4(), "project_id": uuid.UUID(a), "parent": uuid.UUID(parent)},
            )
        # If the insert was (wrongly) accepted, the row now exists and proves the disclosure.
        async with harness.sm() as session:
            leaked = await session.execute(
                text(
                    f"SELECT count(*) FROM {statement.split()[2]} "
                    "WHERE project_id = :a AND id IS NOT NULL"
                ),
                {"a": uuid.UUID(a)},
            )
            assert leaked.scalar() == 0, f"{label}: a cross-project child row was persisted"


async def test_same_project_child_insert_still_succeeds(
    build_harness: Callable[..., Harness],
) -> None:
    """R17 guard — the constraint must reject only the unsafe write, never the legitimate one."""
    harness = build_harness()
    a, _ = await _two_projects(harness)

    parent_document = await _document(harness, a)
    parent_claim = await _claim(harness, a)

    await _insert_raw(
        harness,
        CHUNK_INSERT,
        {"id": uuid.uuid4(), "project_id": uuid.UUID(a), "parent": uuid.UUID(parent_document)},
    )
    await _insert_raw(
        harness,
        CORRECTION_INSERT,
        {"id": uuid.uuid4(), "project_id": uuid.UUID(a), "parent": uuid.UUID(parent_claim)},
    )

    async with harness.sm() as session:
        chunks = await session.execute(
            text("SELECT count(*) FROM chunks WHERE project_id = :a"), {"a": uuid.UUID(a)}
        )
        corrections = await session.execute(
            text("SELECT count(*) FROM corrections WHERE project_id = :a"), {"a": uuid.UUID(a)}
        )
    assert chunks.scalar() == 1 and corrections.scalar() == 1


async def test_cross_project_entity_merge_proposal_is_rejected(
    build_harness: Callable[..., Harness],
) -> None:
    """R17 — a two-parent relation (range 614-642): BOTH entity references must stay in-project.

    A merge proposal is the highest-value target of this class of defect: applying one rewrites
    entity identity, so a proposal whose duplicate lives in another project would merge one
    tenant's entity into another's.
    """
    harness = build_harness()
    a, b = await _two_projects(harness)
    canonical_in_a = await _entity(harness, a, unique_slug("Acme"))
    duplicate_in_b = await _entity(harness, b, unique_slug("Globex"))

    with pytest.raises(IntegrityError):
        await _insert_raw(
            harness,
            "INSERT INTO entity_merge_proposals "
            "(id, project_id, canonical_entity_id, duplicate_entity_id, method, status) "
            "VALUES (:id, :project_id, :canonical, :duplicate, 'deterministic', 'needs_review')",
            {
                "id": uuid.uuid4(),
                "project_id": uuid.UUID(a),
                "canonical": uuid.UUID(canonical_in_a),
                "duplicate": uuid.UUID(duplicate_in_b),
            },
        )

    async with harness.sm() as session:
        persisted = await session.execute(
            text("SELECT count(*) FROM entity_merge_proposals WHERE project_id = :a"),
            {"a": uuid.UUID(a)},
        )
    assert persisted.scalar() == 0, "a merge proposal spanning two projects was persisted"
