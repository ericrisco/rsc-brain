"""The degradation reason must reach the caller, not just exist (AUDIT-121).

AUDIT-084 found a reranker that never ran. AUDIT-085 found the fallback it silently used. AUDIT-096
found that the recorder of that fallback had no production caller, and fixed it by giving
`RecallResult` a `degraded` field the retriever fills.

Then it stopped. `grep -rn "\\.degraded" src/` outside the module that defines it returns nothing:
the reason is produced, stored on a dataclass, and read by no one. `RecallOutput` — the shape that
actually crosses to Claude and ChatGPT — has `found`, `fragments` and `gap_registered`, and no way to
say "this abstention came from the blended threshold because the reranker was unreachable".

The intent was never in doubt; `test_reranked_abstention.py` says it in as many words: *"The caller
learns it degraded; the user still gets an answer."* This is the field that makes that true.
"""

from __future__ import annotations

from rsc_brain.mcp.tools import to_recall_output
from rsc_brain.recall.interfaces import Fragment, RecallResult

REASON = "reranker unavailable, abstention fell back to the blended threshold: provider unreachable"


def test_an_abstention_carries_its_reason_across_the_boundary() -> None:
    result = RecallResult(found=False, fragments=(), gap_registered=True, degraded=REASON)

    output = to_recall_output(result)

    assert output.found is False
    assert output.degraded == REASON


def test_an_answer_carries_its_reason_too() -> None:
    """A degraded ANSWER matters as much: it says the verdict rests on the batch score alone."""
    fragment = Fragment(text="Production runs on PostgreSQL 16", document_id="d1", score=0.9)
    result = RecallResult(found=True, fragments=(fragment,), degraded=REASON)

    output = to_recall_output(result)

    assert output.found is True
    assert output.degraded == REASON


def test_an_undegraded_result_says_nothing() -> None:
    """Absence has to stay distinguishable from a reason, or the field means nothing (AUDIT-090)."""
    result = RecallResult(found=True, fragments=(), degraded=None)

    assert to_recall_output(result).degraded is None
