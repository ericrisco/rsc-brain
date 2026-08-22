"""A `rerank_api` route on the chat route's threshold refuses everything (AUDIT-131).

Measured — a real cross-encoder (`BAAI/bge-reranker-v2-m3`, 568M) on **CPU**, 8 threads:

    load 50.5 s (once)   10 passages: 0.84 s cold, 0.19 s warm
    "What is Acme's marketing budget?" (absent)  -> all ten scores 0.0-0.033
    "What was the Acme support SLA as of 2023-06-01?" -> answer 0.34, sibling 0.003

Against the chat reranker's 142-256 s on the same profile, that is a factor of ~750-1300 and better
discrimination. So `cpu_only` **can** refuse — through this route.

But the scale is different. `tau_rerank` defaults to 0.5, calibrated for a chat model whose answers sit
at 0.9-1.0. The cross-encoder's own answer scored **0.34**. An operator who switches
`reranker.kind: rerank_api` and leaves the threshold alone gets an install that abstains from
everything — the exact mirror of AUDIT-085, where the switch read as on and the capability never ran.
"""

from __future__ import annotations

from rsc_brain.config.models import RecallConfig, RerankerKind
from rsc_brain.installer.verify import _check_rerank_threshold_is_calibrated


def test_the_default_threshold_is_flagged_for_the_rerank_route() -> None:
    check = _check_rerank_threshold_is_calibrated(
        RerankerKind.RERANK_API, reranker_enabled=True, recall=RecallConfig()
    )

    assert check is not None
    assert check.ok is False
    assert "tau_rerank" in check.detail
    assert "0.34" in check.detail, "the measurement, so the operator can pick a number"


def test_an_explicit_threshold_is_accepted() -> None:
    check = _check_rerank_threshold_is_calibrated(
        RerankerKind.RERANK_API, reranker_enabled=True, recall=RecallConfig(tau_rerank=0.1)
    )

    assert check is None


def test_the_chat_route_is_untouched() -> None:
    """The default was measured FOR the chat route; flagging it there would be noise."""
    assert (
        _check_rerank_threshold_is_calibrated(
            RerankerKind.CHAT, reranker_enabled=True, recall=RecallConfig()
        )
        is None
    )


def test_a_disabled_reranker_is_not_flagged() -> None:
    assert (
        _check_rerank_threshold_is_calibrated(
            RerankerKind.RERANK_API, reranker_enabled=False, recall=RecallConfig()
        )
        is None
    )
