"""FastAPI ingestion API (FR-1.1 multipart upload, FR-1.12 runs, D13 approve/reject).

Authentication is a Bearer PAT resolved to a :class:`~rsc_brain.scope.ProjectScope` by the SPEC-04
resolver (scope comes only from the token, never from the client). Endpoints under
``/projects/{slug}`` additionally require the token's project to match the slug; a mismatch — like
a missing project — returns 404, so *denied and nonexistent are indistinguishable* (FR-4.3).

The API mirrors the CLI (parity, §4.10.3). Heavy dependencies (engine, gateway) live on
``app.state`` for the app's lifetime; tests inject a container sessionmaker + a fake gateway.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import Session
from sqlalchemy.orm import sessionmaker as SyncSessionmaker
from starlette.responses import Response

from rsc_brain import __version__
from rsc_brain.api.authz import decide_document
from rsc_brain.authorization import Allow, Capability, decide
from rsc_brain.config.models import HuntingConfig, IngressConfig, RecallConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.ingest.pipeline import DocumentNotFoundError, IngestionPipeline, PipelineConfig
from rsc_brain.ingest.service import IngestService
from rsc_brain.mcp.server import build_mcp_server, normalize_mcp_security_headers
from rsc_brain.ontology.ingest import OntologyIngest
from rsc_brain.ontology.recall import OntologyRecall
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import CrossProjectScopeError, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.ingest_repository import IngestRepository

_bearer = HTTPBearer(auto_error=False)


@dataclass(slots=True)
class ApiDeps:
    sessionmaker: async_sessionmaker[AsyncSession]
    gateway: ModelGateway
    data_dir: str = "data"
    config: PipelineConfig | None = None
    recall_config: RecallConfig | None = None
    # Sync sessionmaker for the Authlib OAuth server (SPEC-10) — Authlib is synchronous, so its
    # callbacks run over a sync session inside a threadpool. None until OAuth is configured.
    sync_sessionmaker: SyncSessionmaker[Session] | None = None
    # How the service is reached from outside (AUDIT-038 / R51): the advertised origin and which
    # proxies may influence it. None means nothing about the request is trusted.
    ingress: IngressConfig | None = None

    # R37: set in production so an accepted upload is queued rather than processed on the request
    # thread. Left None by tests and the CLI, where a synchronous ingest is the point.
    queue: object | None = None

    # R28: how hunts reach a person. None means no channel is configured, and an opened hunt is then
    # reported as undelivered rather than as awaiting an answer nobody was asked for.
    hunting: HuntingConfig | None = None

    def service(self) -> tuple[IngestService, IngestRepository]:
        from rsc_brain.knowledge.contradictions import ContradictionResolver
        from rsc_brain.knowledge.judge import LlmJudge
        from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

        repo = IngestRepository(self.sessionmaker)
        graph = AgeGraphStore(self.sessionmaker)
        pipeline = IngestionPipeline(
            repository=repo,
            graph_store=graph,
            gateway=self.gateway,
            config=self.config or PipelineConfig(),
            # SPEC-24: the ontology layer is always constructed but stays inert per project until
            # that project sets ontology.enabled=true, so a standard install pays nothing for it.
            ontology=OntologyIngest(self.sessionmaker),
            # R18: contradiction detection was opt-in and nothing opted in, so it ran in tests that
            # injected a resolver and nowhere else.
            contradiction_resolver=ContradictionResolver(
                store=KnowledgeStore(self.sessionmaker),
                graph=graph,
                judge=LlmJudge(self.gateway),
            ),
        )
        return (
            IngestService(repo, pipeline, data_dir=self.data_dir, queue=self.queue),  # type: ignore[arg-type]
            repo,
        )

    def retriever(self) -> PgRetriever:
        return PgRetriever(
            sessionmaker=self.sessionmaker,
            gateway=self.gateway,
            graph_store=AgeGraphStore(self.sessionmaker),
            config=self.recall_config or RecallConfig(),
            ontology=OntologyRecall(self.sessionmaker),
        )


def _deps_from_config() -> tuple[ApiDeps, AsyncEngine]:
    """Build the API's dependencies from the SHARED runtime factory (AUDIT-044 / R53).

    The API used to assemble its own graph here and the worker assembled a different one in
    ``ingest/queue.py`` — the API's gateway had a usage recorder and an embedding cache, the worker's
    had neither. Both roles now come from :func:`rsc_brain.runtime.build`, so accounting, caching,
    limits and ontology cannot differ by which process picked the job up.
    """
    from rsc_brain import runtime
    from rsc_brain.ingest.queue import build_queue
    from rsc_brain.stores.relational.database import make_sync_engine, make_sync_sessionmaker

    dependencies = runtime.build("api")
    deps = ApiDeps(
        sessionmaker=dependencies.sessionmaker,
        gateway=dependencies.gateway,
        data_dir=dependencies.data_dir,
        config=dependencies.pipeline_config,
        recall_config=dependencies.recall_config,
        sync_sessionmaker=make_sync_sessionmaker(make_sync_engine()),
        ingress=dependencies.ingress,
        hunting=dependencies.hunting,
        # R37: heavy ingestion work is deferred to the worker; the request returns once the document,
        # its run checkpoint and the queue entry are durable.
        queue=build_queue(),
    )
    return deps, dependencies.engine


def create_app(*, deps: ApiDeps | None = None) -> FastAPI:
    """Build the combined REST + MCP app. Pass ``deps`` to inject stores/gateway (tests); omit to
    build them from configuration. The FastMCP streamable-HTTP server is mounted at ``/mcp`` in
    the same ASGI app (one process/port), and its session manager runs under the app lifespan."""
    engine: AsyncEngine | None = None
    if deps is None:
        deps, engine = _deps_from_config()
    mcp_server = build_mcp_server(
        sessionmaker=deps.sessionmaker,
        retriever=deps.retriever(),
        gateway=deps.gateway,
        public_origin=deps.ingress.public_origin if deps.ingress else None,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.deps = deps
        async with mcp_server.session_manager.run():
            try:
                yield
            finally:
                if engine is not None:
                    await engine.dispose()

    from rsc_brain.observability.logging_setup import configure_logging, trace_middleware
    from rsc_brain.observability.metrics import render_metrics

    configure_logging()
    app = FastAPI(title="rsc-brain", version=__version__, lifespan=lifespan)
    app.middleware("http")(trace_middleware)  # bind trace_id per request (SPEC-23, FR-14.3)

    @app.get("/metrics", include_in_schema=False)
    async def metrics(
        request: Request,
        credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    ) -> Response:
        """Prometheus scrape endpoint (SPEC-23, NFR-6) — not part of the typed admin contract.

        R10: the operational scrape is an OPERATOR surface. It used to have no authorization
        dependency at all, so an anonymous caller read company-wide activity. It now requires the
        named operator capability, and no project role satisfies it — a project administrator is not
        an operator. The operator credential itself arrives with the runtime contract (T008); until
        then this endpoint has no authorized caller, which is the safe state.
        """
        if credentials is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token"
            )
        scope = await resolve_scope(_deps(request).sessionmaker, credentials.credentials)
        if scope is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
        decision = decide(scope, Capability.OPERATOR_METRICS_READ)
        if not isinstance(decision, Allow):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="operator credential required"
            )
        body, content_type = await render_metrics(app.state.deps.sessionmaker)
        return Response(content=body, media_type=content_type)

    # Set eagerly too, so a test harness (ASGITransport) that does not run the lifespan still has
    # the injected stores available for the REST endpoints.
    app.state.deps = deps
    _register_routes(app)
    from rsc_brain.api.admin import router as admin_router
    from rsc_brain.api.console import auth_router, me_router

    # R28: the hunt reply path. Built here from configuration (channel + the install's own origin)
    # so the link a message carries and the route that serves it are the same install's.
    from rsc_brain.api.hunt import router as hunt_router
    from rsc_brain.hunting.factory import build_hunt_service

    hunting = deps.hunting
    app.state.hunts = build_hunt_service(
        deps.sessionmaker,
        channel=hunting.channel if hunting else None,
        smtp=hunting.smtp.model_dump() if hunting and hunting.smtp else None,
        slack=hunting.slack.model_dump() if hunting and hunting.slack else None,
        public_origin=deps.ingress.public_origin if deps.ingress else None,
        gateway=deps.gateway,
    )
    app.include_router(hunt_router)
    app.include_router(admin_router)
    app.include_router(auth_router)
    app.include_router(me_router)
    from rsc_brain.api.oauth.routes import router as oauth_router

    app.include_router(oauth_router)
    app.mount("/", normalize_mcp_security_headers(mcp_server.streamable_http_app()))
    return app


def _deps(request: Request) -> ApiDeps:
    deps: ApiDeps = request.app.state.deps
    return deps


async def _scope(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> ProjectScope:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    scope = await resolve_scope(_deps(request).sessionmaker, credentials.credentials)
    if scope is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    return scope


async def _scope_for_slug(slug: str, request: Request, scope: ProjectScope) -> ProjectScope:
    async with _deps(request).sessionmaker() as session:
        project_id = await session.scalar(
            select(models.Project.id).where(models.Project.slug == slug)
        )
    # Missing project and wrong-project token are both 404 (denied ≡ absent, FR-4.3).
    if project_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    try:
        scope.require(str(project_id))
    except CrossProjectScopeError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found") from exc
    return scope


def _register_routes(app: FastAPI) -> None:
    @app.post("/api/v1/projects/{slug}/documents", status_code=status.HTTP_202_ACCEPTED)
    async def upload_document(
        slug: str,
        request: Request,
        file: UploadFile = File(...),
        source: str | None = Form(default=None),
        scope: ProjectScope = Depends(_scope),
    ) -> dict[str, object]:
        scope = await _scope_for_slug(slug, request, scope)
        service, _ = _deps(request).service()
        data = await file.read()
        outcome = await service.ingest_bytes(
            scope, data, filename=file.filename or "upload.bin", source=source
        )
        return {
            "document_id": outcome.document_id,
            "status": outcome.status,
            "duplicate": outcome.duplicate,
        }

    @app.get("/api/v1/ingest/runs")
    async def list_runs(
        request: Request, scope: ProjectScope = Depends(_scope)
    ) -> dict[str, object]:
        _, repo = _deps(request).service()
        runs = await repo.list_run_statuses(scope)
        return {
            "runs": [
                {
                    "document_id": r.document_id,
                    "phase": r.phase,
                    "completed_stages": list(r.completed_stages),
                    "chunks_created": r.chunks_created,
                    "claims_generated": r.claims_generated,
                    "tables_converted": r.tables_converted,
                    "tables_needs_review": r.tables_needs_review,
                    "discarded_chunks": r.discarded_chunks,
                    "error": r.error,
                }
                for r in runs
            ]
        }

    @app.post("/api/v1/documents/{document_id}/approve")
    async def approve_document(
        document_id: str,
        request: Request,
        scope: ProjectScope = Depends(_scope),
        tags: list[str] | None = None,
    ) -> dict[str, object]:
        """Approve a pending document (D13).

        R02: this route had **no capability check whatsoever** — a valid project token of any role
        published documents and retagged them. It now takes the same document-lifecycle decision as
        its console sibling, from the same shared policy, so the two entry points cannot diverge
        again.
        """
        await decide_document(_deps(request).sessionmaker, scope, document_id, extra_tags=tags)
        service, _ = _deps(request).service()
        try:
            run = await service.approve(scope, document_id, tags=tags, approver=scope.principal_id)
        except DocumentNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found") from exc
        return {"document_id": document_id, "phase": run.phase, "claims": run.claims_generated}

    @app.post("/api/v1/documents/{document_id}/reject")
    async def reject_document(
        document_id: str,
        request: Request,
        reason: str = Form(...),
        scope: ProjectScope = Depends(_scope),
    ) -> dict[str, object]:
        """Reject a pending document (D13) — same authority as approving it (R02)."""
        await decide_document(_deps(request).sessionmaker, scope, document_id)
        service, _ = _deps(request).service()
        try:
            run = await service.reject(scope, document_id, reason=reason)
        except DocumentNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found") from exc
        return {"document_id": document_id, "phase": run.phase}
