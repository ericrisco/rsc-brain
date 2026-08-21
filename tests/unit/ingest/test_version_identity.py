"""Pure version-diff rules for AUDIT-014.

These tests pin the part that must stay deterministic before PostgreSQL or a model is involved:
ordered occurrence matching, sentence-level change isolation and canonical claim identity.
"""

from rsc_brain.ingest.version_identity import (
    align_occurrences,
    canonical_claim_key,
    sentence_delta,
)


def test_duplicate_chunk_text_is_matched_one_occurrence_at_a_time() -> None:
    prior = ["intro", "same", "same", "tail"]
    current = ["intro", "same", "changed", "same", "tail"]

    alignment = align_occurrences(prior, current)

    assert [(item.prior_index, item.current_index, item.exact) for item in alignment] == [
        (0, 0, True),
        (1, 1, True),
        (None, 2, False),
        (2, 3, True),
        (3, 4, True),
    ]


def test_replaced_span_is_paired_positionally_without_losing_insertions() -> None:
    alignment = align_occurrences(["a", "old one", "old two", "z"], ["a", "new", "z"])

    assert [(item.prior_index, item.current_index, item.exact) for item in alignment] == [
        (0, 0, True),
        (1, 1, False),
        (2, None, False),
        (3, 2, True),
    ]


def test_sentence_delta_sends_only_changed_sentences_to_extraction() -> None:
    delta = sentence_delta(
        "The SLA is 24 hours. Escalation is owned by Ana. Keep audit logs.",
        "The SLA is 48 hours. Escalation is owned by Ana. Keep audit logs. Notify Luis.",
    )

    assert delta.unchanged == ("Escalation is owned by Ana.", "Keep audit logs.")
    assert delta.removed == ("The SLA is 24 hours.",)
    assert delta.added == ("The SLA is 48 hours.", "Notify Luis.")
    assert delta.extraction_text == "The SLA is 48 hours. Notify Luis."


def test_claim_identity_prefers_structured_triple_and_normalizes_text_fallback() -> None:
    assert canonical_claim_key("Display text", " Acme ", "HAS SLA", " 48 HOURS ") == (
        "triple",
        "acme",
        "has sla",
        "48 hours",
    )
    assert canonical_claim_key("  Audit   logs are kept. ", None, None, None) == (
        "text",
        "audit logs are kept.",
    )
