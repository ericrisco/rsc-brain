"""Document-lifecycle authority is enforced at the HTTP route and nowhere else (AUDIT-145).

`api/admin.py::approve_document` calls `decide_document(..., extra_tags=body.tags)` before it acts, so
a console caller cannot publish a document into, or out of, a topic it does not hold (R02). Nothing
below that route repeats the check: `IngestService.approve` and `IngestionPipeline.approve` take a
`ProjectScope` and never consult its `allowed_topics`, and `IngestRepository.get_document` filters by
project alone.

So every other caller of the same operation performs it unchecked. The CLI is one today —
`_CLI_TOPICS` is deliberately empty, with the comment *"granting the CLI blanket topic authority would
make the box's root account a universal reader"* — and it can publish a document into any topic in the
project while being unable to LIST it, because `list_documents_by_status` **is** topic-scoped
(AUDIT-089). Authority over the queue, none over the action.

`evals/gate_run.py` asserted the opposite in a comment until AUDIT-145: that `brain docs` "cannot
approve them and should not be able to". The principle is right and the fact was wrong.

This test pins the behaviour as it is rather than asserting what it should be, because the choice is a
product decision with real blast radius:

* if the CLI legitimately acts as a local operator with implicit authority, the guarantee stops at the
  API and that has to be written down, not implied by a comment that says the reverse;
* if topic authority binds every caller, the check moves into the pipeline and `brain docs approve`
  stops working for any document carrying a topic — which is all of them.

Either way this test is the one that changes, deliberately, instead of the property changing silently.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain.scope import Principal, PrincipalType
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("hr", 3)]
DOC = b"""# Handbook

Individual review scores are confidential to HR.
"""


async def test_a_principal_with_no_topic_grants_publishes_into_a_sensitive_topic(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(completion=make_completion(tags=["hr"]))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.HUMAN,
        allowed_topics=frozenset(),
        can_curate=True,
    ).scope_for(project)
    assert scope.allowed_topics == frozenset(), "the premise: this caller holds nothing"
    await harness.repo.create_source(
        scope, name="m", type_="folder", policy="manual", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="m")

    run = await harness.service.approve(scope, outcome.document_id, tags=["hr"], approver="cli")

    document = await harness.repo.get_document(scope, outcome.document_id)
    assert document is not None
    assert run.phase == "processed", "it published"
    assert document.doc_tags == ("hr",), "into a topic at the sensitivity threshold"
    assert not await harness.repo.list_documents_by_status(scope, "processed"), (
        "and it still cannot list what it just published"
    )
    published = [
        c for c in await harness.repo.load_chunks(scope, outcome.document_id) if not c.needs_review
    ]
    assert published and all("hr" in c.tags for c in published)


async def test_the_same_principal_cannot_see_the_queue_it_can_act_on(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    """The asymmetry, stated as one assertion. AUDIT-089 made the listing topic-scoped and stopped
    there, so the caller is denied the titles and proposed tags of exactly the documents it may
    publish."""
    harness = build_harness(completion=make_completion(tags=["hr"]))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.HUMAN,
        allowed_topics=frozenset(),
        can_curate=True,
    ).scope_for(project)
    await harness.repo.create_source(
        scope, name="m", type_="folder", policy="manual", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="m")

    queue = await harness.repo.list_documents_by_status(scope, "pending_approval")

    assert not queue, (
        "the document is invisible to this caller (AUDIT-089) — it carries `hr` from the source's "
        "declared tags, so there is something for the topic filter to act on"
    )
    # And yet:
    run = await harness.service.approve(scope, outcome.document_id, tags=["hr"], approver="cli")
    assert run.phase == "processed"


async def test_a_topic_holding_principal_is_the_intended_path(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    """The control: with the grant, the queue is visible and the approval is legitimate. Whatever the
    owner decides about the case above, this must keep working."""
    harness = build_harness(completion=make_completion(tags=["hr"]))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="m", type_="folder", policy="manual", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="m")

    queue = await harness.repo.list_documents_by_status(scope, "pending_approval")
    assert [d.id for d in queue] == [outcome.document_id]

    run = await harness.service.approve(scope, outcome.document_id, tags=["hr"], approver="cli")
    assert run.phase == "processed"
