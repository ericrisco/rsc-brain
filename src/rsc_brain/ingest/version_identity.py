"""Deterministic identity and diff primitives for document revisions (AUDIT-014).

The model is deliberately absent from this module.  Given the same two revisions these helpers
must always choose the same occurrence pairing, extraction input and claim key, including when a
document repeats the same chunk text more than once.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
type ClaimKey = tuple[str, ...]


@dataclass(frozen=True, slots=True)
class OccurrenceAlignment:
    """One ordered position in the alignment of two chunk sequences."""

    prior_index: int | None
    current_index: int | None
    exact: bool


@dataclass(frozen=True, slots=True)
class SentenceDelta:
    """Sentence-level material retained, removed and newly requiring extraction."""

    unchanged: tuple[str, ...]
    removed: tuple[str, ...]
    added: tuple[str, ...]

    @property
    def extraction_text(self) -> str:
        return " ".join(self.added)


def normalize_identity(value: str) -> str:
    """Stable, Unicode-aware comparison form without changing persisted display text."""

    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def canonical_claim_key(
    text: str,
    subject: str | None,
    predicate: str | None,
    object_: str | None,
) -> ClaimKey:
    """Identity for a claim: a complete triple when available, normalized text otherwise."""

    if subject and predicate and object_:
        return (
            "triple",
            normalize_identity(subject),
            normalize_identity(predicate),
            normalize_identity(object_),
        )
    return ("text", normalize_identity(text))


def align_occurrences(prior: list[str], current: list[str]) -> list[OccurrenceAlignment]:
    """Align ordered occurrences, preserving multiplicity and pairing replacements positionally.

    ``SequenceMatcher`` tracks positions rather than set membership, so repeated text is consumed
    once per occurrence. Unequal replacement spans are zipped by position and their excess is
    emitted as explicit insertion/deletion entries.
    """

    matcher = SequenceMatcher(
        None,
        [normalize_identity(value) for value in prior],
        [normalize_identity(value) for value in current],
        autojunk=False,
    )
    result: list[OccurrenceAlignment] = []
    for opcode, prior_start, prior_end, current_start, current_end in matcher.get_opcodes():
        if opcode == "equal":
            result.extend(
                OccurrenceAlignment(p, c, True)
                for p, c in zip(
                    range(prior_start, prior_end), range(current_start, current_end), strict=True
                )
            )
            continue
        if opcode == "delete":
            result.extend(
                OccurrenceAlignment(p, None, False) for p in range(prior_start, prior_end)
            )
            continue
        if opcode == "insert":
            result.extend(
                OccurrenceAlignment(None, c, False) for c in range(current_start, current_end)
            )
            continue

        prior_indexes = list(range(prior_start, prior_end))
        current_indexes = list(range(current_start, current_end))
        paired = min(len(prior_indexes), len(current_indexes))
        result.extend(
            OccurrenceAlignment(prior_indexes[index], current_indexes[index], False)
            for index in range(paired)
        )
        result.extend(OccurrenceAlignment(p, None, False) for p in prior_indexes[paired:])
        result.extend(OccurrenceAlignment(None, c, False) for c in current_indexes[paired:])
    return result


def _sentences(text: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_BOUNDARY.split(text.strip()) if part.strip()]


def sentence_delta(prior: str, current: str) -> SentenceDelta:
    """Return an ordered sentence diff and the smallest deterministic extractor payload."""

    old = _sentences(prior)
    new = _sentences(current)
    matcher = SequenceMatcher(
        None,
        [normalize_identity(value) for value in old],
        [normalize_identity(value) for value in new],
        autojunk=False,
    )
    unchanged: list[str] = []
    removed: list[str] = []
    added: list[str] = []
    for opcode, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if opcode == "equal":
            unchanged.extend(new[new_start:new_end])
        if opcode in {"replace", "delete"}:
            removed.extend(old[old_start:old_end])
        if opcode in {"replace", "insert"}:
            added.extend(new[new_start:new_end])
    return SentenceDelta(tuple(unchanged), tuple(removed), tuple(added))
