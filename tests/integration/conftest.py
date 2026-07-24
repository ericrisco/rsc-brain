"""Integration harness for the ingestion pipeline (SPEC-05): a builder over the real container.

Assembles the repository + AGE graph store + a fake-gatewayed pipeline + service against the
migrated testcontainer, plus helpers to set up projects/topics and to inspect what actually
reached the vector index and the graph — so the D13 gate and isolation are checked against real
Postgres+AGE+pgvector, not mocks.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.pipeline import IngestionPipeline, PipelineConfig, default_parser_factory
from rsc_brain.ingest.service import IngestService
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, graph_name
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.ingest_repository import IngestRepository


@dataclass(slots=True)
class Harness:
    sm: async_sessionmaker[AsyncSession]
    repo: IngestRepository
    pipeline: IngestionPipeline
    service: IngestService
    gateway: ModelGateway

    async def setup_project(
        self,
        slug: str,
        topics: Sequence[tuple[str, int]],
        *,
        rules: list[dict[str, str]] | None = None,
    ) -> str:
        async with self.sm() as session:
            project = models.Project(slug=slug, name=slug)
            session.add(project)
            await session.flush()
            for topic_slug, sensitivity in topics:
                session.add(
                    models.Topic(
                        project_id=project.id,
                        slug=topic_slug,
                        name=topic_slug,
                        sensitivity=sensitivity,
                    )
                )
            if rules is not None:
                project.settings = {"topic_rules": rules}
            await session.commit()
            return str(project.id)

    def scope(self, project_id: str, *, allowed_topics: Sequence[str] = ()) -> ProjectScope:
        return Principal(
            id="test",
            type=PrincipalType.HUMAN,
            allowed_topics=frozenset(allowed_topics),
            can_curate=True,
        ).scope_for(project_id)

    async def embedded_chunk_count(self, project_id: str) -> int:
        async with self.sm() as session:
            total = await session.scalar(
                select(func.count())
                .select_from(models.Chunk)
                .where(
                    models.Chunk.project_id == uuid.UUID(project_id),
                    models.Chunk.embedding.is_not(None),
                )
            )
            return int(total or 0)

    async def chunk_has_embedding(self, chunk_id: str) -> bool:
        async with self.sm() as session:
            embedding = await session.scalar(
                select(models.Chunk.embedding).where(models.Chunk.id == uuid.UUID(chunk_id))
            )
            return embedding is not None

    async def claim_count(self, project_id: str) -> int:
        async with self.sm() as session:
            total = await session.scalar(
                select(func.count())
                .select_from(models.Claim)
                .where(models.Claim.project_id == uuid.UUID(project_id))
            )
            return int(total or 0)

    async def graph_node_count(self, scope: ProjectScope) -> int:
        graph = graph_name(scope.project_id)
        async with self.sm() as session:
            await session.execute(text("LOAD 'age'"))
            await session.execute(text('SET search_path = ag_catalog, "$user", public'))
            exists = await session.scalar(
                text("SELECT count(*) FROM ag_catalog.ag_graph WHERE name = :n"), {"n": graph}
            )
            if not exists:
                return 0
        rows = await AgeGraphStore(self.sm).run_cypher(
            scope, "MATCH (n) RETURN count(n) AS result", {}
        )
        if not rows:
            return 0
        value = rows[0]["result"]
        return value if isinstance(value, int) else 0

    async def set_document_status(self, project_id: str, document_id: str, status: str) -> None:
        async with self.sm() as session:
            await session.execute(
                update(models.Document)
                .where(models.Document.id == uuid.UUID(document_id))
                .values(status=status)
            )
            await session.commit()


@pytest.fixture
async def build_harness(
    migrated_dsn: str,
    gateway_factory: Callable[..., ModelGateway],
    make_completion: Callable[..., object],
    tmp_path: Path,
) -> AsyncIterator[Callable[..., Harness]]:
    engines = []

    def _build(
        *,
        completion: object | None = None,
        parser_factory: object | None = None,
        config: PipelineConfig | None = None,
    ) -> Harness:
        engine = make_engine(migrated_dsn)
        engines.append(engine)
        sm = make_sessionmaker(engine)
        gateway = gateway_factory(completion=completion or make_completion())
        repo = IngestRepository(sm)
        pipeline = IngestionPipeline(
            repository=repo,
            graph_store=AgeGraphStore(sm),
            gateway=gateway,
            parser_factory=parser_factory or default_parser_factory,  # type: ignore[arg-type]
            config=config or PipelineConfig(),
        )
        service = IngestService(repo, pipeline, data_dir=tmp_path)
        return Harness(sm=sm, repo=repo, pipeline=pipeline, service=service, gateway=gateway)

    yield _build

    # Dispose in the test's own event loop, so asyncpg connections close cleanly (no dangling
    # sockets / ResourceWarnings, which `filterwarnings=error` would turn into failures).
    for engine in engines:
        await engine.dispose()


def unique_slug(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"
