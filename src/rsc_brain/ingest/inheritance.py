"""What a chunk's topics become when a curator sets the document's (FR-1.15, AUDIT-143).

FR-1.15 requires that a document's tags reach **all** its chunks, and that per-chunk topicalization
only *adds* granularity to what it inherited. The implementation read that as a union of the chunk's
existing tags with the document's, on every repropagation — and a union cannot narrow.

That matters because narrowing is the whole point of correcting a classification. Visibility is
any-match over **chunk** tags (`recall/permissions.py`), so a stale tag left behind by the union is a
stale audience. Concretely, and reachable through the console today: an `llm_review` document proposes
`[engineering, general]`, the curator approves with `--tags engineering` to keep it off the general
staff's shelf, the document row becomes `[engineering]`, and every chunk stays `[engineering, general]`.
The correction is recorded, reported as applied, and changes nothing about who can read it.

The rule here keeps both halves of FR-1.15 and drops the part it never asked for:

* the document's tags reach every chunk — inheritance, unchanged;
* a tag the chunk carries that the curator did not restate is dropped, UNLESS it is sensitive.

The exception is the one direction that must never be automated: dropping a sensitive tag would remove
an FR-4.14 veto and widen the audience, which is the opposite of what a correction is for. Anything
non-sensitive that the chunk carried beyond the document's tags was, by any-match, only ever *widening*
its audience — so dropping it narrows, which is what was asked.

What is deliberately NOT attempted: distinguishing a tag the chunk inherited from an earlier
classification from one its own topicalization proposed. Nothing records that, and guessing would be
worse than the rule above, which is conservative in the only direction that can leak.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence


def inherited_chunk_tags(
    document_tags: Sequence[str],
    chunk_tags: Iterable[str],
    *,
    sensitive: Iterable[str] = (),
) -> list[str]:
    """The tags a chunk carries after the document's are (re)propagated to it.

    Order is the document's tags first, then any sensitive tag the chunk keeps, so the result is
    deterministic and a diff of two runs is readable.
    """
    protected = frozenset(sensitive)
    kept = [tag for tag in chunk_tags if tag in protected]
    return list(dict.fromkeys([*document_tags, *kept]))
