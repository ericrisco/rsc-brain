"""AUDIT-096: the degradation recorder AUDIT-085 wrote had no production caller.

AUDIT-085 fixed "the fallback happens without the recording" by writing `degradation_of`, and its
docstring states the stakes exactly:

    A degradation nobody can observe is how this measurement nearly concluded "the reranker does not
    improve G4" about a component that never ran — twice.

It happened twice, the function exists to prevent a third time, and **nothing in `src/` called it**.
Its only two references were lines inside its own docstring; the third was in a unit test.

So the retriever did this:

    verdict = await abstains(...)                 # None when the reranker never ran
    should_abstain = verdict if verdict is not None else scored[0][1] < self._config.tau

An install whose reranker route is down reverts to the blended threshold — the one measured
*incapable* of meeting G4, populations overlapping by -0.032 — and nothing anywhere says so.

**Why the existing test did not catch it.** `test_a_silent_reranker_fallback.py` calls
`degradation_of` directly and asserts it returns a reason. That proves the function works. It cannot
prove anyone calls it, and a helper that works while being unreachable is indistinguishable from one
that is wired in, from the perspective of a test that supplies its own caller.

**Why nobody wired it in, probably.** `degradation_of` re-runs `relevance`. Using it alongside
`abstains` meant two model calls per recall, so the observability path cost double the query it was
observing. That is a design fault, not an oversight by its callers — hence `decide`, which returns
both halves from one call, and the test below that keeps it that way.
"""

from __future__ import annotations

import ast
from collections.abc import Sequence
from pathlib import Path

from rsc_brain.recall.reranker import RerankerUnavailable, decide

SRC = Path(__file__).resolve().parents[3] / "src" / "rsc_brain"
RETRIEVER = SRC / "recall" / "retriever.py"


class _Counting:
    """A reranker that records how many times it is scored, to price the observability path."""

    version = "counting"

    def __init__(self, scores: Sequence[float] | None = None) -> None:
        self.calls = 0
        self._scores = scores

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
        self.calls += 1
        if self._scores is None:
            raise RerankerUnavailable("model 'bge-reranker-v2-m3' not found")
        return list(self._scores)


async def test_the_reason_never_costs_an_extra_call() -> None:
    """The property AUDIT-096 protected, restated precisely after AUDIT-104 changed the cost.

    The original defect was that obtaining the REASON required a second scoring call, so nobody paid
    for it and the reason went unread. That must stay true.

    AUDIT-104 does add a second call — but for a different purpose (confirming the top candidate
    alone, because a batch score turned out not to be a property of the passage) and only on the path
    that ANSWERS. Abstention still costs one call, and the reason is free on both paths. The two are
    separated here so a future change cannot quietly reintroduce a per-reason cost under cover of the
    confirmation.
    """
    abstaining = _Counting([0.1])
    decision = await decide(abstaining, "q", ["a"], 0.5)
    assert decision.abstains is True
    assert abstaining.calls == 1, (
        f"an abstention scored {abstaining.calls} times; refusing is the conservative direction and "
        "needs no second opinion"
    )

    answering = _Counting([0.9])
    decision = await decide(answering, "q", ["a"], 0.5)
    assert decision.abstains is False
    assert decision.degradation is None, "a confirmed answer has nothing to report"
    assert answering.calls == 2, (
        f"answering scored {answering.calls} times; expected the batch plus one confirmation of the "
        "top candidate (AUDIT-104)"
    )


async def test_an_unavailable_reranker_yields_no_verdict_and_a_reason() -> None:
    reranker = _Counting(None)
    decision = await decide(reranker, "q", ["a"], 0.5)
    assert decision.abstains is None, "silence must not be read as either verdict"
    assert decision.degradation is not None
    assert "bge-reranker-v2-m3" in decision.degradation, (
        f"the reason does not name what failed: {decision.degradation!r}"
    )
    assert reranker.calls == 1


async def test_no_candidates_is_a_reason_too() -> None:
    decision = await decide(_Counting([]), "q", [], 0.5)
    assert decision.abstains is None
    assert decision.degradation == "no candidates to score"


def _calls_in(path: Path) -> set[str]:
    """Every function name called anywhere in a module, read from the parsed tree.

    Read from the AST rather than grepped, because four times in this project an over-broad grep
    matched a name inside prose — including the comments that explain this very defect.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            target = node.func
            if isinstance(target, ast.Name):
                names.add(target.id)
            elif isinstance(target, ast.Attribute):
                names.add(target.attr)
    return names


def test_the_retriever_asks_for_the_reason_not_just_the_verdict() -> None:
    """The regression, stated structurally: production code must call the path that produces a
    reason. `abstains` alone cannot, by construction — it returns a bool or None and discards why."""
    called = _calls_in(RETRIEVER)
    assert "decide" in called, (
        "the retriever does not call `decide`, so the abstention it reports carries no trace of "
        "whether the reranker ran — which is what made two G4 measurements uninterpretable"
    )


def test_the_recall_result_can_carry_the_reason() -> None:
    """A reason the retriever computes and cannot return is the same defect one layer out."""
    from rsc_brain.recall.interfaces import RecallResult

    assert "degraded" in RecallResult.__dataclass_fields__, (
        "RecallResult has nowhere to put the degradation, so the retriever can only drop it"
    )
    assert RecallResult(found=True).degraded is None, "the default must mean 'nothing degraded'"


def test_the_reason_producing_helper_is_reachable_from_production() -> None:
    """Closes the class rather than the instance. Any future helper that answers 'why did this
    component not run' must be called by something that ships — otherwise it is documentation with a
    test, which is what `degradation_of` was for as long as it existed."""
    production_calls: set[str] = set()
    for path in SRC.rglob("*.py"):
        production_calls |= _calls_in(path)
    assert production_calls & {"decide", "degradation_of"}, (
        "no shipped module asks why the reranker did not decide; the recorder exists and nothing "
        "reads it, which is the state AUDIT-085 believed it had fixed"
    )
