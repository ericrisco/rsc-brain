""" "Schema at head" must mean at head (T022 re-audit — R41, R49, R50).

Three places claim the schema is at head and check only that ``alembic_version`` has a row:

* ``brain wait-for-schema`` — the init container R49 added so the app waits for the migration. On a
  fresh install the table is empty until the Job stamps it, so it works. On an **upgrade** the row is
  already there from the previous version, so the gate passes instantly and api/worker start against the
  OLD schema while the migration is still running. That is R49's own failure, reintroduced on the path
  R49 was about.
* ``brain restore``'s verification — the gate R41 added, which is supposed to refuse a snapshot that is
  not restorable. A dump taken from an older schema passes it and is reported ready.
* ``brain verify`` — the container readiness probe, whose message says "schema at head". A pod one
  revision behind reports Ready and serves.

Asserted by stamping the database at an older revision — which is exactly what an in-progress upgrade
looks like — and asking each of them.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text

from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration

#: The first migration in the chain. Any revision that is not head will do; this one is stable.
BEHIND_REVISION = "9556a451b272"


@pytest.fixture
async def stamped_behind(migrated_dsn: str) -> AsyncIterator[str]:
    """Leave ``alembic_version`` pointing at the first revision, then put it back.

    A database mid-upgrade is stamped at the revision it has actually reached, not at head; that is the
    state every one of these gates has to distinguish from "ready".

    Async so the engine lives and dies in the test's own event loop — a sync fixture driving
    ``asyncio.run`` leaks the transport, and ``filterwarnings = error`` turns that into a failure
    somewhere unrelated. Both updates are scoped by the value they expect to replace: the table holds one
    row by design, and an unscoped UPDATE would hide the day that stops being true.
    """
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            real_head = str(await session.scalar(text("SELECT version_num FROM alembic_version")))
            await session.execute(
                text("UPDATE alembic_version SET version_num = :behind WHERE version_num = :head"),
                {"behind": BEHIND_REVISION, "head": real_head},
            )
            await session.commit()
        yield migrated_dsn
        async with sessionmaker() as session:
            await session.execute(
                text("UPDATE alembic_version SET version_num = :head WHERE version_num = :behind"),
                {"behind": BEHIND_REVISION, "head": real_head},
            )
            await session.commit()
    finally:
        await engine.dispose()


async def test_the_restore_gate_does_not_accept_a_database_that_is_behind(
    stamped_behind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``brain restore``'s post-restore check is what decides a restore succeeded (R41).

    Restoring a dump taken from an older schema leaves the database stamped behind, and this gate is the
    only thing standing between that and "restored and verified".
    """
    from rsc_brain.cli.data import _verify_database
    from rsc_brain.stores.relational.database import DSN_ENV_VAR

    monkeypatch.setenv(DSN_ENV_VAR, stamped_behind)

    assert await _verify_database() is False, (
        "the restore gate accepts a database stamped at an older revision, so a snapshot from a "
        "previous schema restores and is reported ready"
    )


async def test_waiting_for_the_schema_does_not_pass_on_an_older_revision(
    stamped_behind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The init container's whole job is to hold the app back until the migration finishes.

    Passing while the database is stamped behind means api and worker start against the old schema
    during every upgrade — the ordering failure R49 exists to prevent, on the path R49 was about.
    """
    from typer.testing import CliRunner

    from rsc_brain.cli.main import app
    from rsc_brain.stores.relational.database import DSN_ENV_VAR

    monkeypatch.setenv(DSN_ENV_VAR, stamped_behind)

    # In a thread: the command drives `asyncio.run`, which cannot start inside this test's running loop.
    result = await asyncio.to_thread(
        CliRunner().invoke, app, ["wait-for-schema", "--timeout", "3", "--json"]
    )

    assert result.exit_code == 1, (
        "wait-for-schema reported the schema ready while the database was stamped at an older "
        f"revision (exit={result.exit_code}, output={result.output.strip()[:200]})"
    )


async def test_readiness_does_not_report_a_database_that_is_behind(stamped_behind: str) -> None:
    """``brain verify`` is the readiness probe, and its message says "schema at head".

    A pod one revision behind answering Ready is a pod serving queries against a schema the code does
    not expect — the failure mode migrate-on-boot is supposed to make impossible.
    """
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.installer.verify import run_verify
    from tests.conftest import _fake_capabilities

    engine = make_engine(stamped_behind)
    try:
        report = await run_verify(
            gateway=ModelGateway(_fake_capabilities()),
            sessionmaker=make_sessionmaker(engine),
        )
    finally:
        await engine.dispose()

    database = next(check for check in report.checks if check.name == "database")
    assert not database.ok, (
        f"readiness reports the database healthy while it is behind head: {database.detail}"
    )


# --------------------------------------------------------------------------- #
# Erasure leaves the erased sentence's embedding in the global cache
# --------------------------------------------------------------------------- #


async def test_erasing_an_entity_also_removes_its_cached_embeddings(migrated_dsn: str) -> None:
    """The embedding cache keeps a vector for every text it has ever embedded.

    R43's ratified criterion is that no active embedding or graph derivative still exposes the erased
    content. The cache is keyed by SHA-256 of the text and holds the vector, so after an erasure the
    sentence's embedding is still there — and the hash still confirms the sentence was ingested at all,
    which is the question an erasure is supposed to make unanswerable.
    """
    import uuid as _uuid

    from rsc_brain.gateway.usage import PgEmbeddingCache, text_hash
    from rsc_brain.knowledge.gdpr import forget_entity
    from rsc_brain.scope import Principal, PrincipalType
    from rsc_brain.stores.relational import models as m

    sentence = f"Ana Ruiz owns payroll approvals {_uuid.uuid4().hex[:6]}."
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            project = m.Project(slug=f"cache-{_uuid.uuid4().hex[:8]}", name="Cache")
            session.add(project)
            await session.flush()
            project_id = str(project.id)
            session.add(
                m.Entity(
                    project_id=project.id,
                    name="Ana Ruiz",
                    normalized_name="ana ruiz",
                    type="person",
                )
            )
            session.add(m.Claim(project_id=project.id, text=sentence, tags=["hr"], credibility=0.9))
            await session.commit()
        cache = PgEmbeddingCache(sessionmaker)
        await cache.put_many("bge-m3", 1024, {text_hash(sentence): [0.1] * 1024})
        assert await cache.get_many("bge-m3", 1024, [text_hash(sentence)]), (
            "the cache did not store"
        )

        scope = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(project_id)
        await forget_entity(sessionmaker, scope, name="Ana Ruiz")

        remaining = await cache.get_many("bge-m3", 1024, [text_hash(sentence)])
    finally:
        await engine.dispose()

    assert not remaining, (
        "the erased sentence's embedding is still in the cache, so a derivative of the content survives "
        "and its hash still confirms the sentence was ingested"
    )


async def test_deleting_a_project_also_removes_its_cached_embeddings(migrated_dsn: str) -> None:
    """Same hole on the project-deletion path (R44 + R43's derivative rule).

    A deleted tenant's sentences kept a live vector in the global cache, and the hash still confirmed
    they had been ingested — after the project had been removed from every table.
    """
    import uuid as _uuid

    from rsc_brain.gateway.usage import PgEmbeddingCache, text_hash
    from rsc_brain.knowledge.gdpr import hard_delete_project
    from rsc_brain.scope import Principal, PrincipalType
    from rsc_brain.stores.relational import models as m

    sentence = f"The SLA is 48 hours {_uuid.uuid4().hex[:6]}."
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            project = m.Project(slug=f"wipe-{_uuid.uuid4().hex[:8]}", name="Wipe")
            session.add(project)
            await session.flush()
            project_id = str(project.id)
            document = m.Document(
                project_id=project.id,
                logical_id=_uuid.uuid4().hex,
                checksum=_uuid.uuid4().hex,
                status="processed",
            )
            session.add(document)
            await session.flush()
            session.add(
                m.Chunk(
                    project_id=project.id,
                    document_id=document.id,
                    kind="prose",
                    text=sentence,
                    tags=["hr"],
                    needs_review=False,
                )
            )
            await session.commit()
        cache = PgEmbeddingCache(sessionmaker)
        await cache.put_many("bge-m3", 1024, {text_hash(sentence): [0.2] * 1024})

        scope = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(project_id)
        await hard_delete_project(sessionmaker, scope)

        remaining = await cache.get_many("bge-m3", 1024, [text_hash(sentence)])
    finally:
        await engine.dispose()

    assert not remaining, (
        "a deleted project's sentences still have cached embeddings, so a derivative of a removed "
        "tenant's content survives in a store nobody scoped"
    )
