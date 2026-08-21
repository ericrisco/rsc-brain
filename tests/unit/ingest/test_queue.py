"""procrastinate wiring (FR-1.10): enqueue defers a job to the ingest queue with the right args.

Uses procrastinate's in-memory connector + an injected runner, so no Postgres is needed to prove
the task is registered and the enqueue path works (the pipeline itself is integration-tested)."""

from __future__ import annotations

from procrastinate.testing import InMemoryConnector

from rsc_brain.ingest.queue import (
    INGEST_QUEUE,
    INGEST_TASK,
    MAINTENANCE_QUEUE,
    STALE_NOTIFICATION_TASK,
    build_queue,
)


async def test_enqueue_defers_ingest_job() -> None:
    calls: list[tuple[str, str, str]] = []

    async def runner(document_id: str, project_id: str, principal_id: str) -> None:
        calls.append((document_id, project_id, principal_id))

    connector = InMemoryConnector()
    queue = build_queue(connector=connector, runner=runner)
    await queue.enqueue(document_id="doc-1", project_id="proj-1", principal_id="cli")

    jobs = list(connector.jobs.values())
    assert len(jobs) == 1
    job = jobs[0]
    assert job["task_name"] == INGEST_TASK
    assert job["queue_name"] == INGEST_QUEUE
    assert job["args"] == {
        "document_id": "doc-1",
        "project_id": "proj-1",
        "principal_id": "cli",
    }
    # Runner is wired but only invoked by a worker, not by defer.
    assert calls == []


async def test_stale_notification_delivery_is_a_periodic_maintenance_task() -> None:
    calls: list[int] = []

    async def notification_runner() -> None:
        calls.append(1)

    connector = InMemoryConnector()
    queue = build_queue(connector=connector, notification_runner=notification_runner)

    periodic = queue.app.periodic_registry.periodic_tasks[(STALE_NOTIFICATION_TASK, "")]
    assert periodic.cron == "*/1 * * * *"
    assert periodic.task.queue == MAINTENANCE_QUEUE
    # Registration does not perform an external delivery in the API/producer process.
    assert calls == []
