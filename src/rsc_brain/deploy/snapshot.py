"""Snapshot format and verification for backup/restore (AUDIT-045 / R40, R41).

``brain backup`` used to be one ``pg_dump`` file. The database carries the graph and the vectors (both
live in Postgres), but NOT the stored source documents — so a backup was silently partial, and an
operator who restored it got a corpus whose every original was missing while the rows still pointed at
paths that no longer existed. Nothing recorded what a backup contained, either, so there was no way to
find that out before needing it.

``brain restore`` had the mirror problem: ``pg_restore`` runs with ``check=False`` (AGE's per-graph label
tables make a clean restore report non-fatal errors), and the only gate was "the extensions exist and
alembic_version has a row". A truncated dump, a missing blob or an incompatible snapshot version all
passed that gate and were reported ready.

A snapshot is therefore a DIRECTORY with a manifest:

    snapshot/
      manifest.json      — format version, created_at, per-component size + SHA-256
      database.dump      — pg_dump custom format (relational + AGE + pgvector)
      blobs/<project>/…  — the stored originals, exactly as the data directory holds them

Verification is separated from the subprocess work on purpose: the checksum, completeness and
compatibility rules are the part that has to be right, and they are testable without the PostgreSQL
client tools (which are absent on many dev hosts). The CI round trip covers the binaries.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

#: Bumped when the layout changes in a way an older reader cannot handle. Restore REFUSES a snapshot
#: whose format it does not know, rather than doing its best with an unfamiliar directory.
SNAPSHOT_FORMAT = 1

MANIFEST_NAME = "manifest.json"
DATABASE_NAME = "database.dump"
BLOBS_DIR = "blobs"

#: Every component a complete snapshot must contain. `database.dump` carries the relational store, the
#: AGE graph and the pgvector embeddings, because all three live in the same Postgres database.
REQUIRED_COMPONENTS = (DATABASE_NAME,)


@dataclass(frozen=True, slots=True)
class Component:
    """One file inside a snapshot, with what it should be."""

    path: str  # relative to the snapshot root, POSIX separators
    size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class Manifest:
    format: int
    created_at: str
    components: tuple[Component, ...]
    blob_count: int = 0

    def to_json(self) -> str:
        return json.dumps(
            {
                "format": self.format,
                "created_at": self.created_at,
                "blob_count": self.blob_count,
                "components": [
                    {"path": c.path, "size": c.size, "sha256": c.sha256} for c in self.components
                ],
            },
            indent=2,
            sort_keys=True,
        )

    @staticmethod
    def from_json(text: str) -> Manifest:
        raw = json.loads(text)
        return Manifest(
            format=int(raw["format"]),
            created_at=str(raw["created_at"]),
            blob_count=int(raw.get("blob_count", 0)),
            components=tuple(
                Component(path=str(c["path"]), size=int(c["size"]), sha256=str(c["sha256"]))
                for c in raw["components"]
            ),
        )


@dataclass(frozen=True, slots=True)
class Verification:
    """Why a snapshot may or may not be restored. Never a bare boolean: an operator needs the reason."""

    ok: bool
    problems: tuple[str, ...] = field(default_factory=tuple)

    def explain(self) -> str:
        return "snapshot verified" if self.ok else "; ".join(self.problems)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def describe(root: Path, relative: str) -> Component:
    target = root / relative
    return Component(path=relative, size=target.stat().st_size, sha256=sha256_file(target))


def build_manifest(root: Path, *, created_at: str, extra: Iterable[str] = ()) -> Manifest:
    """Describe every component present in ``root``, including each blob.

    Blobs are listed individually, not as a directory total: a missing or altered single original is
    exactly the kind of partial restore this exists to refuse, and a count cannot detect it.
    """
    components = [describe(root, DATABASE_NAME)]
    blobs = (
        sorted(p for p in (root / BLOBS_DIR).rglob("*") if p.is_file())
        if (root / BLOBS_DIR).exists()
        else []
    )
    components.extend(describe(root, p.relative_to(root).as_posix()) for p in blobs)
    components.extend(describe(root, name) for name in extra)
    return Manifest(
        format=SNAPSHOT_FORMAT,
        created_at=created_at,
        components=tuple(components),
        blob_count=len(blobs),
    )


def write_manifest(root: Path, manifest: Manifest) -> Path:
    target = root / MANIFEST_NAME
    target.write_text(manifest.to_json(), encoding="utf-8")
    return target


def verify_snapshot(root: Path) -> Verification:
    """Check a snapshot before anything is restored from it.

    Fail-closed: an unreadable manifest, an unknown format, a missing component or a checksum mismatch
    all mean "do not restore", and every problem found is reported rather than the first one — an
    operator deciding what to do needs the whole picture.
    """
    problems: list[str] = []
    manifest_path = root / MANIFEST_NAME
    if not manifest_path.is_file():
        return Verification(
            ok=False,
            problems=(
                f"no {MANIFEST_NAME} in {root}: this is not a snapshot this version can verify, and an "
                "unverified snapshot is never activated",
            ),
        )
    try:
        manifest = Manifest.from_json(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, KeyError, TypeError) as exc:
        return Verification(ok=False, problems=(f"unreadable manifest: {exc}",))

    if manifest.format != SNAPSHOT_FORMAT:
        problems.append(
            f"snapshot format {manifest.format} is not supported by this version "
            f"(expected {SNAPSHOT_FORMAT})"
        )
    listed = {component.path for component in manifest.components}
    for required in REQUIRED_COMPONENTS:
        if required not in listed:
            problems.append(f"incomplete snapshot: {required} is not in the manifest")
    for component in manifest.components:
        target = root / component.path
        if not target.is_file():
            problems.append(f"missing component: {component.path}")
            continue
        actual_size = target.stat().st_size
        if actual_size != component.size:
            problems.append(
                f"size mismatch for {component.path}: manifest {component.size}, found {actual_size}"
            )
            continue
        actual = sha256_file(target)
        if actual != component.sha256:
            problems.append(f"checksum mismatch for {component.path}")
    return Verification(ok=not problems, problems=tuple(problems))
