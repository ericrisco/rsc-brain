"""Frozen public ``recall`` signatures. Implemented in SPEC-06 (temporal params: SPEC-13/17).

The retriever takes a :class:`~rsc_brain.scope.ProjectScope` and **never** a bare
``project_id`` (AUDIT-003, closing prior finding F-005). The project a query runs against is
whatever the authenticated identity is scoped to — it cannot be rebound by the caller.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

from rsc_brain.scope import ProjectScope


@dataclass(frozen=True, slots=True)
class Fragment:
    """A retrieved fragment with provenance. Treated as untrusted data (FR-14.8)."""

    text: str
    document_id: str
    score: float
    provenance: Mapping[str, object] = field(default_factory=dict)
    valid_from: date | None = None
    valid_to: date | None = None
    is_current: bool = True
    # R24: this claim is contested (an unresolved contradiction, or a correction under review). A
    # consumer that cannot see it cannot tell a disputed fact from a settled one.
    disputed: bool = False
    untrusted_data: bool = True


@dataclass(frozen=True, slots=True)
class RecallResult:
    """Outcome of a recall. When ``found`` is false a gap may have been registered (FR-3.3)."""

    found: bool
    fragments: tuple[Fragment, ...] = ()
    gap_registered: bool = False


class Retriever(Protocol):
    """Permission-aware retrieval scoped to the authenticated identity's project."""

    async def recall(
        self,
        scope: ProjectScope,
        query: str,
        *,
        as_of: date | None = None,
        include_historical: bool = False,
        include_superseded: bool = False,
    ) -> RecallResult:
        """Retrieve fragments for ``query`` within ``scope``; abstain below τ (FR-3.2/3.3)."""
        ...
