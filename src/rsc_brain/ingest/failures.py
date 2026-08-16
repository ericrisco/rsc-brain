"""AUDIT-088: one place that turns an ingestion crash into something the product can say.

`record_run_error` already existed, and its docstring already named the readers that must not be
left in the dark — "the console, a worker-driven ingest, anyone looking a week later". What did not
exist was a single call site both ingestion paths share. The inline path wrapped the pipeline; the
**queued** path returned before that wrapper and nothing downstream wrapped it again. Production
always runs with a queue, so the guard was never in force where documents actually flow.

Keeping the message here means the two paths cannot drift, and a third path added later has one
obvious thing to call.
"""

from __future__ import annotations

import logging
from typing import Protocol

from rsc_brain.scope import ProjectScope

_LOG = logging.getLogger(__name__)
_MAX = 1000


class _RecordsRunErrors(Protocol):
    async def record_run_error(self, scope: ProjectScope, document_id: str, error: str) -> None: ...


def describe_failure(exc: BaseException) -> str:
    """The durable sentence a run carries after a crash.

    Names the exception type as well as its text: `ConversionError` and `TimeoutError` need
    different operator responses, and several of the failures seen on a real host — a zero-byte
    upload, a truncated transfer, a ZIP wearing a .pdf extension — produce messages that read alike
    until the type separates them.
    """
    return f"ingestion failed before completing: {type(exc).__name__}: {exc}"[:_MAX]


async def record_ingestion_failure(
    repository: _RecordsRunErrors,
    scope: ProjectScope,
    document_id: str,
    exc: BaseException,
) -> None:
    """Write the failure onto the run. Never raises — the original exception must survive.

    A guard that can itself fail would replace a recorded crash with an unrecorded one, which is
    the defect this exists to close. It is logged rather than swallowed: silence here would repeat
    the sin at one remove, since the whole point is that a failure must leave a trace somewhere a
    person can find.
    """
    try:
        await repository.record_run_error(scope, document_id, describe_failure(exc))
    except Exception:  # pragma: no cover - defensive; the original failure is what matters
        _LOG.exception(
            "could not record the ingestion failure for document %s; the original error was: %s",
            document_id,
            describe_failure(exc),
        )
