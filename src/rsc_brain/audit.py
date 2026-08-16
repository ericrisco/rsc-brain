"""Audit log (SPEC-04): one row per authenticated action, plus query + CSV export.

Every authenticated action writes exactly one row capturing who/what/how-much and whether it
was denied (FR-4.5), including the agent fields (`principal_type`, `principal_id`,
`on_behalf_of`, `trace_id`) for agent principals (FR-14.3). Query text is stored only when the
project's ``query_text_logging`` is ON (FR-13.9, default ON) — otherwise just a hash, so audit
never leaks content. This module also serves the SPEC-14 read-observability aggregates.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import hmac
import io
import json
import uuid
from base64 import urlsafe_b64decode, urlsafe_b64encode
from binascii import Error as Base64Error
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.visibility import fully_authorized_topic_clause


class InvalidRecallCursor(ValueError):
    """The caller supplied a continuation token this read model did not issue."""


class RecallCursorSigningUnavailable(RuntimeError):
    """The database connection has no server-side credential from which to derive a signing key."""


@dataclass(frozen=True, slots=True)
class RecallPage:
    """Authorized recall rows plus continuation metadata for the console."""

    items: list[dict[str, object]]
    next_cursor: str | None
    total: int
    freshness: dt.datetime


async def _visibility(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> list[object]:
    """The audit-visibility predicate for ``scope``, as query conditions (R01).

    An audit row's topic dimension is ``topics_used``. Rows with none are project-level records of
    an action (an export, a review decision) rather than topic-scoped content, so they stay visible
    to a caller authorized for the project; a row that names topics is visible only to a caller who
    holds them.
    """
    del sessionmaker  # Kept in the frozen helper signature for its existing callers.
    return [
        models.AuditLog.project_id == uuid.UUID(scope.project_id),
        fully_authorized_topic_clause(models.AuditLog.topics_used, scope, allow_untagged=True),
    ]


async def record_audit(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    action: str,
    tool: str | None = None,
    query_hash: str | None = None,
    query_text: str | None = None,
    duration_ms: int | None = None,
    topics_used: Sequence[str] = (),
    result_count: int | None = None,
    denied: bool = False,
    trace_id: str | None = None,
) -> None:
    # `query_text` is persisted verbatim only when the caller passes it (do_recall passes it solely
    # when the project's query_text_logging is ON, FR-13.9) — record_audit itself never fetches it.
    is_human = scope.principal_type is PrincipalType.HUMAN
    async with session_scope(sessionmaker) as session:
        session.add(
            models.AuditLog(
                project_id=uuid.UUID(scope.project_id),
                user_id=uuid.UUID(scope.principal_id) if is_human else None,
                principal_type=scope.principal_type.value,
                principal_id=scope.principal_id,
                on_behalf_of=scope.on_behalf_of,
                trace_id=trace_id,
                action=action,
                tool=tool,
                query_hash=query_hash,
                query_text=query_text,
                duration_ms=duration_ms,
                topics_used=list(topics_used),
                result_count=result_count,
                denied=denied,
            )
        )


async def query_text_logging_enabled(
    sessionmaker: async_sessionmaker[AsyncSession], project_id: str
) -> bool:
    """Whether a project stores the raw query text in the audit log (FR-13.9, default ON). OFF ⇒
    the text is never persisted or served — only the hash + topics."""
    async with sessionmaker() as session:
        settings = await session.scalar(
            select(models.Project.settings).where(models.Project.id == uuid.UUID(project_id))
        )
    value = (settings or {}).get("query_text_logging", True)
    return bool(value)


def _row_to_dict(row: models.AuditLog) -> dict[str, object]:
    return {
        "id": row.id,
        "ts": row.ts.isoformat() if row.ts else None,
        "project_id": str(row.project_id),
        "user_id": str(row.user_id) if row.user_id else None,
        "principal_type": row.principal_type,
        "principal_id": row.principal_id,
        "on_behalf_of": row.on_behalf_of,
        "trace_id": row.trace_id,
        "action": row.action,
        "tool": row.tool,
        "query_hash": row.query_hash,
        "query_text": row.query_text,  # NULL unless query_text_logging is ON (FR-13.9)
        "duration_ms": row.duration_ms,
        "topics_used": list(row.topics_used),
        "result_count": row.result_count,
        "denied": row.denied,
    }


def _parse_date(value: str | None) -> dt.datetime | None:
    """Accept a date (YYYY-MM-DD) or an ISO timestamp; None passes through. Naive dates are UTC."""
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


async def query_audit_raw(
    sessionmaker: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    extra: Sequence[object] = (),
    action: str | None = None,
    tool: str | None = None,
    principal_type: str | None = None,
    principal_id: str | None = None,
    denied: bool | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 100,
) -> list[dict[str, object]]:
    """Filterable audit query WITHOUT topic visibility — project scope only.

    This is the internal/raw read (a test oracle, an operator repair path). Every caller that serves
    a human uses :func:`query_audit`, which adds the caller's topic visibility: R01 was exactly this
    query reached directly from the console.
    """
    conditions: list[object] = [models.AuditLog.project_id == uuid.UUID(project_id), *extra]
    if action is not None:
        conditions.append(models.AuditLog.action == action)
    if tool is not None:
        conditions.append(models.AuditLog.tool == tool)
    if principal_type is not None:
        conditions.append(models.AuditLog.principal_type == principal_type)
    if principal_id is not None:
        conditions.append(models.AuditLog.principal_id == principal_id)
    if denied is not None:
        conditions.append(models.AuditLog.denied.is_(denied))
    since_ts = _parse_date(since)
    if since_ts is not None:
        conditions.append(models.AuditLog.ts >= since_ts)
    until_ts = _parse_date(until)
    if until_ts is not None:
        conditions.append(models.AuditLog.ts <= until_ts)
    statement = (
        select(models.AuditLog)
        .where(*conditions)  # type: ignore[arg-type]
        .order_by(models.AuditLog.ts.desc())
        .limit(limit)
    )
    async with sessionmaker() as session:
        rows = await session.scalars(statement)
        return [_row_to_dict(row) for row in rows]


async def query_audit(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    action: str | None = None,
    tool: str | None = None,
    principal_type: str | None = None,
    principal_id: str | None = None,
    denied: bool | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 100,
) -> list[dict[str, object]]:
    """The audit log as THIS caller may see it: project scope plus topic visibility (R01).

    The export shares this query, so a CSV can never contain a row the list would have hidden.
    """
    return await query_audit_raw(
        sessionmaker,
        scope.project_id,
        extra=await _visibility(sessionmaker, scope),
        action=action,
        tool=tool,
        principal_type=principal_type,
        principal_id=principal_id,
        denied=denied,
        since=since,
        until=until,
        limit=limit,
    )


async def activity_summary(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> dict[str, object]:
    """Recall activity aggregates for the dashboard (FR-13.2): total recalls, denied/abstained,
    distinct active principals, p95 duration, and recalls/day.

    Every figure is computed over the caller's *authorized* rows. R01: these counters used to span
    the whole project, so a topic-limited caller learned how much traffic the topics it cannot see
    were getting — a disclosure with no row to hide behind.
    """
    visibility = await _visibility(sessionmaker, scope)
    recall_rows = models.AuditLog.action == "recall"
    async with sessionmaker() as session:
        totals = (
            await session.execute(
                select(
                    func.count(),
                    func.count().filter(models.AuditLog.denied.is_(True)),
                    func.count(func.distinct(models.AuditLog.principal_id)),
                    func.percentile_cont(0.95).within_group(models.AuditLog.duration_ms.asc()),
                ).where(*visibility, recall_rows)  # type: ignore[arg-type]
            )
        ).one()
        per_day_rows = await session.execute(
            select(func.date(models.AuditLog.ts), func.count())
            .where(*visibility, recall_rows)  # type: ignore[arg-type]
            .group_by(func.date(models.AuditLog.ts))
            .order_by(func.date(models.AuditLog.ts))
        )
        per_day = [{"day": str(day), "recalls": count} for day, count in per_day_rows.all()]
    total, denied, active, p95 = totals
    return {
        "recalls": int(total or 0),
        "denied": int(denied or 0),
        "active_principals": int(active or 0),
        "p95_duration_ms": (
            float(Decimal(str(p95)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))
            if p95 is not None
            else None
        ),
        "recalls_per_day": per_day,
    }


async def recall_stream(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    principal_type: str | None = None,
    denied: bool | None = None,
    limit: int = 100,
) -> list[dict[str, object]]:
    """The live recall stream (FR-13.3), scoped in-query, filterable by principal + denial.
    ``query_text`` is already NULL when the project's logging is OFF (FR-13.9) — no filter needed."""
    conditions: list[object] = [
        *await _visibility(sessionmaker, scope),
        models.AuditLog.action == "recall",
    ]
    if principal_type is not None:
        conditions.append(models.AuditLog.principal_type == principal_type)
    if denied is not None:
        conditions.append(models.AuditLog.denied.is_(denied))
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(models.AuditLog)
            .where(*conditions)  # type: ignore[arg-type]
            .order_by(models.AuditLog.ts.desc())
            .limit(limit)
        )
        return [_row_to_dict(row) for row in rows]


def _cursor_signing_key(sessionmaker: async_sessionmaker[AsyncSession]) -> bytes:
    """Derive a domain-separated cursor key from the existing database credential.

    The database password is already required secret application material in every supported
    deployment.  Domain separation means the derived bytes cannot be used as the database
    credential, while every replica connected with that credential verifies the same stateless
    cursor.  We deliberately fail closed for passwordless URLs instead of inventing a predictable
    fallback or a per-process key that breaks across replicas and restarts.
    """
    bind = sessionmaker.kw.get("bind")
    if not isinstance(bind, AsyncEngine) or not bind.url.password:
        raise RecallCursorSigningUnavailable("cursor signing requires a credentialed database URL")
    namespace = f"{bind.url.username or ''}/{bind.url.database or ''}".encode()
    return hmac.new(
        bind.url.password.encode(),
        b"rsc-brain:console-recall-cursor:v1\0" + namespace,
        hashlib.sha256,
    ).digest()


def _cursor_context(
    scope: ProjectScope, *, principal_type: str | None, denied: bool | None
) -> bytes:
    """Canonical associated data that prevents cross-authority/filter replay."""
    return json.dumps(
        {
            "aud": "console-observability-recalls",
            "project_id": scope.project_id,
            "principal_id": scope.principal_id,
            "principal_type": scope.principal_type.value,
            "on_behalf_of": scope.on_behalf_of,
            "allowed_topics": sorted(scope.allowed_topics),
            "role": scope.role,
            "filters": {"principal_type": principal_type, "denied": denied},
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()


def _b64encode(value: bytes) -> str:
    return urlsafe_b64encode(value).decode().rstrip("=")


def _b64decode(value: str) -> bytes:
    return urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}".encode())


def _cursor_signature(key: bytes, encoded_position: str, context: bytes) -> bytes:
    return hmac.new(
        key,
        b"rsc-brain:recall-page:v1\0" + context + b"\0" + encoded_position.encode(),
        hashlib.sha256,
    ).digest()


def _encode_recall_cursor(row: models.AuditLog, *, key: bytes, context: bytes) -> str:
    payload = json.dumps(
        {"v": 1, "ts": row.ts.isoformat(), "id": row.id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    position = _b64encode(payload)
    signature = _b64encode(_cursor_signature(key, position, context))
    return f"{position}.{signature}"


def _decode_recall_cursor(value: str, *, key: bytes, context: bytes) -> tuple[dt.datetime, int]:
    try:
        position, signature, *unexpected = value.split(".")
        if unexpected or not position or not signature:
            raise ValueError
        supplied_signature = _b64decode(signature)
        expected_signature = _cursor_signature(key, position, context)
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ValueError
        raw = _b64decode(position)
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("v") != 1:
            raise ValueError
        timestamp = dt.datetime.fromisoformat(payload["ts"])
        row_id = int(payload["id"])
        if timestamp.tzinfo is None or row_id < 1:
            raise ValueError
    except (Base64Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise InvalidRecallCursor("invalid recall cursor") from exc
    return timestamp, row_id


async def recall_page(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    principal_type: str | None = None,
    denied: bool | None = None,
    cursor: str | None = None,
    limit: int = 100,
) -> RecallPage:
    """Page the authorized recall set with a stable, metadata-safe cursor.

    Visibility enters both the total and item queries before ordering or pagination.  The cursor
    contains only the last *authorized* row's timestamp and surrogate id; it can neither disclose
    a filtered principal nor advance across raw tenant rows.
    """
    conditions: list[object] = [
        *await _visibility(sessionmaker, scope),
        models.AuditLog.action == "recall",
    ]
    if principal_type is not None:
        conditions.append(models.AuditLog.principal_type == principal_type)
    if denied is not None:
        conditions.append(models.AuditLog.denied.is_(denied))

    context = _cursor_context(scope, principal_type=principal_type, denied=denied)
    signing_key: bytes | None = None
    page_conditions = list(conditions)
    if cursor is not None:
        signing_key = _cursor_signing_key(sessionmaker)
        timestamp, row_id = _decode_recall_cursor(cursor, key=signing_key, context=context)
        page_conditions.append(
            or_(
                models.AuditLog.ts < timestamp,
                and_(models.AuditLog.ts == timestamp, models.AuditLog.id < row_id),
            )
        )

    async with sessionmaker() as session:
        total, latest = (
            await session.execute(
                select(func.count(), func.max(models.AuditLog.ts)).where(*conditions)  # type: ignore[arg-type]
            )
        ).one()
        rows = list(
            await session.scalars(
                select(models.AuditLog)
                .where(*page_conditions)  # type: ignore[arg-type]
                .order_by(models.AuditLog.ts.desc(), models.AuditLog.id.desc())
                .limit(limit + 1)
            )
        )

    has_more = len(rows) > limit
    visible_rows = rows[:limit]
    items: list[dict[str, object]] = []
    for row in visible_rows:
        item = _row_to_dict(row)
        item["id"] = str(row.id)
        items.append(item)
    return RecallPage(
        items=items,
        next_cursor=(
            _encode_recall_cursor(
                visible_rows[-1],
                key=signing_key or _cursor_signing_key(sessionmaker),
                context=context,
            )
            if has_more and visible_rows
            else None
        ),
        total=int(total or 0),
        freshness=latest or dt.datetime.now(dt.UTC),
    )


async def set_query_text_logging(
    sessionmaker: async_sessionmaker[AsyncSession], project_id: str, *, enabled: bool
) -> None:
    """Toggle the per-project ``query_text_logging`` setting (FR-13.9). Merges into settings JSONB."""
    async with session_scope(sessionmaker) as session:
        project = await session.get(models.Project, uuid.UUID(project_id))
        if project is None:  # pragma: no cover - scope guarantees the project exists
            return
        project.settings = {**(project.settings or {}), "query_text_logging": enabled}


#: Characters that make a spreadsheet start parsing a cell as an expression. Leading whitespace is
#: skipped before that decision, so a payload can hide behind a tab or a carriage return.
_ACTIVE_PREFIXES = ("=", "+", "-", "@")

#: Control characters that would forge rows/columns or terminate the record early. Tab, CR and LF are
#: handled separately: they are legitimate inside a quoted CSV field but must not survive as the
#: leading characters of a cell, and NUL must not survive at all.
_STRIPPED_CONTROLS = {chr(code) for code in range(32)} - {"\t", "\n", "\r"} | {"\x7f"}


def neutralize_cell(value: object) -> object:
    """Make one exported cell inert for a spreadsheet while keeping its literal readable (R11).

    Opened in Excel, LibreOffice or Sheets, a cell whose first non-blank character is ``=``, ``+``,
    ``-`` or ``@`` is evaluated: ``=cmd|' /c calc'!A0`` executes, ``=WEBSERVICE(...)`` exfiltrates the
    row with no click. Audit values come from callers — a query text, a topic slug, a trace header — so
    the export carries whatever was recorded straight to whoever opens it.

    Neutralization is a leading apostrophe, the convention every major spreadsheet reads as "this is
    text": the original characters stay in the file, so the literal value remains recoverable, which
    an audit log has to guarantee. Values that are not text (ids, booleans, timestamps) pass through
    untouched.
    """
    if not isinstance(value, str) or not value:
        return value
    cleaned = "".join(char for char in value if char not in _STRIPPED_CONTROLS)
    # Compare on the stripped form: spreadsheets skip leading blanks before deciding, so " =1+1" and
    # "\t=1+1" are just as active as "=1+1".
    if cleaned.lstrip("\t\r\n ").startswith(_ACTIVE_PREFIXES):
        return f"'{cleaned}"
    return cleaned


def to_csv(rows: Sequence[dict[str, object]]) -> str:
    """Render audit rows as CSV with every cell neutralized against spreadsheet execution (R11).

    ``csv`` already quotes embedded separators and newlines, so row/column forgery is handled by the
    writer; what it does not do — and what R11 is about — is stop the spreadsheet from treating a
    quoted cell's content as a formula once it is opened.
    """
    if not rows:
        return ""
    fields = list(rows[0].keys())
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {
                key: neutralize_cell(";".join(value) if isinstance(value, list) else value)
                for key, value in row.items()
            }
        )
    return buffer.getvalue()
