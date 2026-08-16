"""One place where the API and the worker are assembled (AUDIT-044 / R53).

Both processes run the same jobs, so they need the same collaborators — and they did not have them.
``ApiDeps`` built the gateway with a usage recorder and an embedding cache; the worker's runner built
``ModelGateway(settings.capabilities)`` with neither. A document ingested by the worker therefore
spent tokens nobody recorded, ignored the daily budget, and re-embedded text the API would have reused
from the cache. Nothing was wrong with either line of code; there were simply two of them.

So the dependency graph is built here, once, and the entry points differ only in what they do with it.
``role`` is carried for logging and for the few genuinely role-specific decisions (a worker does not
listen on a port), never to vary policy: if a future change makes one role's accounting or limits
different, it has to say so here rather than by omission somewhere else.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from rsc_brain.config.models import HuntingConfig, IngressConfig, PublicLimits, RecallConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.pipeline import PipelineConfig

Role = Literal["api", "worker"]


@dataclass(slots=True)
class RuntimeDependencies:
    """Everything a process needs to execute product work, identical for every role."""

    role: Role
    engine: AsyncEngine
    sessionmaker: async_sessionmaker[AsyncSession]
    gateway: ModelGateway
    pipeline_config: PipelineConfig
    recall_config: RecallConfig
    limits: PublicLimits
    ingress: IngressConfig
    hunting: HuntingConfig
    reranker_enabled: bool
    data_dir: str

    async def dispose(self) -> None:
        """Release the engine. Both entry points own their process's lifetime, not this module's."""
        await self.engine.dispose()


def build_pipeline(dependencies: RuntimeDependencies) -> object:
    """The ingestion pipeline as production must run it, contradiction detection included (R18).

    ``_detect_contradictions_on_ingest`` is a no-op when no resolver was injected, and no composition
    root injected one — so detection ran in tests that passed a resolver and nowhere else. Building the
    pipeline here means neither entry point can forget it, for the same reason the gateway's
    collaborators live in one place.
    """
    from rsc_brain.ingest.pipeline import IngestionPipeline
    from rsc_brain.knowledge.contradictions import ContradictionResolver
    from rsc_brain.knowledge.judge import LlmJudge
    from rsc_brain.ontology.ingest import OntologyIngest
    from rsc_brain.stores.age_graph_store import AgeGraphStore
    from rsc_brain.stores.relational.ingest_repository import IngestRepository
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    sessionmaker = dependencies.sessionmaker
    graph = AgeGraphStore(sessionmaker)
    return IngestionPipeline(
        repository=IngestRepository(sessionmaker),
        graph_store=graph,
        gateway=dependencies.gateway,
        config=dependencies.pipeline_config,
        ontology=OntologyIngest(sessionmaker),
        contradiction_resolver=ContradictionResolver(
            store=KnowledgeStore(sessionmaker),
            graph=graph,
            judge=LlmJudge(dependencies.gateway),
        ),
    )


def build(role: Role) -> RuntimeDependencies:
    """Assemble the runtime for ``role`` from configuration.

    Every collaborator that affects an outcome — accounting, cache, ontology, limits, storage — is set
    here for both roles. That is the property R53 asks for: not that two graphs happen to match today,
    but that there is only one graph to match.
    """
    from rsc_brain.config import load_settings
    from rsc_brain.gateway.usage import PgEmbeddingCache, PgUsageRecorder
    from rsc_brain.ontology.ingest import OntologyIngest
    from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

    settings = load_settings()
    engine = make_engine()
    sessionmaker = make_sessionmaker(engine)
    del OntologyIngest  # constructed per operation from the sessionmaker; listed for the reader
    return RuntimeDependencies(
        role=role,
        engine=engine,
        sessionmaker=sessionmaker,
        gateway=ModelGateway(
            settings.capabilities,
            # SPEC-22 / R12: the recorder is project-bound per operation via
            # `ModelGateway.for_project`; what matters here is that BOTH roles have one at all.
            usage_recorder=PgUsageRecorder(sessionmaker, settings.capabilities),
            embedding_cache=PgEmbeddingCache(sessionmaker),
        ),
        pipeline_config=PipelineConfig(
            hardware_profile=settings.hardware_profile,
            sensitivity_threshold=settings.ingest.sensitivity_threshold,
            default_tag=settings.ingest.default_tag,
        ),
        recall_config=settings.recall,
        # spec `reranked-abstention`: one place decides it, so the API and the worker
        # can never disagree about whether abstention is reranked (R53).
        reranker_enabled=settings.reranker.enabled,
        limits=settings.limits,
        ingress=settings.ingress,
        hunting=settings.hunting,
        data_dir=settings.ingest.data_dir,
    )
