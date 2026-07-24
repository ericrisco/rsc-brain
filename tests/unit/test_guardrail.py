"""FR-4.4 secondary guardrail (SPEC-20): drops mislabeled fragments, never widens."""

from __future__ import annotations

from collections.abc import Sequence

from rsc_brain.mcp.tools import RecallFragment
from rsc_brain.recall.guardrail import screen_fragments


class FakeClassifier:
    """Classifies a fragment by a stored text→topic map (a stand-in for the cheap model)."""

    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    async def classify(self, text: str, candidate_topics: Sequence[str]) -> str | None:
        return self._mapping.get(text)


def _fragment(text: str, claim_id: str) -> RecallFragment:
    return RecallFragment(text=text, claim_ids=[claim_id], document="d", credibility=0.6)


async def test_drops_only_the_mislabeled_fragment() -> None:
    good = _fragment("hr policy text", "c1")  # classifier says hr (allowed) → kept
    leaked = _fragment("salary figures", "c2")  # classifier says finance (NOT allowed) → dropped
    classifier = FakeClassifier({"hr policy text": "hr", "salary figures": "finance"})

    result = await screen_fragments(
        [good, leaked],
        allowed_topics=frozenset({"hr"}),
        project_topics=["hr", "finance"],
        classifier=classifier,
    )
    assert [f.claim_ids for f in result.kept] == [["c1"]]
    assert [f.claim_ids for f in result.dropped] == [["c2"]]
    assert result.flagged_claim_ids == ["c2"]
    assert not result.clean


async def test_unclassifiable_or_allowed_fragments_are_kept() -> None:
    # None (can't place) and an allowed-topic classification both survive — the guardrail only
    # removes, it never widens or invents.
    a = _fragment("ambiguous", "c1")
    b = _fragment("clearly hr", "c2")
    classifier = FakeClassifier({"clearly hr": "hr"})  # "ambiguous" → None
    result = await screen_fragments(
        [a, b], allowed_topics=frozenset({"hr"}), project_topics=["hr"], classifier=classifier
    )
    assert len(result.kept) == 2 and result.clean
