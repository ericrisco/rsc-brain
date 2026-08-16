"""AUDIT-089: `brain docs review` said the queue was empty when it was merely blind.

Measured on a real host. Same project, same moment, two surfaces:

    GET /api/v1/admin/documents/pending   ->  1 document, "04-prompt-injection", tags [hr, payroll]
    brain docs review --project globex    ->  "review queue empty"

`brain status --project globex` listed that document's run, so the CLI was addressing the right
project. The difference is authority: `list_documents_by_status` filters the approval queue by the
caller's topic authority **in-query** — its docstring says so, and it is right to, because a queue
entry's title and proposed tags *are* topic-scoped content (R01). The CLI principal holds no topic
grants, so any pending document carrying a topic is invisible to it.

The filtering is correct. The sentence is not. "review queue empty" is a claim about the world;
what the command actually knows is a fact about itself. And the document it hid was a
**prompt-injection document that the topicalizer had correctly tagged `hr` + `payroll`** — the
single item in the human approval gate, and the one that most needed a human. An operator working
from the CLI is told there is nothing to review.

The fix must not widen the CLI's authority: that would void R01 and turn shell access on the box
into universal read. It states a fact about the caller instead, which leaks nothing about the
corpus and so leaves FR-4.3 (denied ≡ non-existent) intact — it never reveals whether anything is
hidden, only what this caller can hold.
"""

from __future__ import annotations

import re

from rsc_brain.cli.ingest import _CLI_TOPICS, _cli_scope, _empty_queue_message


def test_the_cli_never_claims_the_queue_is_empty() -> None:
    """The exact wording that misled an operator must not come back."""
    message = _empty_queue_message().lower()
    assert "queue empty" not in message, (
        "the command still asserts emptiness, which it cannot know: a topic-filtered queue looks "
        "identical to an empty one"
    )
    assert "empty" not in message.split("—")[0], (
        "the leading clause still reads as a claim about the world rather than about the caller"
    )


def test_the_message_names_the_reason_the_caller_sees_nothing() -> None:
    """An operator must be able to act on it: the next step is a scoped token, not a shrug."""
    message = _empty_queue_message().lower()
    assert "topic" in message, "the message does not say that topic authority is what filters"
    assert "token" in message or "member" in message, (
        "the message does not tell the operator how to see the documents they are missing"
    )


def test_the_message_never_reveals_whether_anything_is_hidden() -> None:
    """FR-4.3: denied ≡ non-existent. A count of hidden documents would leak their existence."""
    message = _empty_queue_message()
    for leak in ("hidden", "there are", "documents exist", "withheld"):
        assert leak not in message.lower(), f"the message leaks corpus state: {leak!r}"

    # A *count* is the leak, not any digit: the message legitimately cites requirement ids like
    # R01. Strip those references first, then no number may remain — an over-broad digit test is
    # the same mistake as the greps that flagged their own explanatory comments.
    without_references = re.sub(r"\b(?:R|FR|AUDIT)[-\d.]*\d", "", message)
    assert not any(character.isdigit() for character in without_references), (
        "the message carries a number, which for a topic-filtered queue is a count of what the "
        f"caller may not see: {without_references!r}"
    )


def test_the_cli_holds_no_topic_authority() -> None:
    """R01/AUDIT-020: no role — and no amount of shell access — implies authority over a topic.

    This is the assertion that keeps the fix honest. The cheap way to make the queue non-empty
    would have been to grant the CLI every topic; that would hand the box's root account universal
    read over every project's most sensitive content.
    """
    assert not _CLI_TOPICS, (
        "the CLI principal was given topic authority; a local shell is not a grant"
    )
    assert _cli_scope("project-1").allowed_topics == frozenset()


def test_the_scope_states_its_authority_explicitly() -> None:
    """The empty set is now a declared decision rather than a constructor default nobody read.

    An unstated default is how this went unnoticed: the scope carried no topics because nobody
    passed any, not because anyone decided it should.
    """
    scope = _cli_scope("project-1")
    assert scope.principal_id == "cli"
    assert scope.can_curate is True, "curation authority is separate from topic authority (R03)"
