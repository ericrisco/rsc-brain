"""Snapshot completeness and fail-closed verification (AUDIT-045 / R40, R41).

The subprocess half of backup/restore needs the PostgreSQL client tools and lives in the CI-gated round
trip. The part that has to be RIGHT — what a snapshot must contain and when it may be restored — is
here, because a rule that only runs where `pg_dump` is installed is a rule nobody checks on the way in.
"""

from __future__ import annotations

import json
from pathlib import Path

from rsc_brain.deploy.snapshot import (
    DATABASE_NAME,
    MANIFEST_NAME,
    SNAPSHOT_FORMAT,
    build_manifest,
    verify_snapshot,
    write_manifest,
)


def _snapshot(root: Path, *, blobs: dict[str, bytes] | None = None) -> Path:
    (root / DATABASE_NAME).write_bytes(b"PGDMP fake custom-format dump")
    for name, content in (blobs or {}).items():
        target = root / "blobs" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    write_manifest(root, build_manifest(root, created_at="2026-07-25T00:00:00+00:00"))
    return root


def test_a_manifest_lists_every_component_with_a_checksum(tmp_path: Path) -> None:
    """A backup that does not say what it contains cannot be checked before it is needed.

    Blobs are listed individually rather than counted: a single altered or missing original is exactly
    the partial restore this exists to refuse, and a count cannot detect one.
    """
    root = _snapshot(tmp_path, blobs={"p1/a.pdf": b"one", "p1/b.pdf": b"two"})

    manifest = json.loads((root / MANIFEST_NAME).read_text())

    assert manifest["format"] == SNAPSHOT_FORMAT
    paths = {c["path"] for c in manifest["components"]}
    assert DATABASE_NAME in paths, "the database component is not in the manifest"
    assert {"blobs/p1/a.pdf", "blobs/p1/b.pdf"} <= paths, (
        f"the stored documents are not in the manifest: {sorted(paths)}"
    )
    assert all(c["sha256"] and c["size"] > 0 for c in manifest["components"])
    assert manifest["blob_count"] == 2


def test_a_verified_snapshot_is_restorable(tmp_path: Path) -> None:
    assert verify_snapshot(_snapshot(tmp_path, blobs={"p1/a.pdf": b"one"})).ok


def test_a_snapshot_without_a_manifest_is_refused(tmp_path: Path) -> None:
    """A directory that is not a snapshot must not be treated as one 'best effort'."""
    (tmp_path / DATABASE_NAME).write_bytes(b"PGDMP")

    verification = verify_snapshot(tmp_path)

    assert not verification.ok
    assert MANIFEST_NAME in verification.explain()


def test_a_corrupt_component_is_refused_with_its_name(tmp_path: Path) -> None:
    """A truncated or altered dump used to pass: the only gate was "the extensions exist"."""
    root = _snapshot(tmp_path, blobs={"p1/a.pdf": b"one"})
    (root / DATABASE_NAME).write_bytes(b"PGDMP fake custom-format dump TAMPERED")

    verification = verify_snapshot(root)

    assert not verification.ok
    assert DATABASE_NAME in verification.explain()


def test_a_missing_stored_document_is_refused(tmp_path: Path) -> None:
    """Restoring a snapshot whose originals are gone produces rows pointing at nothing."""
    root = _snapshot(tmp_path, blobs={"p1/a.pdf": b"one", "p1/b.pdf": b"two"})
    (root / "blobs" / "p1" / "b.pdf").unlink()

    verification = verify_snapshot(root)

    assert not verification.ok
    assert "blobs/p1/b.pdf" in verification.explain()


def test_an_unsupported_format_is_refused(tmp_path: Path) -> None:
    """A snapshot from a newer version is refused rather than interpreted optimistically."""
    root = _snapshot(tmp_path)
    manifest = json.loads((root / MANIFEST_NAME).read_text())
    manifest["format"] = SNAPSHOT_FORMAT + 1
    (root / MANIFEST_NAME).write_text(json.dumps(manifest))

    verification = verify_snapshot(root)

    assert not verification.ok
    assert "format" in verification.explain()


def test_every_problem_is_reported_not_just_the_first(tmp_path: Path) -> None:
    """An operator deciding what to do about a bad snapshot needs the whole picture."""
    root = _snapshot(tmp_path, blobs={"p1/a.pdf": b"one", "p1/b.pdf": b"two"})
    (root / "blobs" / "p1" / "a.pdf").unlink()
    (root / DATABASE_NAME).write_bytes(b"different length entirely")

    problems = verify_snapshot(root).problems

    assert len(problems) >= 2, problems
