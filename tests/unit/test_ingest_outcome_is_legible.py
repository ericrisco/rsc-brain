"""AUDIT-065 / AUDIT-066b: an ingestion's outcome must be legible to the operator."""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REPOSITORY = REPO / "src" / "rsc_brain" / "stores" / "relational" / "ingest_repository.py"


def test_a_run_that_produced_no_knowledge_says_so() -> None:
    """AUDIT-065: a document whose every chunk was discarded reported `phase: processed` with
    `error: null`. Zero knowledge was published and the only signal was a counter in a separate
    status call, so an operator saw "processed" and believed it worked. Observed on a real install:
    two chunks in, two discarded, four claims short of anything usable.

    Discarding is right (FR-1.8 — never garbage to the graph). Reporting it as unqualified success
    is not."""
    source = REPOSITORY.read_text(encoding="utf-8")
    assert "AUDIT-065" in source, "the no-knowledge outcome is not recorded anywhere"
    # The rule must consider the accumulated totals, not one stage's delta.
    assert re.search(r"run\.claims_generated\s*==\s*0", source), (
        "the condition must test the run's accumulated claim count"
    )
    assert re.search(r"run\.discarded_chunks", source), (
        "the condition must consider how many chunks were discarded"
    )


def test_every_tag_the_pipeline_assigns_becomes_a_governable_topic() -> None:
    """AUDIT-066b: the topicalizer writes tags onto chunks and documents, but nothing created a
    `topics` row for them — so knowledge could be tagged with a name that exists nowhere in the
    taxonomy. No administrator could see it in order to grant it, and the permission filter cuts on
    exactly those names, which makes the knowledge unreachable and the reason undiscoverable.

    Granting stays an administrator's decision. Being able to SEE what needs granting cannot."""
    source = REPOSITORY.read_text(encoding="utf-8")
    body = source[source.index("async def apply_topics") :]
    body = body[: body.index("\n    async def ", 10)]
    assert "AUDIT-066b" in body, "apply_topics does not register the tags it writes as topics"
    assert "models.Topic" in body, "no topic row is created for an assigned tag"
    assert "on_conflict_do_nothing" in body or "ON CONFLICT" in body.upper(), (
        "registering a tag must be idempotent: the same tag arrives on every document"
    )
