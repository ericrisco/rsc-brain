"""`brain verify` + golden-set eval runner against the real container (SPEC-06 AC 6/7).

Verify: gateway probe (deterministic fake → healthy) + database (extensions + head) → green; a
broken DB fails cleanly. Eval: run a couple of golden-shaped cases through recall and confirm the
§12 report (precision, abstention, latency) is produced.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from evals.runner import EvalCase, run_eval

from rsc_brain.installer.verify import run_verify
from rsc_brain.recall.interfaces import RecallResult
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0), ("hr", 3)]
DOC = b"# Engineering handbook\n\nThe deployment pipeline uses Docker containers and runs in CI.\n"


async def test_verify_all_green(build_harness: Callable[..., Harness]) -> None:
    """Readiness checks configuration and the local stores — and nothing remote (R50).

    The gateway probe moved behind `probe_models=True`: this command is the container healthcheck, so
    a provider outage used to restart every healthy container and a healthy deployment paid tokens on
    every probe.
    """
    harness = build_harness()
    report = await run_verify(gateway=harness.gateway, sessionmaker=harness.sm)
    assert report.ok is True
    names = {c.name for c in report.checks}
    assert {"capabilities", "database"} <= names
    assert "gateway" not in names, "readiness must not probe the model providers"


async def test_verify_probes_the_providers_only_when_asked(
    build_harness: Callable[..., Harness],
) -> None:
    """The deep diagnostic still exists — as an explicit operator action (AUDIT-044 clarification)."""
    harness = build_harness()
    report = await run_verify(gateway=harness.gateway, sessionmaker=harness.sm, probe_models=True)
    assert report.ok is True
    assert "gateway" in {c.name for c in report.checks}


async def test_verify_reports_database_failure(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    bad_engine = make_engine("postgresql+asyncpg://u:p@127.0.0.1:1/none")
    try:
        report = await run_verify(
            gateway=harness.gateway, sessionmaker=make_sessionmaker(bad_engine)
        )
    finally:
        await bad_engine.dispose()
    assert report.ok is False
    database = next(c for c in report.checks if c.name == "database")
    assert database.ok is False


async def test_run_eval_reports_metrics(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = build_harness(
        completion=make_completion(
            claims=[
                {"text": "runs in CI", "subject": "pipeline", "predicate": "runs", "object": "CI"}
            ],
            tags=["engineering"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    publish_scope = harness.scope(project, allowed_topics=["engineering"])
    await harness.repo.create_source(
        publish_scope,
        name="src",
        type_="folder",
        policy="source_tags",
        default_tags=["engineering"],
    )
    await harness.service.ingest_bytes(publish_scope, DOC, filename="hb.md", source="src")

    retriever = PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )
    allowed = harness.scope(project, allowed_topics=["engineering", "general"])
    forbidden = harness.scope(project, allowed_topics=["hr"])  # cannot see engineering

    async def recall_fn(case: EvalCase) -> RecallResult:
        scope = allowed if case.must_find else forbidden
        return await retriever.recall(scope, "deployment pipeline", top_k=8)

    cases = [
        EvalCase(case_id="hit1", family="hit", must_find=True),
        EvalCase(case_id="abstain1", family="denied", must_find=False),
    ]
    report = await run_eval(cases, recall_fn)
    assert report.total == 2
    assert report.retrieval_precision == 1.0  # the must-find case was found
    assert report.correct_abstention_rate == 1.0  # the denied case abstained
    assert report.permission_leaks == 0
    assert report.avg_latency_ms >= 0.0
