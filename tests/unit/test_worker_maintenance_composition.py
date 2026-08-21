"""The deployed worker must register and consume every periodic lifecycle task (AUDIT-108)."""

from __future__ import annotations

from procrastinate.testing import InMemoryConnector

from rsc_brain.ingest.queue import INGEST_QUEUE, build_queue
from rsc_brain.maintenance import (
    DAILY_MAINTENANCE_TASK,
    HUNTING_MAINTENANCE_TASK,
    MAINTENANCE_QUEUE,
)
from rsc_brain.worker import WORKER_QUEUES


async def test_production_app_registers_periodic_work_and_worker_consumes_it() -> None:
    async def ingest_runner(document_id: str, project_id: str, principal_id: str) -> None:
        del document_id, project_id, principal_id

    async def maintenance_runner(kind: str) -> None:
        del kind

    queue = build_queue(
        connector=InMemoryConnector(),
        runner=ingest_runner,
        maintenance_runner=maintenance_runner,
    )

    assert set(WORKER_QUEUES) == {INGEST_QUEUE, MAINTENANCE_QUEUE}
    assert {HUNTING_MAINTENANCE_TASK, DAILY_MAINTENANCE_TASK} <= set(queue.app.tasks)
    registered = queue.app.periodic_registry.periodic_tasks
    assert (HUNTING_MAINTENANCE_TASK, "hunting") in registered
    assert (DAILY_MAINTENANCE_TASK, "daily") in registered
    assert registered[(HUNTING_MAINTENANCE_TASK, "hunting")].task.queue == MAINTENANCE_QUEUE
    assert registered[(DAILY_MAINTENANCE_TASK, "daily")].task.queue == MAINTENANCE_QUEUE
    assert queue.app.tasks[HUNTING_MAINTENANCE_TASK].lock == HUNTING_MAINTENANCE_TASK
    assert queue.app.tasks[DAILY_MAINTENANCE_TASK].lock == DAILY_MAINTENANCE_TASK


async def test_periodic_task_failure_escapes_to_procrastinate() -> None:
    expected = RuntimeError("delivery unavailable")

    async def maintenance_runner(kind: str) -> None:
        del kind
        raise expected

    queue = build_queue(
        connector=InMemoryConnector(),
        maintenance_runner=maintenance_runner,
    )

    task = queue.app.tasks[HUNTING_MAINTENANCE_TASK]
    try:
        await task(1)
    except RuntimeError as exc:
        assert exc is expected
    else:  # pragma: no cover - the assertion above is the required product contract
        raise AssertionError("maintenance failure was reported as success")
