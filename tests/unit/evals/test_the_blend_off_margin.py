"""The instrument reads the product's own verdict, it does not re-derive it (AUDIT-126).

AUDIT-126 left one question open: whether the blend-off margin — where retrieval alone ranked the
passage that ends up justifying the answer — should be measured on every run instead of by hand. The
spec refused the obvious answer in advance: a second reranker-off pass "doubles the model calls for a
diagnostic, which is the same trade-off that made `degradation_of` unreachable (AUDIT-096) — so it
needs a cheaper shape, not more enthusiasm."

`_WatchTheBlend` is that cheaper shape: it wraps the configured reranker and watches the calls
`decide()` already makes, so the margin costs nothing and the product is untouched. The risk it
carries is subtler than a wrong number — it is a number that looks measured. If the instrument
re-implemented the winner rule, the copy would drift from `decide()` (which does NOT simply take the
batch argmax: it confirms candidates one at a time in descending order, AUDIT-120) and the run would
keep printing a confident margin about a passage the product never confirmed.

So these tests assert AGREEMENT, on the branches where the two could disagree: the winner is the
blend's top choice, the winner is further down because the top failed alone, nothing is confirmed at
all, and the confirmation call is unavailable.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest
from evals.gate_run import _WatchTheBlend

from rsc_brain.recall.reranker import RerankerUnavailable, decide

_THRESHOLD = 0.5
_PAGE = ["p0 the distractor", "p1 the answer", "p2 filler"]


class _Scripted:
    """Answers a batch from a table, and each solo confirmation from another."""

    version = "scripted"

    def __init__(
        self,
        batch: Sequence[float | None],
        solo: dict[str, float | None],
        *,
        unavailable: bool = False,
    ) -> None:
        self._batch = list(batch)
        self._solo = solo
        self._unavailable = unavailable
        self.calls: list[int] = []

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        self.calls.append(len(passages))
        if len(passages) > 1:
            return self._batch
        if self._unavailable:
            raise RerankerUnavailable("no route")
        return [self._solo.get(passages[0])]


async def _run(inner: _Scripted) -> tuple[int | None, int | None]:
    """Drive `decide()` through the watcher and return (what the product said, what we observed)."""
    watcher = _WatchTheBlend(inner, _THRESHOLD)
    watcher.begin()
    decision = await decide(watcher, "q", _PAGE, _THRESHOLD)
    return decision.confirmed, watcher.confirmed_rank


async def test_agrees_when_the_blends_top_choice_is_the_one_confirmed() -> None:
    product, observed = await _run(
        _Scripted([0.2, 0.9, 0.1], {"p1 the answer": 0.8}),
    )
    assert product == 1  # the blend's highest score, and it held alone
    assert observed == product


async def test_agrees_when_the_reranker_had_to_reach_past_the_blends_top() -> None:
    """The branch a re-implemented argmax would get wrong."""
    inner = _Scripted([0.95, 0.9, 0.1], {"p0 the distractor": 0.1, "p1 the answer": 0.8})
    product, observed = await _run(inner)
    assert product == 1, "the batch's top candidate did not hold its score alone"
    assert observed == product
    # And it cost nothing extra: one batch call plus the confirmations `decide()` was making anyway.
    assert inner.calls == [3, 1, 1]


async def test_reports_nothing_when_nothing_was_confirmed() -> None:
    product, observed = await _run(_Scripted([0.9, 0.9, 0.1], {}))
    assert product is None
    assert observed is None, "an abstention must not be reported as a margin of 0"


async def test_reports_nothing_when_the_confirmation_could_not_run() -> None:
    """Answered on the batch score (a degradation), so there is no confirmed passage to place."""
    product, observed = await _run(_Scripted([0.9, 0.2, 0.1], {}, unavailable=True))
    assert product is None
    assert observed is None


async def test_a_page_of_one_is_still_a_page() -> None:
    """The first call of a recall is the page even when it holds a single candidate."""
    watcher = _WatchTheBlend(_Scripted([0.9], {"only": 0.8}), _THRESHOLD)
    watcher.begin()
    decision = await decide(watcher, "q", ["only"], _THRESHOLD)
    assert decision.confirmed == 0
    assert watcher.confirmed_rank == 0


@pytest.mark.parametrize("threshold", [0.5, 0.9])
async def test_the_observed_rank_never_disagrees_with_the_product(threshold: float) -> None:
    """Same scripted reranker, two thresholds: whatever the product confirms, the watcher places."""
    inner = _Scripted([0.95, 0.6, 0.1], {"p0 the distractor": 0.4, "p1 the answer": 0.7})
    watcher = _WatchTheBlend(inner, threshold)
    watcher.begin()
    decision = await decide(watcher, "q", _PAGE, threshold)
    assert watcher.confirmed_rank == decision.confirmed
