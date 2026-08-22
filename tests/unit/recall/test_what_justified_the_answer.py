"""What justified answering must be what the caller sees (AUDIT-124).

The reranker decides only *whether* to answer (FR-3.3); the blend decides order (FR-3.2). Two
judgements, and neither carried into the other — so a query could answer `found=true` while returning
fragments the reranker had scored 0.1, and the passage that justified answering need not be returned
at all.

Measured on the corpus: "¿Cuál es la tarifa por hora vigente de Globex?" answered and returned
contract terms, delivery methodology, the head office, "advises on digital transformation" and an SLA
tier. The rate document was not among them. A confident answer assembled from evidence that does not
contain it.
"""

from __future__ import annotations

from collections.abc import Sequence

from rsc_brain.recall.reranker import decide


class _OnlyTheThird:
    """The batch likes two impostors; only the third passage holds its score alone."""

    version = "only-the-third"

    def __init__(self, answer: str) -> None:
        self._answer = answer

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        if len(passages) == 1:
            return [0.95 if passages[0] == self._answer else 0.0]
        return [0.9 if p != self._answer else 0.7 for p in passages]


async def test_the_decision_names_the_passage_it_confirmed() -> None:
    """A verdict that does not say WHICH passage carried it cannot be honoured downstream."""
    answer = "the rate is 120 EUR per hour"
    passages = ["contract terms", "delivery methodology", answer]

    decision = await decide(_OnlyTheThird(answer), "what is the rate?", passages, 0.5)

    assert decision.abstains is False
    assert decision.confirmed == 2, "the index of the passage that held its score alone"


async def test_the_decision_carries_the_scores_it_judged_on() -> None:
    """The caller has to be able to drop what the reranker refused, so it needs the scores."""
    answer = "the rate is 120 EUR per hour"
    passages = ["contract terms", answer]

    decision = await decide(_OnlyTheThird(answer), "what is the rate?", passages, 0.5)

    assert decision.scores is not None
    assert len(decision.scores) == len(passages)


async def test_an_abstention_names_no_passage() -> None:
    class _NothingHolds:
        version = "nothing-holds"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            return [0.0] if len(passages) == 1 else [0.9 for _ in passages]

    decision = await decide(_NothingHolds(), "q", ["a", "b"], 0.5)

    assert decision.abstains is True
    assert decision.confirmed is None
