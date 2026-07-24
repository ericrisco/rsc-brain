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
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.ingest.pipeline import DocumentNotFoundError, IngestionPipeline, PipelineConfig
from rsc_brain.ingest.service import IngestService
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

    def service(self) -> tuple[IngestService, IngestRepository]:
        repo = IngestRepository(self.sessionmaker)
        pipeline = IngestionPipeline(
            repository=repo,
            graph_store=AgeGraphStore(self.sessionmaker),
            gateway=self.gateway,
            config=self.config or PipelineConfig(),
        )
        return IngestService(repo, pipeline, data_dir=self.data_dir), repo


def create_app(*, deps: ApiDeps | None = None) -> FastAPI:
    """Build the ingestion API. Pass ``deps`` to inject stores/gateway (tests); omit to build
    them from configuration at startup."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if deps is not None:
            app.state.deps = deps
            yield
            return
        from rsc_brain.config import load_settings
        from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

        settings = load_settings()
        engine = make_engine()
        app.state.deps = ApiDeps(
            sessionmaker=make_sessionmaker(engine),
            gateway=ModelGateway(settings.capabilities),
            data_dir=settings.ingest.data_dir,
            config=PipelineConfig(
                hardware_profile=settings.hardware_profile,
                sensitivity_threshold=settings.ingest.sensitivity_threshold,
                default_tag=settings.ingest.default_tag,
            ),
        )
        try:
            yield
        finally:
            await engine.dispose()

    app = FastAPI(title="rsc-brain ingestion API", version="0.1.0", lifespan=lifespan)
    if deps is not None:
        # Set eagerly too, so a test harness (ASGITransport) that does not run the lifespan still
        # has the injected stores available.
        app.state.deps = deps
    _register_routes(app)
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
