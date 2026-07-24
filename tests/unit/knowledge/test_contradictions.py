"""Pure contradiction candidate selection: cosine + shared-entity gate (FR-5.2)."""

from __future__ import annotations

import pytest

from rsc_brain.knowledge.contradictions import candidate_pairs, cosine_similarity
from rsc_brain.stores.relational.knowledge_store import ClaimData


def _claim(cid: str, subject: str, embedding: tuple[float, ...]) -> ClaimData:
    return ClaimData(
        id=cid,
        text=f"claim {cid}",
        subject=subject,
        object=None,
        credibility=0.5,
        tags=(),
        embedding=embedding,
        valid_to=None,
    )


def test_cosine_similarity() -> None:
    assert cosine_similarity((1.0, 0.0), (1.0, 0.0)) == pytest.approx(1.0)
    assert cosine_similarity((1.0, 0.0), (0.0, 1.0)) == pytest.approx(0.0)
    assert cosine_similarity((0.0, 0.0), (1.0, 1.0)) == 0.0  # zero vector guarded
    assert cosine_similarity((1.0,), (1.0, 0.0)) == 0.0  # dimension mismatch guarded


def test_candidate_requires_both_similarity_and_shared_entity() -> None:
    high = (1.0, 1.0, 0.0)
    a = _claim("a", "Acme SLA", high)
    b = _claim("b", "Acme SLA", high)  # same entity, sim 1.0 → candidate
    c = _claim("c", "Globex SLA", high)  # sim 1.0 but different entity → not a candidate
    d = _claim("d", "Acme SLA", (1.0, 0.0, 0.0))  # same entity but sim 0.71 < 0.75 → not

    pairs = candidate_pairs([a, b, c, d], sim_threshold=0.75)
    ids = {tuple(sorted((x.id, y.id))) for x, y in pairs}
    assert ("a", "b") in ids
    assert ("a", "c") not in ids and ("b", "c") not in ids
    assert ("a", "d") not in ids
