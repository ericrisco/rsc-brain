"""A curator's downward correction could not take effect (AUDIT-143).

FR-1.15 says a document's tags reach **all** its chunks and that per-chunk topicalization only *adds*
granularity. `propagate_doc_tags` implemented that as a union of the chunk's tags with the document's,
on every repropagation — and a union cannot narrow.

Narrowing is the entire point of correcting a classification. Visibility is any-match over **chunk**
tags (`recall/permissions.py::chunk_visibility_clause`), so a tag the union leaves behind is an
audience the union leaves behind. Reachable through the console today: an `llm_review` document
proposes `[engineering, general]`, the curator approves with `--tags engineering` to keep it off the
general staff's shelf, the document row becomes `[engineering]`, every chunk stays
`[engineering, general]`, and the API answers with the phase it reached. The correction is recorded,
reported as applied, and changes nothing about who can read it.

Neither of those topics is sensitive, which is why the FR-4.14 veto does not save this case. The veto
covers sensitive topics; a correction between two ordinary ones is exactly what it does not cover, and
is the same shape as the leak AUDIT-141 fixed one layer earlier at ingest time.
"""

from __future__ import annotations

from rsc_brain.ingest.inheritance import inherited_chunk_tags

SENSITIVE = frozenset({"hr", "payroll"})


def test_a_stale_tag_the_curator_removed_does_not_survive() -> None:
    """The regression, with the real shape: proposed [engineering, general], corrected to
    [engineering]."""
    result = inherited_chunk_tags(["engineering"], ["engineering", "general"], sensitive=SENSITIVE)

    assert result == ["engineering"]
    assert "general" not in result, (
        "a general-only principal could still read it, and the correction reported success"
    )


def test_the_documents_tags_still_reach_every_chunk() -> None:
    """The half of FR-1.15 that must not change: inheritance."""
    assert inherited_chunk_tags(["finance", "legal"], [], sensitive=SENSITIVE) == [
        "finance",
        "legal",
    ]
    assert inherited_chunk_tags(["finance"], ["engineering"], sensitive=SENSITIVE) == ["finance"]


def test_a_sensitive_tag_the_chunk_carries_is_never_dropped() -> None:
    """The one direction that must never be automated. A `general` handbook with one payroll
    paragraph: the paragraph's `payroll` tag is what the FR-4.14 veto acts on, and dropping it would
    widen the audience — the opposite of what a correction is for."""
    result = inherited_chunk_tags(["general"], ["general", "payroll"], sensitive=SENSITIVE)

    assert result == ["general", "payroll"]


def test_several_sensitive_tags_all_survive_and_the_order_is_stable() -> None:
    result = inherited_chunk_tags(
        ["general"], ["payroll", "engineering", "hr"], sensitive=SENSITIVE
    )

    assert result == ["general", "payroll", "hr"], "document tags first, then what the chunk keeps"


def test_a_caller_that_names_no_sensitive_topics_gets_a_replacement_not_a_union() -> None:
    """The default is the safe direction. A caller that does not know the project's sensitive topics
    must not be silently handed back the union this finding removed — both real callers pass the set."""
    assert inherited_chunk_tags(["general"], ["general", "payroll"]) == ["general"]


def test_repropagating_the_same_tags_is_idempotent() -> None:
    once = inherited_chunk_tags(["general", "hr"], ["general", "hr"], sensitive=SENSITIVE)
    twice = inherited_chunk_tags(["general", "hr"], once, sensitive=SENSITIVE)

    assert once == twice == ["general", "hr"]
