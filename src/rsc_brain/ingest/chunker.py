"""Semantic prose chunking (FR-1.6): unit-of-meaning, not fixed length, with a per-profile
token ceiling and full provenance (``page``, ``bbox``, ``cut_type``, OCR confidence).

Token counting is an intentional, documented approximation (≈4 characters per token) so the
chunker needs no heavy tokenizer dependency; the ceiling is a soft target enforced hard by
sentence- then word-splitting a passage that would otherwise exceed it.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from rsc_brain.config.models import HardwareProfile
from rsc_brain.ingest.types import ChunkKind, ProposedChunk, ProseBlock

#: Soft token ceiling per hardware profile (FR-1.6, G5). Smaller on CPU-only hosts.
TOKEN_CEILING: dict[HardwareProfile, int] = {
    HardwareProfile.WORKSTATION: 512,
    HardwareProfile.CPU_ONLY: 256,
}

_SENTENCE = re.compile(r"(?<=[.!?。])\s+")
_CHARS_PER_TOKEN = 4


def approx_tokens(text: str) -> int:
    """Approximate token count (documented heuristic; ≈4 chars/token)."""
    return max(1, len(text) // _CHARS_PER_TOKEN)


def _split_to_budget(text: str, ceiling: int) -> list[str]:
    """Split an over-budget passage by sentence, then hard-split any sentence still too long."""
    if approx_tokens(text) <= ceiling:
        return [text]
    pieces: list[str] = []
    buffer = ""
    for sentence in _SENTENCE.split(text):
        candidate = f"{buffer} {sentence}".strip() if buffer else sentence
        if approx_tokens(candidate) <= ceiling:
            buffer = candidate
            continue
        if buffer:
            pieces.append(buffer)
        if approx_tokens(sentence) <= ceiling:
            buffer = sentence
        else:
            # A single sentence exceeds the ceiling: hard-split on a character budget.
            span = ceiling * _CHARS_PER_TOKEN
            pieces.extend(sentence[i : i + span] for i in range(0, len(sentence), span))
            buffer = ""
    if buffer:
        pieces.append(buffer)
    return pieces


def chunk_prose(
    blocks: Sequence[ProseBlock],
    *,
    profile: HardwareProfile = HardwareProfile.WORKSTATION,
    max_tokens: int | None = None,
) -> list[ProposedChunk]:
    """Group prose blocks into semantic chunks under the profile's token ceiling.

    Blocks are grouped by heading; within a heading, consecutive blocks accumulate until adding
    the next would exceed the ceiling. A block that alone exceeds the ceiling is sentence-split.
    Every chunk keeps the provenance of its first source block."""
    ceiling = max_tokens if max_tokens is not None else TOKEN_CEILING[profile]
    chunks: list[ProposedChunk] = []
    current_heading: str | None = None
    group: list[ProseBlock] = []
    # cut_type describes the boundary that STARTED the current group: a new heading section
    # ("heading"), a token-budget split within a section ("paragraph"), or — for pieces of an
    # over-long block — a sentence split ("sentence").
    group_cut = "paragraph"

    def flush() -> None:
        if not group:
            return
        head = group[0]
        body = " ".join(b.text for b in group).strip()
        for index, piece in enumerate(_split_to_budget(body, ceiling)):
            chunks.append(
                ProposedChunk(
                    kind=ChunkKind.PROSE,
                    text=piece,
                    page=head.page,
                    bbox=head.bbox,
                    cut_type=group_cut if index == 0 else "sentence",
                    extraction_confidence=head.extraction_confidence,
                )
            )
        group.clear()

    for block in blocks:
        if not block.text.strip():
            continue
        if block.heading != current_heading:
            flush()
            current_heading = block.heading
            group_cut = "heading"
            group.append(block)
            continue
        provisional = " ".join([*(b.text for b in group), block.text])
        if group and approx_tokens(provisional) > ceiling:
            flush()
            group_cut = "paragraph"
        group.append(block)
    flush()
    return chunks
