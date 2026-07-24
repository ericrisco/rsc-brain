"""Semantic chunking (FR-1.6): token ceiling honored, provenance preserved, long text split."""

from __future__ import annotations

from rsc_brain.config.models import HardwareProfile
from rsc_brain.ingest.chunker import approx_tokens, chunk_prose
from rsc_brain.ingest.types import ProseBlock


def test_provenance_is_preserved() -> None:
    blocks = [
        ProseBlock(text="Intro paragraph.", page=3, heading="Overview", extraction_confidence=0.7)
    ]
    chunks = chunk_prose(blocks, profile=HardwareProfile.WORKSTATION)
    assert len(chunks) == 1
    assert chunks[0].page == 3
    assert chunks[0].extraction_confidence == 0.7
    assert chunks[0].cut_type == "heading"


def test_no_chunk_exceeds_the_profile_ceiling() -> None:
    long_text = ". ".join(f"sentence number {i} with some words" for i in range(400))
    blocks = [ProseBlock(text=long_text, heading="Body")]
    chunks = chunk_prose(blocks, profile=HardwareProfile.CPU_ONLY)
    ceiling = 256
    assert len(chunks) > 1
    assert all(approx_tokens(c.text) <= ceiling for c in chunks)


def test_new_heading_starts_a_new_chunk() -> None:
    blocks = [
        ProseBlock(text="A.", heading="One"),
        ProseBlock(text="B.", heading="Two"),
    ]
    chunks = chunk_prose(blocks, profile=HardwareProfile.WORKSTATION)
    assert len(chunks) == 2


def test_blank_blocks_are_ignored() -> None:
    chunks = chunk_prose([ProseBlock(text="   ")], profile=HardwareProfile.WORKSTATION)
    assert chunks == []
