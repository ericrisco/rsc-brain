"""Integration: audit records one row per action (incl. agents) and exports CSV (SPEC-04)."""

from __future__ import annotations

import uuid

import pytest

from rsc_brain.audit import query_audit, record_audit, to_csv
from rsc_brain.identity.service import IdentityService
from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


async def test_audit_records_human_and_agent_actions_and_exports(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project_id = await svc.ensure_default_project()
        human = Principal(id=str(uuid.uuid4()), type=PrincipalType.HUMAN).scope_for(project_id)
        agent = Principal(id=str(uuid.uuid4()), type=PrincipalType.AGENT).scope_for(project_id)

        await record_audit(
            sessionmaker,
            human,
            action="recall",
            tool="mcp",
            query_hash="h1",
            topics_used=("general",),
            result_count=2,
        )
        await record_audit(
            sessionmaker,
            agent,
            action="recall",
            tool="mcp",
            query_hash="h2",
            denied=True,
            trace_id="run-42",
        )

        rows = await query_audit(sessionmaker, project_id, limit=50)
        assert len(rows) >= 2

        agent_rows = [r for r in rows if r["principal_type"] == "agent"]
        assert agent_rows
        assert agent_rows[0]["trace_id"] == "run-42"
        assert agent_rows[0]["denied"] is True
        assert agent_rows[0]["user_id"] is None  # agents are not a user

        human_rows = [r for r in rows if r["principal_type"] == "human"]
        assert human_rows and human_rows[0]["result_count"] == 2

        csv_text = to_csv(rows)
        assert "principal_type" in csv_text and "run-42" in csv_text
    finally:
        await engine.dispose()
