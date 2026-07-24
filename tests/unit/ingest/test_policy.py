"""D13 policy → lifecycle status resolution (§4.10.2)."""

from __future__ import annotations

from rsc_brain.ingest.pipeline import _resolve_status
from rsc_brain.ingest.types import DocStatus, SourcePolicy

SENSITIVE = {"hr"}


def test_manual_always_pending() -> None:
    assert (
        _resolve_status(SourcePolicy.MANUAL, ["general"], SENSITIVE, review_if_sensitive=True)
        is DocStatus.PENDING_APPROVAL
    )


def test_source_tags_auto_approves() -> None:
    assert (
        _resolve_status(SourcePolicy.SOURCE_TAGS, ["general"], SENSITIVE, review_if_sensitive=True)
        is DocStatus.AUTO_APPROVED
    )


def test_llm_review_always_pending() -> None:
    assert (
        _resolve_status(SourcePolicy.LLM_REVIEW, ["general"], SENSITIVE, review_if_sensitive=False)
        is DocStatus.PENDING_APPROVAL
    )


def test_llm_auto_when_no_sensitive_tag() -> None:
    assert (
        _resolve_status(SourcePolicy.LLM, ["general"], SENSITIVE, review_if_sensitive=True)
        is DocStatus.AUTO_APPROVED
    )


def test_llm_holds_when_sensitive_tag_and_review_on() -> None:
    assert (
        _resolve_status(SourcePolicy.LLM, ["general", "hr"], SENSITIVE, review_if_sensitive=True)
        is DocStatus.PENDING_APPROVAL
    )


def test_llm_auto_when_sensitive_but_review_off() -> None:
    assert (
        _resolve_status(SourcePolicy.LLM, ["hr"], SENSITIVE, review_if_sensitive=False)
        is DocStatus.AUTO_APPROVED
    )
