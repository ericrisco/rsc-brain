"""AUDIT-079: behavioural coverage for the run-error state machine (AUDIT-065/068/069/071).

Two independent adversarial reviews found that the unit tests protecting these four fixes were
tautological. I reproduced it: I deleted the AUDIT-071 reset, made the AUDIT-065 rule a
one-character revert (`>=` -> `>`), left both comments in place, and **all seven tests passed**.

The mechanism, in my own code:

    assert "AUDIT-071" in body     # satisfied by the comment
    assert "error" in body         # the word appears six times INSIDE that comment

And the worst one: `test_pdf_path_is_operable` asserted `"status" in head` to prove AUDIT-069 — while
the *buggy* code read `IngestOutcome(existing.id, existing.status, duplicate=True)`. The assertion
passed on the defect it was written to catch.

The docstrings were what the tests were reading. These tests read the database instead.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from rsc_brain.ingest.types import PipelineStage, RunStatus
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational.ingest_repository import Counters
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


async def _scope(harness: Harness) -> ProjectScope:
    project = await harness.setup_project(unique_slug("runs"), [("general", 0)])
    return harness.scope(project, allowed_topics=["general"])


async def _document(harness: Harness, scope: ProjectScope, checksum: str, tmp_path: Path) -> str:
    source = await harness.repo.ensure_default_source(scope)
    document_id, _duplicate, _version = await harness.repo.admit_document(
        scope,
        logical_id=checksum[:12],
        checksum=checksum,
        source_id=source.id,
        title=checksum[:12],
        path=str(tmp_path / f"{checksum}.pdf"),
    )
    return document_id


async def _status(harness: Harness, scope: ProjectScope, document: str) -> RunStatus:
    """The run, or a failure that says the run is missing rather than an AttributeError."""
    status = await harness.repo.get_run_status(scope, document)
    assert status is not None, "no run exists for this document"
    return status


async def _count(harness: Harness, scope: ProjectScope, document: str, **counters: int) -> None:
    """Apply counters through the product's own stage-marking path."""
    await harness.repo.mark_stage(
        scope, document, PipelineStage.EXTRACT, counters=Counters(**counters)
    )


async def test_a_recorded_failure_survives_until_the_next_attempt(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """AUDIT-068 + AUDIT-071 as one property, because they are one state machine.

    A failure must be readable where `brain status` reads it, and the NEXT attempt must start clean —
    otherwise a document that failed, was fixed and succeeded still reports the ConversionError it
    overcame, which is what shipped and what AUDIT-071 corrected.
    """
    harness = build_harness()
    scope = await _scope(harness)
    document = await _document(harness, scope, "a" * 64, tmp_path)

    await harness.repo.ensure_run(scope, document, phase="received")
    assert (await _status(harness, scope, document)).error is None

    await harness.repo.record_run_error(scope, document, "ConversionError: no C++ compiler")
    recorded = await _status(harness, scope, document)
    assert recorded.error is not None and "ConversionError" in recorded.error, (
        "a failure that reaches only the caller's stderr is invisible to every other surface"
    )

    # A new attempt begins. The previous attempt's failure is stale by definition.
    await harness.repo.ensure_run(scope, document, phase="received")
    cleared = await _status(harness, scope, document)
    assert cleared.error is None, (
        "the run still reports a failure the document has since overcome; a success that reports a "
        "failure is the same untruthfulness as a failure that reports success"
    )


async def test_a_run_that_published_nothing_says_so(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """AUDIT-065, behaviourally. The unit test allowed a one-character revert (`>=` -> `>`) that
    makes the rule unreachable, because discarded can never EXCEED created."""
    harness = build_harness()
    scope = await _scope(harness)
    document = await _document(harness, scope, "b" * 64, tmp_path)
    await harness.repo.ensure_run(scope, document, phase="received")

    await _count(harness, scope, document, chunks_created=2, discarded_chunks=2)
    status = await _status(harness, scope, document)
    assert status.error is not None and "no knowledge published" in status.error, (
        "every chunk was discarded and the run reports unqualified success"
    )


async def test_the_note_clears_when_a_later_stage_publishes(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The other half of the same rule: the note must not outlive the condition it describes."""
    harness = build_harness()
    scope = await _scope(harness)
    document = await _document(harness, scope, "c" * 64, tmp_path)
    await harness.repo.ensure_run(scope, document, phase="received")

    await _count(harness, scope, document, chunks_created=2, discarded_chunks=2)
    assert (await _status(harness, scope, document)).error is not None
    await _count(harness, scope, document, claims_generated=3)
    assert (await _status(harness, scope, document)).error is None, (
        "the no-knowledge note survived a stage that produced claims"
    )
