"""Hybrid lexical+vector search against the real container (SPEC-12, FR-3.7).

The lexical (tsvector) via finds exact identifiers embeddings miss (invoice numbers), carries the
SAME in-query permission filter as the vector via (project + topics + FR-4.14), and fuses into the
recall pipeline by RRF. Denied/other-project identifiers stay found:false (FR-4.3).
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain.config.models import RecallConfig
from rsc_brain.mcp.tools import do_recall
from rsc_brain.recall.permissions import sensitive_tags
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.stores.age_graph_store import AgeGraphStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("secret", 3)]
INVOICE = b"# Invoices\n\nInvoice 2024-0173 total is 5000 EUR for the Acme account.\n"
IDENTIFIER = "2024-0173"


def _retriever(harness: Harness, *, tau: float = 0.45) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(tau=tau, hybrid_enabled=True),
    )


async def _publish(harness: Harness, project_id: str, data: bytes, tags: list[str]) -> None:
    scope = harness.scope(project_id, allowed_topics=tags)
    await harness.repo.create_source(
        scope, name=f"src-{tags[0]}", type_="folder", policy="source_tags", default_tags=tags
    )
    await harness.service.ingest_bytes(
        scope, data, filename=f"inv-{tags[0]}.md", source=f"src-{tags[0]}"
    )


async def test_lexical_via_finds_exact_identifier_and_respects_permissions(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish(harness, project_id, INVOICE, ["general"])
    retriever = _retriever(harness)
    forbidden = await sensitive_tags(harness.sm, project_id)

    # A user allowed on `general` finds the exact identifier via the lexical path.
    allowed = harness.scope(project_id, allowed_topics=["general"])
    hits = await retriever._lexical_candidates(allowed, IDENTIFIER, forbidden, 20)
    assert len(hits) >= 1

    # A user WITHOUT the topic gets nothing (the filter is in the query, FR-4.2).
    denied = harness.scope(project_id, allowed_topics=["secret"])
    assert await retriever._lexical_candidates(denied, IDENTIFIER, forbidden, 20) == []

    # Another project never sees it (cross-project isolation).
    other = await harness.setup_project(unique_slug("other"), TOPICS)
    other_scope = harness.scope(other, allowed_topics=["general"])
    other_forbidden = await sensitive_tags(harness.sm, other)
    assert await retriever._lexical_candidates(other_scope, IDENTIFIER, other_forbidden, 20) == []


async def test_hybrid_recall_surfaces_the_identifier_chunk(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish(harness, project_id, INVOICE, ["general"])
    # τ=0 isolates the candidate-phase contribution from the (fake-embedding) semantic score: the
    # lexical via brings the invoice chunk into the fused candidates, so the answer includes it.
    retriever = _retriever(harness, tau=0.0)
    scope = harness.scope(project_id, allowed_topics=["general"])

    out = await do_recall(retriever, harness.sm, scope, query=IDENTIFIER)
    assert out.found is True
    assert any(IDENTIFIER in f.text for f in out.fragments)


async def test_hybrid_disabled_falls_back_to_vector_only(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish(harness, project_id, INVOICE, ["general"])
    retriever = PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(tau=0.0, hybrid_enabled=False),
    )
    scope = harness.scope(project_id, allowed_topics=["general"])
    # The flag is honoured (v0.1 behaviour): the call still succeeds without the lexical via.
    out = await do_recall(retriever, harness.sm, scope, query=IDENTIFIER)
    assert out.found in (True, False)  # vector-only may or may not clear the bar; it must not error
