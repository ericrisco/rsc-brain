"""Permissions + multiproject isolation suite (SPEC-04 gate G2).

Seeds a synthetic 2-project dataset (SPEC-02's corpus is not built yet) and asserts: the FR-4.14
restrictive sensitive-tag rule, and hard cross-project isolation — no scope ever sees another
project's chunks. This runs against the service/store layer here and is re-run against the MCP
surface in SPEC-06 for the full gate.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from rsc_brain.identity.service import IdentityService
from rsc_brain.recall.permissions import chunk_visibility_clause, sensitive_tags
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.store import PgRelationalStore

pytestmark = pytest.mark.integration


def _scope(project_id: str, allowed: tuple[str, ...]) -> ProjectScope:
    return Principal(id="u", type=PrincipalType.HUMAN, allowed_topics=frozenset(allowed)).scope_for(
        project_id
    )


async def test_fr_4_14_sensitive_tag_requires_explicit_possession(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project = await svc.create_project("perm-proj", "Perm")
        await svc.create_topic(project, "general", "General", sensitivity=0)
        await svc.create_topic(project, "hr", "HR", sensitivity=3)

        repo = PgRelationalStore(sessionmaker).knowledge()
        seed = _scope(project, ("general", "hr"))
        doc = await repo.create_document(seed, logical_id="d", checksum="c")
        chunk_general = await repo.add_chunk(
            seed, document_id=doc.document_id, text="public note", tags=("general",)
        )
        chunk_hr = await repo.add_chunk(
            seed, document_id=doc.document_id, text="salary data", tags=("hr", "general")
        )

        sensitive = await sensitive_tags(sessionmaker, project)
        assert sensitive == frozenset({"hr"})

        # A general-only caller must NOT see the hr+general chunk (overlap on 'general' is not enough).
        general_only = _scope(project, ("general",))
        async with sessionmaker() as session:
            visible = {
                str(cid)
                for cid in await session.scalars(
                    select(models.Chunk.id).where(chunk_visibility_clause(general_only, sensitive))
                )
            }
        assert chunk_general in visible
        assert chunk_hr not in visible

        # A caller who owns 'hr' sees both.
        hr_user = _scope(project, ("general", "hr"))
        async with sessionmaker() as session:
            visible_hr = {
                str(cid)
                for cid in await session.scalars(
                    select(models.Chunk.id).where(chunk_visibility_clause(hr_user, sensitive))
                )
            }
        assert visible_hr == {chunk_general, chunk_hr}
    finally:
        await engine.dispose()


async def test_hard_cross_project_isolation(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project_a = await svc.create_project("iso-a", "A")
        project_b = await svc.create_project("iso-b", "B")
        repo = PgRelationalStore(sessionmaker).knowledge()
        scope_a, scope_b = _scope(project_a, ("general",)), _scope(project_b, ("general",))

        doc_a = await repo.create_document(scope_a, logical_id="d", checksum="c")
        await repo.add_chunk(scope_a, document_id=doc_a.document_id, text="a", tags=("general",))
        doc_b = await repo.create_document(scope_b, logical_id="d", checksum="c")
        await repo.add_chunk(scope_b, document_id=doc_b.document_id, text="b", tags=("general",))

        # A's visibility clause returns only A's chunk — never B's.
        async with sessionmaker() as session:
            a_projects = (
                await session.scalars(
                    select(models.Chunk.project_id).where(
                        chunk_visibility_clause(scope_a, frozenset())
                    )
                )
            ).all()
        assert len(a_projects) == 1
        assert all(str(pid) == project_a for pid in a_projects)
    finally:
        await engine.dispose()
