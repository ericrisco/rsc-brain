"""AUDIT-091: the run snapshot answered "what state" and never "is it moving".

`ingest_runs.updated_at` has existed since the schema was written, and every stage mark and every
recorded error stamps it. No reader could see it: `RunStatus` — the type FR-1.12 calls "a queryable
snapshot of a document's ingestion run" — did not carry the field, and neither API response
serialised it.

Measured on a real host. A 400-page PDF sat at

    phase: approved   completed_stages: [parse, tables, chunk, topicalize]
    chunks_created: 800   claims_generated: 0   error: null

for **three hours**, unchanged, while making 1,300 provider calls and burning 2.7M tokens. Every
field in that response was correct and none of them moved, because `claims_generated` is written
when the extract stage completes, not as it runs.

Establishing that it was working rather than wedged took counting rows in `token_usage` twice, two
and a half minutes apart. No operator should have to do that, and an operator who does not will
either restart a healthy worker or wait indefinitely on a dead one. Both are worse than the truth.

The fix is deliberately small: expose the timestamp the row already keeps. It does not add
within-stage progress — a real improvement, and a larger change than this — but it does make
"moving" and "stopped" distinguishable, which is the question that actually gets asked.
"""

from __future__ import annotations

import datetime as dt

from rsc_brain.ingest.types import RunStatus


def test_the_snapshot_carries_a_clock() -> None:
    """FR-1.12 calls this a snapshot; a snapshot with no time on it cannot be compared to itself."""
    assert "updated_at" in RunStatus.__dataclass_fields__, (
        "the run snapshot has no timestamp, so two consecutive polls are indistinguishable whether "
        "the worker is grinding or dead"
    )


def test_the_clock_is_optional_so_old_rows_still_load() -> None:
    """A run written before this field must not fail to build a snapshot."""
    status = RunStatus(document_id="d", project_id="p", phase="approved")
    assert status.updated_at is None


def test_the_clock_round_trips() -> None:
    stamp = dt.datetime(2026, 8, 16, 14, 39, 52, tzinfo=dt.UTC)
    status = RunStatus(document_id="d", project_id="p", phase="approved", updated_at=stamp)
    assert status.updated_at == stamp


def test_both_api_surfaces_serialise_it() -> None:
    """Two readers exist — the ingest route and the admin route — and an operator may poll either.

    One of them carrying the clock and the other not is how a caller learns to distrust both.
    """
    from pathlib import Path

    repo = Path(__file__).resolve().parents[3]
    for module in ("app.py", "admin.py"):
        source = (repo / "src" / "rsc_brain" / "api" / module).read_text(encoding="utf-8")
        assert '"updated_at"' in source, (
            f"api/{module} serialises a run without its timestamp, so that surface still cannot "
            "answer whether the run is progressing"
        )


def test_the_repository_populates_it() -> None:
    """The field existing and never being filled would be the same defect one layer down."""
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[3]
        / "src"
        / "rsc_brain"
        / "stores"
        / "relational"
        / "ingest_repository.py"
    ).read_text(encoding="utf-8")
    assert "updated_at=run.updated_at" in source, (
        "the snapshot declares a timestamp the repository never fills, so every reader sees None"
    )
