"""The gate instrument cannot measure a reranker the product would not serve (AUDIT-134).

`reranker.kind` has had two honest call sites and one silent one. `api/app.py` chose the
implementation from it, and so did `evals.gate_run._calibrate` — but `_measure`, the function that
produces the G2/G4 gate numbers, constructed `LlmReranker` unconditionally.

That does not crash. It means an install configured for `rerank_api` could calibrate `tau_rerank` on
its cross-encoder's scale — a genuinely different scale, measured in AUDIT-131 as 0.34 where a chat
model says 0.95 — and then have its gates measured by the chat route against that threshold. Every
abstention decision shifts, and the run reports a number shaped exactly like a gate result. It is the
AUDIT-112 failure again: a seam that one composition path honours and another quietly ignores.

So there is now one selector, `recall.reranker.reranker_for`, and these tests assert that the
instrument and the product resolve to the same implementation for every configuration rather than
merely agreeing today.
"""

from __future__ import annotations

import inspect

import pytest

from rsc_brain.config.models import RerankerKind
from rsc_brain.recall.reranker import LlmReranker, RerankApiReranker, reranker_for


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        (RerankerKind.CHAT, LlmReranker),
        (RerankerKind.RERANK_API, RerankApiReranker),
        (None, LlmReranker),
    ],
)
def test_the_kind_decides_the_implementation(kind: RerankerKind | None, expected: type) -> None:
    chosen = reranker_for(object(), enabled=True, kind=kind)  # type: ignore[arg-type]
    assert isinstance(chosen, expected)


@pytest.mark.parametrize("kind", [RerankerKind.CHAT, RerankerKind.RERANK_API, None])
def test_not_opted_in_means_no_reranker_whatever_the_kind(kind: RerankerKind | None) -> None:
    """`enabled=False` takes the blended path with nothing added, for every kind."""
    assert reranker_for(object(), enabled=False, kind=kind) is None  # type: ignore[arg-type]


def test_neither_the_product_nor_the_instrument_names_an_implementation_directly() -> None:
    """The guard that keeps this fixed: choosing again anywhere is choosing differently later.

    AUDIT-134 happened because the branch was written three times and one copy fell behind. A test
    that only checked `reranker_for`'s output would still pass with `_measure` back to constructing
    `LlmReranker` itself, so this asserts the *call sites* delegate instead.
    """
    import evals.gate_run as gate_run

    import rsc_brain.api.app as app

    for module in (app, gate_run):
        source = inspect.getsource(module)
        for construction in ("LlmReranker(", "RerankApiReranker("):
            assert construction not in source, (
                f"{module.__name__} constructs {construction[:-1]} directly; ask reranker_for() "
                "instead, or the instrument and the product will drift apart again"
            )
        assert "reranker_for(" in source, f"{module.__name__} no longer asks for the configured one"
