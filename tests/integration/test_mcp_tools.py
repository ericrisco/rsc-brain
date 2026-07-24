"""MCP tool logic + auth against the real container (SPEC-06 §5.8, AC 1-3/8).

Tests the tool functions with a resolved scope (the HTTP transport is exercised by a real MCP
client — blocked-by-resource in CI): recall provenance + untrusted_data + §5.8 schema, two PATs
→ disjoint corpora, get_document traceability with denied≡absent, report_feedback stub audits,
and PAT auth (valid → scope, invalid → AUTH_INVALID).
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain.audit import query_audit
from rsc_brain.identity.service import IdentityService
from rsc_brain.mcp.auth import AuthInvalidError, authenticate
from rsc_brain.mcp.tools import (
    RecallOutput,
    do_get_document,
    do_recall,
    do_report_feedback,
)
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0), ("hr", 3)]
DOC = b"# Engineering handbook\n\nThe deployment pipeline uses Docker containers and runs in CI.\n"


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )


async def _publish(harness: Harness, project_id: str, tags: list[str]) -> str:
    scope = harness.scope(project_id, allowed_topics=tags)
    await harness.repo.create_source(
        scope, name="src", type_="folder", policy="source_tags", default_tags=tags
    )
    outcome = await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="src")
    return outcome.document_id


async def _mint_pat(harness: Harness, project_id: str, topics: tuple[str, ...]) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('mcp')}@example.com", status="active")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(user.user_id, project_id, allowed_topics=topics)
    return (await identity.issue_pat(membership)).token


def _harness_with_content(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> Harness:
    return build_harness(
        completion=make_completion(
            entities=[{"name": "pipeline", "type": "system", "aliases": []}],
            claims=[
                {"text": "runs in CI", "subject": "pipeline", "predicate": "runs", "object": "CI"}
            ],
            tags=["engineering"],
        )
    )


async def test_recall_tool_provenance_untrusted_and_schema(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = _harness_with_content(build_harness, make_completion)
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish(harness, project, ["engineering"])
    scope = harness.scope(project, allowed_topics=["engineering", "general"])

    output = await do_recall(
        _retriever(harness), harness.sm, scope, query="deployment pipeline", top_k=8
    )
    assert output.found is True
    assert output.fragments
    fragment = output.fragments[0]
    assert fragment.content_type == "untrusted_data"
    # §5.8 fragment shape exactly (plus the content_type marker).
    assert set(RecallOutput.model_json_schema()["properties"]) == {
        "found",
        "fragments",
        "gap_registered",
    }
    fragment_props = set(fragment.model_dump().keys())
    assert {"text", "claim_ids", "document", "page", "credibility", "tags"} <= fragment_props

    # The tool audited the call (query text is never stored — only a hash).
    rows = await query_audit(harness.sm, project, action="recall")
    assert rows and rows[0]["tool"] == "recall" and rows[0]["query_hash"]


async def test_two_pats_get_disjoint_corpora(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = _harness_with_content(build_harness, make_completion)
    acme = await harness.setup_project(unique_slug("acme"), TOPICS)
    globex = await harness.setup_project(unique_slug("globex"), TOPICS)
    await _publish(harness, acme, ["engineering"])  # only acme has knowledge

    token_a = await _mint_pat(harness, acme, ("engineering", "general"))
    token_b = await _mint_pat(harness, globex, ("engineering", "general"))

    scope_a = await authenticate(harness.sm, f"Bearer {token_a}")
    scope_b = await authenticate(harness.sm, f"Bearer {token_b}")
    assert isinstance(scope_a, ProjectScope) and scope_a.project_id == acme
    assert scope_b.project_id == globex

    out_a = await do_recall(_retriever(harness), harness.sm, scope_a, query="deployment", top_k=8)
    out_b = await do_recall(_retriever(harness), harness.sm, scope_b, query="deployment", top_k=8)
    assert out_a.found is True
    assert out_b.found is False  # globex's PAT sees none of acme's corpus


async def test_get_document_traceability_and_denied_is_absent(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = _harness_with_content(build_harness, make_completion)
    acme = await harness.setup_project(unique_slug("acme"), TOPICS)
    other = await harness.setup_project(unique_slug("globex"), TOPICS)
    document_id = await _publish(harness, acme, ["engineering"])

    scope = harness.scope(acme, allowed_topics=["engineering", "general"])
    doc = await do_get_document(harness.sm, scope, document_id=document_id)
    assert "deployment pipeline" in doc.page_text
    assert doc.metadata["status"] == "processed"

    # Another project's scope sees the same document id as absent (empty, indistinguishable).
    other_scope = harness.scope(other, allowed_topics=["engineering", "general"])
    denied = await do_get_document(harness.sm, other_scope, document_id=document_id)
    assert denied.title == "" and denied.page_text == ""


async def test_report_feedback_stub_audits(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = _harness_with_content(build_harness, make_completion)
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["engineering"])
    result = await do_report_feedback(
        harness.sm, scope, claim_ids=["11111111-1111-1111-1111-111111111111"], signal="helpful"
    )
    assert result.ok is True
    rows = await query_audit(harness.sm, project, action="report_feedback:helpful")
    assert rows and rows[0]["tool"] == "report_feedback"


async def test_authenticate_rejects_bad_token(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    with pytest.raises(AuthInvalidError):
        await authenticate(harness.sm, "Bearer ck_not_a_real_token")
    with pytest.raises(AuthInvalidError):
        await authenticate(harness.sm, None)
