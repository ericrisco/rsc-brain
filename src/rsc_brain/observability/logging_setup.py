"""Structured JSON logging + trace_id correlation (SPEC-23, E11.1 / FR-14.3).

``configure_logging`` renders every log as one JSON line (bridging stdlib logging so uvicorn /
procrastinate / libraries emit the same shape). ``trace_middleware`` binds a per-request
``trace_id`` (taken from the ``X-Trace-Id`` header — so an agent can pass its own — or generated)
into the structlog context, so every log emitted while handling the request carries it, and echoes
it on the response so a caller can correlate API → queue → worker.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

import structlog
from starlette.requests import Request
from starlette.responses import Response
from structlog.contextvars import bind_contextvars, clear_contextvars, merge_contextvars

TRACE_HEADER = "x-trace-id"


def configure_logging(*, level: int = logging.INFO) -> None:
    """Configure structlog to emit JSON with a timestamp, level, and the bound context."""
    structlog.configure(
        processors=[
            merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )
    logging.basicConfig(format="%(message)s", level=level, force=True)


def new_trace_id() -> str:
    return uuid.uuid4().hex


async def trace_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """FastAPI HTTP middleware: bind an incoming/generated trace_id for the request's logs."""
    trace_id = request.headers.get(TRACE_HEADER) or new_trace_id()
    clear_contextvars()
    bind_contextvars(trace_id=trace_id)
    try:
        response = await call_next(request)
    finally:
        clear_contextvars()
    response.headers[TRACE_HEADER] = trace_id
    return response
