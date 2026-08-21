"""procrastinate job queue for ingestion (FR-1.10) — Postgres-backed, no extra service.

A document is ingested as a queued job so CPU-heavy work runs in a worker, off the request path.
Because the pipeline is idempotent and checkpointed, procrastinate's at-least-once redelivery is
safe: a job that dies mid-run is retried and resumes from its last checkpoint. The queue's schema
is applied by ``brain migrate`` (Alembic migration 0003), not a separate step.

The runner is injectable so tests drive the wiring with procrastinate's in-memory connector,
while production rebuilds the stores + gateway from configuration.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from procrastinate import App
from procrastinate.connector import BaseConnector

from rsc_brain.stores.relational.database import resolve_dsn

INGEST_QUEUE = "ingest"
INGEST_TASK = "ingest_document"
MAINTENANCE_QUEUE = "maintenance"
STALE_NOTIFICATION_TASK = "deliver_stale_skill_notifications"

Runner = Callable[[str, str, str], Awaitable[None]]
NotificationRunner = Callable[[], Awaitable[None]]


def _psycopg_conninfo(dsn: str) -> str:
    """Convert the app's async SQLAlchemy DSN into a psycopg conninfo (procrastinate's driver)."""
    return dsn.replace("+asyncpg", "").replace("+psycopg", "")


@dataclass(slots=True)
class IngestQueue:
    """A configured procrastinate app plus the ingest task handle."""

    app: App
    _defer: Callable[..., Awaitable[object]]

    async def enqueue(self, *, document_id: str, project_id: str, principal_id: str) -> None:
        async with self.app.open_async():
            await self._defer(
                document_id=document_id, project_id=project_id, principal_id=principal_id
            )


def build_queue(
    *,
    connector: BaseConnector | None = None,
    dsn: str | None = None,
    runner: Runner | None = None,
    notification_runner: NotificationRunner | None = None,
) -> IngestQueue:
    """Build the ingest queue. Pass a connector (e.g. in-memory) + runner for tests; omit both to
    use the real Postgres connector + the config-backed runner."""
    if connector is None:
        from procrastinate import PsycopgConnector

        connector = PsycopgConnector(conninfo=_psycopg_conninfo(resolve_dsn(dsn)))
    app = App(connector=connector)
    active_runner = runner or _default_runner
    active_notification_runner = notification_runner or _default_notification_runner

    @app.task(name=INGEST_TASK, queue=INGEST_QUEUE)
    async def ingest_document(document_id: str, project_id: str, principal_id: str) -> None:
        await active_runner(document_id, project_id, principal_id)

    @app.periodic(cron="*/1 * * * *")
    @app.task(name=STALE_NOTIFICATION_TASK, queue=MAINTENANCE_QUEUE)
    async def deliver_stale_skill_notifications(timestamp: int) -> None:
        del timestamp  # Procrastinate's scheduled instant; the dispatcher owns its aware clock.
        await active_notification_runner()

    return IngestQueue(app=app, _defer=ingest_document.defer_async)


async def _default_runner(
    document_id: str, project_id: str, principal_id: str
) -> None:  # pragma: no cover - needs a live DB + models; exercised operationally
    """Run the pipeline for one document, with the SAME runtime the API would have used.

    R53: this used to build its own graph — `ModelGateway(settings.capabilities)` with no usage
    recorder and no embedding cache — so a document ingested here spent tokens nobody recorded,
    ignored the daily budget, and re-embedded text the API would have reused. Both roles now come from
    :func:`rsc_brain.runtime.build`.
    """
    from rsc_brain import runtime
    from rsc_brain.ingest.failures import record_ingestion_failure
    from rsc_brain.ingest.pipeline import IngestionPipeline
    from rsc_brain.ontology.ingest import OntologyIngest
    from rsc_brain.scope import Principal, PrincipalType
    from rsc_brain.stores.age_graph_store import AgeGraphStore
    from rsc_brain.stores.relational.ingest_repository import IngestRepository

    dependencies = runtime.build("worker")
    try:
        sessionmaker = dependencies.sessionmaker
        repository = IngestRepository(sessionmaker)
        pipeline = IngestionPipeline(
            repository=repository,
            graph_store=AgeGraphStore(sessionmaker),
            gateway=dependencies.gateway,
            config=dependencies.pipeline_config,
            ontology=OntologyIngest(sessionmaker),
        )
        scope = Principal(id=principal_id, type=PrincipalType.HUMAN, can_curate=True).scope_for(
            project_id
        )
        try:
            await pipeline.process(scope, document_id)
        except Exception as exc:
            # AUDIT-088: measured on a real host — three malformed PDFs (zero bytes, a truncated
            # transfer, a ZIP renamed to .pdf) raised ConversionError here, procrastinate marked the
            # jobs `failed` and exhausted them, and `GET /api/v1/ingest/runs` still reported
            # `phase: received, error: null` for all three. Indistinguishable from the documents
            # still sitting in `todo`. The queue knew; the product did not say.
            #
            # The exception is re-raised so the job still fails and the operator's queue metrics stay
            # true; what changes is that the run now carries the reason.
            await record_ingestion_failure(repository, scope, document_id, exc)
            raise
    finally:
        await dependencies.dispose()


async def _default_notification_runner() -> None:  # pragma: no cover - real DB/channel wiring
    """Drain durable stale notifications without constructing the model gateway."""
    from rsc_brain.config import load_settings
    from rsc_brain.hunting.factory import build_channel_from_config
    from rsc_brain.skills.staleness import SkillStaleNotificationDispatcher
    from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

    settings = load_settings()
    channel, can_deliver = build_channel_from_config(settings.hunting)
    engine = make_engine()
    try:
        await SkillStaleNotificationDispatcher(
            make_sessionmaker(engine), channel=channel, can_deliver=can_deliver
        ).deliver_due()
    finally:
        await engine.dispose()
