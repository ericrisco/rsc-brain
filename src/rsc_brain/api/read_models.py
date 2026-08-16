"""Typed, transient read-model envelopes for the console control plane.

These models deliberately contain no persisted authorization state.  Producers receive a
``ProjectScope`` and construct the envelope only after permission filtering, so generated clients
cannot accidentally interpret a raw store page as an authorized one.
"""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class ReadPage[T](BaseModel):
    """A bounded page whose metadata describes the authorized set only."""

    items: list[T]
    next_cursor: str | None
    total: int | None
    freshness: dt.datetime


class RecallView(BaseModel):
    """Display-safe recall audit row returned by the observability stream."""

    id: str
    ts: dt.datetime | None
    project_id: str
    user_id: str | None
    principal_type: str | None
    principal_id: str | None
    on_behalf_of: str | None
    trace_id: str | None
    action: str
    tool: str | None
    query_hash: str | None
    query_text: str | None
    duration_ms: int | None
    topics_used: list[str]
    result_count: int | None
    denied: bool
