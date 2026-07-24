"""Read-observability backend against the real container (SPEC-14, FR-13.2/13.3/13.9 + FR-12.5).

The activity aggregates and recall stream are scoped to one project in-query (a project-admin sees
only theirs); the recall stream filters by principal; and query_text_logging=off means the query
text is never persisted or served (server-side, not a UI hide).
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain import audit
from rsc_brain.mcp.tools import do_recall
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.age_graph_store import AgeGraphStore

from .conftest import Harness, unique_slug


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )


pytestmark = pytest.mark.integration


async def test_activity_and_stream_are_project_scoped(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    a = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    b = await harness.setup_project(unique_slug("globex"), [("general", 0)])
    scope_a = harness.scope(a, allowed_topics=["general"])
    scope_b = harness.scope(b, allowed_topics=["general"])
    retriever = _retriever(harness)

    # Two recalls in A, one in B.
    await do_recall(retriever, harness.sm, scope_a, query="first query about A")
    await do_recall(retriever, harness.sm, scope_a, query="second query about A")
    await do_recall(retriever, harness.sm, scope_b, query="a query about B")

    summary_a = await audit.activity_summary(harness.sm, a)
    assert summary_a["recalls"] == 2  # only A's traffic — never B's (FR-12.5)
    summary_b = await audit.activity_summary(harness.sm, b)
    assert summary_b["recalls"] == 1
    # The stream is likewise scoped: only A's recalls, and p95 duration is populated.
    stream_a = await audit.recall_stream(harness.sm, a)
    assert len(stream_a) == 2
    assert all(r["duration_ms"] is not None for r in stream_a)


async def test_query_text_logging_off_never_persists_text(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    scope = harness.scope(project, allowed_topics=["general"])
    retriever = _retriever(harness)

    # Default ON → the raw text is stored + served in the stream.
    assert await audit.query_text_logging_enabled(harness.sm, project) is True
    await do_recall(retriever, harness.sm, scope, query="secret invoice 2024-0173")
    on_row = (await audit.recall_stream(harness.sm, project))[0]
    assert on_row["query_text"] == "secret invoice 2024-0173"
    assert on_row["query_hash"]

    # Turn it OFF → subsequent recalls persist NO text anywhere (only the hash + topics).
    await audit.set_query_text_logging(harness.sm, project, enabled=False)
    assert await audit.query_text_logging_enabled(harness.sm, project) is False
    await do_recall(retriever, harness.sm, scope, query="another private query 9988")
    rows = await audit.recall_stream(harness.sm, project)
    off_row = next(
        r for r in rows if r["query_hash"] == audit_query_hash("another private query 9988")
    )
    assert off_row["query_text"] is None
    assert off_row["query_hash"]  # hash still there


async def test_stream_filters_by_principal(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    human = harness.scope(project, allowed_topics=["general"])
    agent = Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.AGENT,
        allowed_topics=frozenset({"general"}),
    ).scope_for(project)
    retriever = _retriever(harness)

    await do_recall(retriever, harness.sm, human, query="human question")
    await do_recall(retriever, harness.sm, agent, query="agent question")

    humans = await audit.recall_stream(harness.sm, project, principal_type="human")
    agents = await audit.recall_stream(harness.sm, project, principal_type="agent")
    assert len(humans) == 1 and humans[0]["principal_type"] == "human"
    assert len(agents) == 1 and agents[0]["principal_type"] == "agent"


def audit_query_hash(text: str) -> str:
    from rsc_brain.recall.gaps import query_hash

    return query_hash(text)
