"""Secondary permission guardrail (SPEC-20, FR-4.4) — defense in depth over the FINAL context.

The primary permission filter is deterministic and in-query (FR-4.2). This second pass guards
against **mistopicalized** content: a cheap classifier looks at each already-authorized fragment
and, if its actual content belongs to a topic the caller is NOT allowed, the fragment is **dropped**
from the response, the admin is alerted, and its chunk is marked ``needs_review``. It can only
**remove** — it never widens visibility, and the deterministic filter remains the primary gate.

The classifier is an injectable :class:`Protocol` (a cheap gateway capability in production, a fake
in tests); a live model run is blocked-by-resource in CI.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from rsc_brain.mcp.tools import RecallFragment


class TopicClassifier(Protocol):
    async def classify(self, text: str, candidate_topics: Sequence[str]) -> str | None:
        """The single topic ``text`` most belongs to (from ``candidate_topics``), or None."""
        ...


@dataclass(frozen=True, slots=True)
class GuardrailResult:
    kept: list[RecallFragment]
    dropped: list[RecallFragment] = field(default_factory=list)
    flagged_claim_ids: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.dropped


async def screen_fragments(
    fragments: Sequence[RecallFragment],
    *,
    allowed_topics: frozenset[str],
    project_topics: Sequence[str],
    classifier: TopicClassifier,
) -> GuardrailResult:
    """Drop any fragment whose classified topic is outside ``allowed_topics`` (mislabeled leak).
    A fragment the classifier can't place (None) or that lands on an allowed topic is kept."""
    kept: list[RecallFragment] = []
    dropped: list[RecallFragment] = []
    flagged: list[str] = []
    candidates = list(project_topics)
    for fragment in fragments:
        predicted = await classifier.classify(fragment.text, candidates)
        if predicted is not None and predicted not in allowed_topics:
            dropped.append(fragment)
            flagged.extend(fragment.claim_ids)
        else:
            kept.append(fragment)
    return GuardrailResult(kept=kept, dropped=dropped, flagged_claim_ids=flagged)
