"""AUDIT-085: the reranker's default route cannot serve the shipped implementation, and falling
back to the blended threshold was invisible.

Found by measuring. With `reranker.enabled` finally reaching the container (AUDIT-084), G4 measured
0/8 again — because the default route is `bge-reranker-v2-m3`, which the host does not serve, and
which could not serve this implementation even if it did: it is a **cross-encoder**, and `LlmReranker`
calls `complete_structured`, which needs a chat model. No adapter for a rerank API exists.

So an operator who enables the reranker with the shipped defaults gets:

    reranker.enabled = True        the switch is on
    every call fails               RerankerUnavailable
    abstention silently unchanged  the blended threshold, exactly as before

Abstention *appears* to be on and is not. That is the AUDIT-058 family — a shipped default that
cannot work (there, an embedder returning 768 dimensions against a 1024 anchor).

The second half is mine. My own spec says the fallback happens "and the degradation is recorded",
and I implemented the fallback without the recording. A degradation nobody can observe is how this
measurement nearly concluded "the reranker does not improve G4" about a component that never ran —
twice.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import yaml

from rsc_brain.recall.reranker import RerankerUnavailable, degradation_of

REPO = Path(__file__).resolve().parents[3]


def _default_of(interpolation: str) -> str:
    """The `:-default` half of a compose interpolation, which is the value an operator gets."""
    return interpolation.split(":-", 1)[1].rstrip("}") if ":-" in interpolation else interpolation


class _Broken:
    version = "broken"

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
        raise RerankerUnavailable("model 'bge-reranker-v2-m3' not found")


class _Working:
    version = "working"

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
        return [0.1] * len(passages)


async def test_a_fallback_is_reported_not_swallowed() -> None:
    """The operator must be able to tell 'abstention is on' from 'abstention silently is not'."""
    reason = await degradation_of(_Broken(), "q", ["a"])
    assert reason is not None, "the fallback left no trace, so an install cannot tell it happened"
    assert "bge-reranker-v2-m3" in reason, f"the reason does not name what failed: {reason!r}"


async def test_a_working_reranker_reports_no_degradation() -> None:
    assert await degradation_of(_Working(), "q", ["a"]) is None


def test_the_shipped_default_route_can_serve_the_shipped_implementation() -> None:
    """`LlmReranker` calls `complete_structured`, so the default must be a chat model. A
    cross-encoder name here means every install that enables the capability falls back silently."""
    compose = yaml.safe_load(
        (REPO / "deploy" / "docker-compose.prod.yml").read_text(encoding="utf-8")
    )
    shared = next(
        v
        for k, v in compose.items()
        if k.startswith("x-") and isinstance(v, dict) and "RSC_BRAIN_DATABASE__DSN" in v
    )
    # Only the DEFAULT VALUE, never the whole interpolation: the variable NAME contains "reranker",
    # so a substring test over the whole string flags a correct default. Same over-broad grep the
    # AUDIT-083 comment tripped in the Dockerfile test.
    model = _default_of(str(shared["RSC_BRAIN_CAPABILITIES__RERANKER__MODEL"]))
    assert "reranker" not in model.lower(), (
        f"the default route is {model!r}, a cross-encoder. The only implementation is LLM-based and "
        "calls complete_structured, so this default cannot work — abstention would appear enabled "
        "and silently fall back on every query"
    )


def test_the_chart_default_matches_the_compose_default() -> None:
    values = yaml.safe_load(
        (REPO / "deploy" / "helm" / "rsc-brain" / "values.yaml").read_text(encoding="utf-8")
    )
    compose = yaml.safe_load(
        (REPO / "deploy" / "docker-compose.prod.yml").read_text(encoding="utf-8")
    )
    shared = next(
        v
        for k, v in compose.items()
        if k.startswith("x-") and isinstance(v, dict) and "RSC_BRAIN_DATABASE__DSN" in v
    )
    chart_model = str(values["gateway"]["reranker"]["model"]).strip()
    compose_model = _default_of(str(shared["RSC_BRAIN_CAPABILITIES__RERANKER__MODEL"]))
    # The chart targets larger hardware than the compose default, so the models differ on purpose —
    # what must not differ is whether the route can serve the implementation at all.
    assert "reranker" not in chart_model.lower(), (
        f"the chart ships {chart_model!r}, a cross-encoder, while compose ships {compose_model!r}: "
        "the same operator decision would silently fall back on one topology and work on the other"
    )
