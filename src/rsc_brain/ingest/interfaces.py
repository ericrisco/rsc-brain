"""Frozen public ``ingest`` signatures. Implemented in SPEC-05.

``RawSource`` is a project-owned input (FR-1.13). Every stage takes a
:class:`~rsc_brain.scope.ProjectScope` plus the project-owned object, and must call
:meth:`ProjectScope.require_object` **before** any parsing, model call, or write, so a source
from project A can never be processed under project B (AUDIT-003).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from rsc_brain.scope import ProjectScope


@dataclass(frozen=True, slots=True)
class RawSource:
    """A project-owned ingestion input, deduplicated by checksum per project."""

    project_id: str
    source_id: str
    uri: str
    checksum: str


@dataclass(frozen=True, slots=True)
class IngestReceipt:
    """Result of accepting a source for ingestion."""

    source_id: str
    accepted: bool
    duplicate: bool = False


class Ingestor(Protocol):
    """Entry point of the ingestion pipeline (queued stages: SPEC-05)."""

    async def ingest(self, scope: ProjectScope, source: RawSource) -> IngestReceipt:
        """Accept ``source`` for ingestion within ``scope``; reject cross-project sources."""
        ...
