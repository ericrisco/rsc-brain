"""Watched-folder ingestion source (FR-1.1/12.6).

The inbox layout is ``inbox/<project>/<source>/<file>``; a file placed directly under a project
folder maps to that project's ``default`` source. :func:`scan_inbox` is a pure mapping (time is
injected) so it is unit-tested deterministically; :func:`watch` is the thin poll loop that
debounces by modification-time settle and hands each new file to a handler. Polling (no OS file
events) keeps the watcher dependency-free; event-based watching is a v2 optimization.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SOURCE = "default"


@dataclass(frozen=True, slots=True)
class InboxItem:
    project_slug: str
    source_name: str
    path: Path


def scan_inbox(
    root: Path, *, settle_seconds: float = 0.0, now: float | None = None
) -> list[InboxItem]:
    """Map an inbox tree to ``InboxItem``s. Files modified within ``settle_seconds`` of ``now``
    are skipped (debounce), so a partially-written upload is not ingested mid-write."""
    if not root.is_dir():
        return []
    items: list[InboxItem] = []
    for project_dir in sorted(root.iterdir()):
        if not project_dir.is_dir():
            continue
        project = project_dir.name
        for entry in sorted(project_dir.iterdir()):
            if entry.is_dir():
                items.extend(
                    _files_in(entry, project, entry.name, settle_seconds=settle_seconds, now=now)
                )
            elif entry.is_file() and _settled(entry, settle_seconds, now):
                items.append(InboxItem(project, DEFAULT_SOURCE, entry))
    return items


def _files_in(
    directory: Path, project: str, source: str, *, settle_seconds: float, now: float | None
) -> list[InboxItem]:
    items: list[InboxItem] = []
    for path in sorted(directory.rglob("*")):
        if path.is_file() and _settled(path, settle_seconds, now):
            items.append(InboxItem(project, source, path))
    return items


def _settled(path: Path, settle_seconds: float, now: float | None) -> bool:
    if now is None or settle_seconds <= 0:
        return True
    return (now - path.stat().st_mtime) >= settle_seconds


async def watch(
    root: Path,
    handler: Callable[[InboxItem], Awaitable[None]],
    *,
    interval: float = 2.0,
    settle_seconds: float = 1.0,
) -> None:  # pragma: no cover - long-running loop exercised operationally, not in CI
    """Poll ``root`` forever, handing each newly-settled file to ``handler`` exactly once."""
    seen: set[tuple[str, float]] = set()
    while True:
        now = time.time()
        for item in scan_inbox(root, settle_seconds=settle_seconds, now=now):
            key = (str(item.path), item.path.stat().st_mtime)
            if key in seen:
                continue
            seen.add(key)
            await handler(item)
        await asyncio.sleep(interval)
