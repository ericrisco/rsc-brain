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

from rsc_brain.config.models import RecallConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.ingest.pipeline import DocumentNotFoundError, IngestionPipeline, PipelineConfig
from rsc_brain.ingest.service import IngestService
from rsc_brain.mcp.server import build_mcp_server
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

    def service(self) -> tuple[IngestService, IngestRepository]:
        repo = IngestRepository(self.sessionmaker)
        pipeline = IngestionPipeline(
            repository=repo,
            graph_store=AgeGraphStore(self.sessionmaker),
            gateway=self.gateway,
            config=self.config or PipelineConfig(),
        )
        return IngestService(repo, pipeline, data_dir=self.data_dir), repo

    def retriever(self) -> PgRetriever:
        return PgRetriever(
            sessionmaker=self.sessionmaker,
            gateway=self.gateway,
            graph_store=AgeGraphStore(self.sessionmaker),
            config=self.recall_config or RecallConfig(),
        )


def _deps_from_config() -> tuple[ApiDeps, AsyncEngine]:
    from rsc_brain.config import load_settings
    from rsc_brain.gateway.usage import PgEmbeddingCache, PgUsageRecorder
    from rsc_brain.stores.relational.database import (
        make_engine,
        make_sessionmaker,
        make_sync_engine,
        make_sync_sessionmaker,
    )

    settings = load_settings()
    engine = make_engine()
    sessionmaker = make_sessionmaker(engine)
    deps = ApiDeps(
        sessionmaker=sessionmaker,
        # SPEC-22 (FR-9.5/9.6): enforce daily token budgets + reuse cached embeddings in the
        # running service (the gateway works without these; they're wired here for production).
        gateway=ModelGateway(
            settings.capabilities,
            usage_recorder=PgUsageRecorder(sessionmaker, settings.capabilities),
            embedding_cache=PgEmbeddingCache(sessionmaker),
        ),
        data_dir=settings.ingest.data_dir,
        config=PipelineConfig(
            hardware_profile=settings.hardware_profile,
            sensitivity_threshold=settings.ingest.sensitivity_threshold,
            default_tag=settings.ingest.default_tag,
        ),
        recall_config=settings.recall,
        sync_sessionmaker=make_sync_sessionmaker(make_sync_engine()),
    )
    return deps, engine


def create_app(*, deps: ApiDeps | None = None) -> FastAPI:
    """Build the combined REST + MCP app. Pass ``deps`` to inject stores/gateway (tests); omit to
    build them from configuration. The FastMCP streamable-HTTP server is mounted at ``/mcp`` in
    the same ASGI app (one process/port), and its session manager runs under the app lifespan."""
    engine: AsyncEngine | None = None
    if deps is None:
        deps, engine = _deps_from_config()
    mcp_server = build_mcp_server(
        sessionmaker=deps.sessionmaker, retriever=deps.retriever(), gateway=deps.gateway
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

    app = FastAPI(title="rsc-brain", version="0.1.0", lifespan=lifespan)
    # Set eagerly too, so a test harness (ASGITransport) that does not run the lifespan still has
    # the injected stores available for the REST endpoints.
    app.state.deps = deps
    _register_routes(app)
    from rsc_brain.api.admin import router as admin_router
    from rsc_brain.api.console import auth_router, me_router

    app.include_router(admin_router)
    app.include_router(auth_router)
    app.include_router(me_router)
    from rsc_brain.api.oauth.routes import router as oauth_router

    app.include_router(oauth_router)
    app.mount("/mcp", mcp_server.streamable_http_app())
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
        service, _ = _deps(request).service()
        try:
            run = await service.reject(scope, document_id, reason=reason)
        except DocumentNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found") from exc
        return {"document_id": document_id, "phase": run.phase}
