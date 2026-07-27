"""The embedding cache is private to its project (AUDIT-022, F-025).

The cache identifies entries by a digest of the text plus model characteristics, with no project
dimension at any read, write or reuse boundary. That makes it a **cross-tenant confirmation oracle**, and
the channel is not timing — it is the asking project's own usage counter: a string another project already
embedded costs nothing, a new one costs a provider call.

Measured before writing these checks: `delta = 0` for a string project A had embedded, `delta = 1` for one
nobody had. The cache is attached unconditionally in ``runtime.build()`` and no configuration disables or
scopes it, so the property fails in every install.

The spec's ratified resolution is strict per-project isolation: an entry belongs to one project. Reuse —
which is what FR-9.6 wanted — still happens *within* a project, which is where text actually repeats
(re-ingests, document versions, one corpus's boilerplate).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


def _capabilities() -> CapabilitiesConfig:
    base = {
        name: CapabilityConfig(provider="test", model="m")
        for name in ("extractor", "judge", "topicalizer", "reranker")
    }
    base["embedder"] = CapabilityConfig(provider="test", model="bge-m3")
    return CapabilitiesConfig(**base)


async def _embedding(**kwargs: object) -> object:
    texts = list(kwargs["input"])  # type: ignore[index]
    return SimpleNamespace(data=[{"embedding": [0.1] * 1024} for _ in texts])


async def _two_projects(sessionmaker: object) -> tuple[str, str]:
    async with sessionmaker() as session:  # type: ignore[operator]
        a = models.Project(slug=f"a-{uuid.uuid4().hex[:8]}", name="A")
        b = models.Project(slug=f"b-{uuid.uuid4().hex[:8]}", name="B")
        session.add_all([a, b])
        await session.flush()
        ids = (str(a.id), str(b.id))
        await session.commit()
    return ids


async def _usage(sessionmaker: object, project: str) -> int:
    async with sessionmaker() as session:  # type: ignore[operator]
        total = await session.scalar(
            select(func.coalesce(func.sum(models.TokenUsage.tokens), 0)).where(
                models.TokenUsage.project_id == uuid.UUID(project),
                models.TokenUsage.capability == "embedder",
            )
        )
    return int(total or 0)


def _gateway(sessionmaker: object) -> object:
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.gateway.usage import PgEmbeddingCache, PgUsageRecorder

    caps = _capabilities()
    return ModelGateway(
        caps,
        embedding_fn=_embedding,
        usage_recorder=PgUsageRecorder(sessionmaker, caps),  # type: ignore[arg-type]
        embedding_cache=PgEmbeddingCache(sessionmaker),  # type: ignore[arg-type]
    )


async def test_a_project_cannot_confirm_another_projects_text_through_its_own_usage(
    migrated_dsn: str,
) -> None:
    """The measured oracle: B's own bill distinguishes A's content from an unseen string.

    Asserted on the usage counter rather than on timing because the usage channel is deterministic — it
    either records a provider call or it does not — and because it is the channel a tenant can read
    directly, from its own reports, with no measurement apparatus at all.
    """
    secret = f"Ana Ruiz earns {uuid.uuid4().hex[:8]} euros."
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        project_a, project_b = await _two_projects(sessionmaker)
        gateway = _gateway(sessionmaker)

        before = await _usage(sessionmaker, project_b)
        await gateway.for_project(project_b).embed([f"control {uuid.uuid4().hex}"])  # type: ignore[attr-defined]
        control_delta = await _usage(sessionmaker, project_b) - before

        await gateway.for_project(project_a).embed([secret])  # type: ignore[attr-defined]

        before = await _usage(sessionmaker, project_b)
        await gateway.for_project(project_b).embed([secret])  # type: ignore[attr-defined]
        probe_delta = await _usage(sessionmaker, project_b) - before
    finally:
        await engine.dispose()

    assert probe_delta == control_delta, (
        f"project B's own usage counter distinguishes a string project A embedded (delta {probe_delta}) "
        f"from one nobody embedded (delta {control_delta}): a cross-tenant confirmation oracle"
    )


async def test_a_cache_entry_belongs_to_exactly_one_project(migrated_dsn: str) -> None:
    """An entry with no owner cannot be erased correctly, and the spec says so.

    Without a project dimension the system cannot tell which derived vectors belong solely to an erased
    project: keeping them retains derived private data, and deleting by guessed digest removes another
    project's live data. The remediation shipped in 0.12.1 does the latter — it deletes by global hash, so
    erasing in one project evicts another's cached copy.
    """
    text = f"The SLA is {uuid.uuid4().hex[:6]} hours."
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        project_a, project_b = await _two_projects(sessionmaker)
        gateway = _gateway(sessionmaker)
        await gateway.for_project(project_a).embed([text])  # type: ignore[attr-defined]
        await gateway.for_project(project_b).embed([text])  # type: ignore[attr-defined]

        async with sessionmaker() as session:
            owners = list(
                await session.scalars(
                    select(models.EmbeddingCache.project_id).where(
                        models.EmbeddingCache.model == "bge-m3"
                    )
                )
            )
    finally:
        await engine.dispose()

    assert {str(o) for o in owners if o} >= {project_a, project_b}, (
        "the same text embedded by two projects did not produce an entry owned by each: the cache has no "
        f"project dimension, so no entry is attributable (owners={owners})"
    )


async def test_erasing_one_project_leaves_the_other_projects_cache_intact(
    migrated_dsn: str,
) -> None:
    """Erasure must be complete for the erased project and invisible to the others.

    Today deletion happens by global digest, so a shared string disappears for everyone — the spec's
    "shared-value path" says the opposite: deleting one project's association cannot delete another's data.
    """
    from rsc_brain.knowledge.gdpr import hard_delete_project
    from rsc_brain.scope import Principal, PrincipalType

    text = f"Shared boilerplate {uuid.uuid4().hex[:6]}."
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        project_a, project_b = await _two_projects(sessionmaker)
        gateway = _gateway(sessionmaker)
        await gateway.for_project(project_a).embed([text])  # type: ignore[attr-defined]
        await gateway.for_project(project_b).embed([text])  # type: ignore[attr-defined]

        scope_a = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(project_a)
        await hard_delete_project(sessionmaker, scope_a)

        # B must still be served from cache: its own usage must not move for that text.
        before = await _usage(sessionmaker, project_b)
        await gateway.for_project(project_b).embed([text])  # type: ignore[attr-defined]
        delta = await _usage(sessionmaker, project_b) - before

        async with sessionmaker() as session:
            remaining_for_a = await session.scalar(
                select(func.count())
                .select_from(models.EmbeddingCache)
                .where(models.EmbeddingCache.project_id == uuid.UUID(project_a))
            )
    finally:
        await engine.dispose()

    assert remaining_for_a == 0, f"the deleted project still owns {remaining_for_a} cache entries"
    assert delta == 0, (
        "erasing project A evicted project B's cached copy of a string B had embedded itself, so one "
        "tenant's erasure request degraded another tenant"
    )


async def test_an_identifier_learned_from_another_project_reads_as_absent(
    migrated_dsn: str,
) -> None:
    """A caller for B holding A's identifier must get exactly what absence looks like.

    This is FR-4.3's indistinguishability applied to the cache: not an error, not a refusal — nothing.
    """
    from rsc_brain.gateway.usage import PgEmbeddingCache, text_hash

    text = f"Private to A {uuid.uuid4().hex[:6]}."
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        project_a, project_b = await _two_projects(sessionmaker)
        cache = PgEmbeddingCache(sessionmaker)
        await cache.put_many(
            "bge-m3", 1024, {text_hash(text): [0.3] * 1024}, project_id=project_a
        )

        leaked = text_hash(text)
        as_b = await cache.get_many("bge-m3", 1024, [leaked], project_id=project_b)
        as_a = await cache.get_many("bge-m3", 1024, [leaked], project_id=project_a)
    finally:
        await engine.dispose()

    assert as_b == {}, "project B read a cache entry written by project A using A's identifier"
    assert as_a, "project A cannot read back its own entry — the isolation broke reuse entirely"
