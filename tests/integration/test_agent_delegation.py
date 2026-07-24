"""Agent on_behalf_of delegation against the real container (SPEC-11 A, FR-14.2 + §5.14a).

An agent's effective permissions when acting for a user are topics(agent) ∩ topics(user): an
agent that itself has the HR topic, delegating for a user WITHOUT it, gets found:false on HR
content. Invalid delegation (unknown/inactive/other-project user) → AUTH_INVALID. Every delegated
call audits both the agent and the delegated user.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest

from rsc_brain.audit import query_audit
from rsc_brain.identity.resolve import resolve_delegated_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.mcp.tools import do_recall
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.age_graph_store import AgeGraphStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("engineering", 0), ("hr", 3)]
HR_DOC = b"# People handbook\n\nParental leave policy grants sixteen weeks at full pay.\n"
QUERY = "parental leave policy weeks"


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )


def _agent_scope(project_id: str, topics: tuple[str, ...]) -> object:
    # A real AGENT principal (valid-uuid id so audit can record it); resolve_delegated_scope
    # validates the delegated *user*, not the agent row.
    return Principal(
        id=str(uuid.uuid4()), type=PrincipalType.AGENT, allowed_topics=frozenset(topics)
    ).scope_for(project_id)


async def _publish_hr_doc(harness: Harness, project_id: str) -> None:
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="hr-src", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    await harness.service.ingest_bytes(scope, HR_DOC, filename="people.md", source="hr-src")


async def _member(harness: Harness, project_id: str, topics: tuple[str, ...]) -> str:
    identity = IdentityService(harness.sm)
    inv = await identity.invite_user(f"{unique_slug('deleg')}@example.com", role="member")
    user_id = await identity.accept_invitation(inv.token, "password-abc-123456")
    await identity.add_membership(user_id, project_id, allowed_topics=topics)
    return user_id


async def test_delegation_intersects_topics_hr_case(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish_hr_doc(harness, project_id)
    retriever = _retriever(harness)

    # The agent itself holds HR + engineering → it can see the HR content.
    agent = _agent_scope(project_id, ("hr", "engineering"))
    direct = await do_recall(retriever, harness.sm, agent, query=QUERY)  # type: ignore[arg-type]
    assert direct.found is True

    # Delegating for a user who only has engineering → intersection drops HR → found:false (§5.14a).
    user_id = await _member(harness, project_id, ("engineering",))
    delegated = await resolve_delegated_scope(harness.sm, agent, user_id)  # type: ignore[arg-type]
    assert delegated is not None
    assert "hr" not in delegated.allowed_topics
    assert delegated.on_behalf_of == user_id
    on_behalf = await do_recall(retriever, harness.sm, delegated, query=QUERY)
    assert on_behalf.found is False

    # The delegated call audits BOTH the agent and the user it acted for.
    rows = await query_audit(harness.sm, project_id, action="recall")
    delegated_rows = [r for r in rows if r["on_behalf_of"] == user_id]
    assert delegated_rows
    assert delegated_rows[0]["principal_id"] == agent.principal_id  # type: ignore[attr-defined]


async def test_invalid_delegation_returns_none(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    other_project = await harness.setup_project(unique_slug("other"), TOPICS)
    agent = _agent_scope(project_id, ("hr",))

    # Unknown user id.
    assert await resolve_delegated_scope(harness.sm, agent, str(uuid.uuid4())) is None  # type: ignore[arg-type]

    # A real user, but a member of a DIFFERENT project — never delegatable across projects.
    outsider = await _member(harness, other_project, ("hr",))
    assert await resolve_delegated_scope(harness.sm, agent, outsider) is None  # type: ignore[arg-type]

    # An inactive (deactivated) user in the agent's own project.
    disabled = await _member(harness, project_id, ("hr",))
    await IdentityService(harness.sm).deactivate_user(disabled)
    assert await resolve_delegated_scope(harness.sm, agent, disabled) is None  # type: ignore[arg-type]
