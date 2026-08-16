"""AUDIT-088: a document that failed conversion was reported as `received`, forever.

Measured on a rented host with ten deliberately hostile PDFs. Three of them — zero bytes, a
truncated transfer, and a ZIP renamed to `.pdf` — raised `ConversionError` inside the worker.
Procrastinate marked all three jobs `failed` and exhausted them (one attempt, no retry policy).
The product's own surface, for those same three documents:

    phase: received      error: null      chunks: 0      claims: 0

Which is character-for-character what it reported for the four documents still sitting in `todo`.
An operator polling `GET /api/v1/ingest/runs` — or reading the console's Observability page — had
no way to tell a dropped document from a queued one. The failure existed only in the worker's
stdout.

The bitter part is that the machinery was already there and already documented for this exact
reader. `record_run_error`'s docstring says a failure reaching only stderr is "invisible to the
console, to a **worker-driven ingest**, and to anyone looking a week later". And AUDIT-068's fix in
`IngestService._admit_and_run` names "a worker-driven ingest" among the readers it protects — while
sitting three lines *below* the `if self._queue is not None: ... return` that every production
install takes. The fix guarded the one path production never uses.

For a product whose thesis is that it never silently swallows knowledge, a silently swallowed
document is the worst available outcome: nobody ever learns the knowledge is missing.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from rsc_brain.ingest.failures import describe_failure, record_ingestion_failure
from rsc_brain.scope import Principal, PrincipalType, ProjectScope

REPO = Path(__file__).resolve().parents[3]
QUEUE = REPO / "src" / "rsc_brain" / "ingest" / "queue.py"


def _scope() -> ProjectScope:
    return Principal(id="p1", type=PrincipalType.HUMAN, can_curate=True).scope_for("proj-1")


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def record_run_error(self, scope: ProjectScope, document_id: str, error: str) -> None:
        self.calls.append((document_id, error))


class _Broken:
    async def record_run_error(self, scope: ProjectScope, document_id: str, error: str) -> None:
        raise RuntimeError("the database is unreachable too")


async def test_the_failure_reaches_the_run() -> None:
    recorder = _Recorder()
    await record_ingestion_failure(
        recorder, _scope(), "doc-1", RuntimeError("File format not allowed")
    )
    assert recorder.calls, "the crash left no trace on the run"
    document_id, message = recorder.calls[0]
    assert document_id == "doc-1"
    assert "File format not allowed" in message


def test_the_message_names_the_exception_type() -> None:
    """`ConversionError` and `TimeoutError` need different operator responses.

    The three real failures produced messages that read alike until the type separated them.
    """
    assert "ConversionError" in describe_failure(type("ConversionError", (Exception,), {})("x"))
    assert "TimeoutError" in describe_failure(TimeoutError("x"))


def test_the_message_is_bounded() -> None:
    """A pathological exception text must not become an unbounded column write."""
    assert len(describe_failure(RuntimeError("x" * 50_000))) <= 1000


async def test_a_failing_recorder_never_replaces_the_original_crash() -> None:
    """If the guard itself raised, a recorded crash would become an unrecorded one."""
    await record_ingestion_failure(_Broken(), _scope(), "doc-1", RuntimeError("boom"))


def test_the_queued_path_records_its_failures() -> None:
    """The regression itself, asserted structurally.

    A behavioural test of the worker needs a live queue and a live database, so it cannot run
    where this defect was introduced. What can be checked anywhere is the property that was
    missing: the queued runner must guard `pipeline.process` and record the failure. Without this,
    the branch production actually takes is exactly the branch nothing covers — which is how the
    defect survived AUDIT-068.
    """
    tree = ast.parse(QUEUE.read_text(encoding="utf-8"))
    runner = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_default_runner"
    )

    handlers = [node for node in ast.walk(runner) if isinstance(node, ast.ExceptHandler)]
    assert handlers, (
        "_default_runner has no except handler, so a pipeline crash reaches procrastinate and "
        "the run keeps saying `received` with `error: null`"
    )

    recorded = {
        node.func.id
        for handler in handlers
        for node in ast.walk(handler)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "record_ingestion_failure" in recorded, (
        "the queued runner catches the failure without writing it to the run"
    )

    assert any(
        isinstance(node, ast.Raise) and node.exc is None
        for handler in handlers
        for node in ast.walk(handler)
    ), "the runner swallows the exception, so the job would be marked succeeded"


@pytest.mark.parametrize("path", ["service.py", "queue.py"])
def test_both_ingestion_paths_use_the_shared_recorder(path: str) -> None:
    """Neither path may hand-roll the message: two spellings drift, and one of them was wrong."""
    source = (REPO / "src" / "rsc_brain" / "ingest" / path).read_text(encoding="utf-8")
    assert "record_ingestion_failure" in source, f"{path} does not use the shared failure recorder"
