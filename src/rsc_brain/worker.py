"""Procrastinate worker entrypoint (SPEC-18): ``python -m rsc_brain.worker``.

The production compose runs this as the ``worker`` service — a stateless process (12-factor) that
drains the ``ingest`` queue. It reads the same ``RSC_BRAIN_DATABASE__DSN`` as the API and shares
the schema created by ``brain migrate`` (no separate queue migration).
"""

from __future__ import annotations

import asyncio

from rsc_brain.ingest.queue import INGEST_QUEUE, build_queue


async def _run() -> None:  # pragma: no cover - long-running worker loop (needs a live queue)
    queue = build_queue()
    async with queue.app.open_async():
        await queue.app.run_worker_async(queues=[INGEST_QUEUE])


def main() -> None:  # pragma: no cover - process entrypoint
    asyncio.run(_run())


if __name__ == "__main__":  # pragma: no cover
    main()
