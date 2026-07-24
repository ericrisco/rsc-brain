"""scan_inbox mapping (FR-1.1/12.6): inbox/<project>/<source>/<file>, default source, debounce."""

from __future__ import annotations

from pathlib import Path

from rsc_brain.ingest.watcher import DEFAULT_SOURCE, scan_inbox


def _touch(path: Path, mtime: float | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    if mtime is not None:
        import os

        os.utime(path, (mtime, mtime))


def test_maps_project_source_and_default(tmp_path: Path) -> None:
    _touch(tmp_path / "acme" / "hr" / "a.pdf")
    _touch(tmp_path / "acme" / "loose.pdf")  # directly under project → default source
    _touch(tmp_path / "globex" / "finance" / "b.pdf")
    items = scan_inbox(tmp_path)
    mapping = {(i.project_slug, i.source_name, i.path.name) for i in items}
    assert ("acme", "hr", "a.pdf") in mapping
    assert ("acme", DEFAULT_SOURCE, "loose.pdf") in mapping
    assert ("globex", "finance", "b.pdf") in mapping


def test_debounce_skips_recently_modified(tmp_path: Path) -> None:
    _touch(tmp_path / "acme" / "src" / "fresh.pdf", mtime=1000.0)
    # now=1000.5, settle=1.0 → file is 0.5s old → not settled → skipped.
    assert scan_inbox(tmp_path, settle_seconds=1.0, now=1000.5) == []
    # now=1002.0 → 2s old → settled.
    assert len(scan_inbox(tmp_path, settle_seconds=1.0, now=1002.0)) == 1


def test_missing_root_is_empty(tmp_path: Path) -> None:
    assert scan_inbox(tmp_path / "nope") == []
