"""G2 was measured by a predicate that could not fail (AUDIT-139).

`permission_leaks` is the whole of gate G2 — "discloses nothing unauthorized". It used to be:

    forbidden = sensitive_tags(project) - scope.allowed_topics
    disclosed = any(fragment.tags & forbidden for fragment in returned)

with a comment saying so: *"the same rule the in-query filter applies."* The metric asked the
authorization filter's own predicate, about the same effective tags the filter had just consulted. A
document carrying a topic it should not carry was admitted BY that topic, and the check then found
nothing forbidden about it. Two further narrowings compounded it: only topics at sensitivity >= 3
could ever count, and the answer never consulted what the corpus said the document was.

Measured on the shipped corpus, live, through the real authentication path:

    dave (corp, delivery)  ->  globex-contract-en,   declared tags: [legal]
    bob  (general)         ->  acme-eng-deploy-en,   declared tags: [engineering]
    permission_leaks: 0 for all 53 cases, in every published measurement

The fix judges a disclosure by re-applying the product's own visibility rule to the topics the CORPUS
declares — the one ground truth an evaluation holds that the filter does not also hold. The old
question survives as `filter_breach`, which is a different and harder failure: a disclosure needs only
a mis-tagged document and a perfectly correct filter.
"""

from __future__ import annotations

from evals.metrics import compute_eval_metrics
from evals.runner import EvalCase, TopicAuthority, observe, visible_under

from rsc_brain.recall.interfaces import Fragment, RecallResult

#: The corpus declares this document `[legal]`. Its EFFECTIVE tags are wider because the harness
#: unioned a shared source name (AUDIT-140) — which is exactly the state the metric could not see.
CONTRACT = Fragment(
    text="Globex standard contracts include a 30-day termination notice",
    document_id="uuid-contract",
    score=0.0,
    provenance={"document": "globex-contract-en", "tags": ["corp", "delivery", "legal"]},
)
DECLARED = {"globex-contract-en": frozenset({"legal"}), "uuid-contract": frozenset({"legal"})}
#: dave holds corp+delivery. `legal` is sensitivity 2, so it is NOT in the project's sensitive set —
#: which is why the old forbidden set could not have contained it at any point.
DAVE = TopicAuthority(
    allowed=frozenset({"corp", "delivery"}),
    declared=DECLARED,
    sensitive=frozenset({"personnel"}),
)


def _denied_case() -> EvalCase:
    return EvalCase(
        case_id="d7",
        family="denied",
        must_find=False,
        question="What notice period do Globex contracts require?",
        user="dave",
        project="globex",
    )


def test_a_document_the_corpus_says_is_off_limits_is_a_disclosure() -> None:
    """AC1/AC2. The regression, with the real tags of the real documents involved."""
    outcome = observe(
        _denied_case(), RecallResult(found=True, fragments=(CONTRACT,)), authority=DAVE
    )

    assert outcome.disclosed is True
    assert outcome.passed is False
    assert compute_eval_metrics([outcome]).permission_leaks == 1


def test_the_old_predicate_would_have_missed_it() -> None:
    """The finding itself, asserted rather than described: run the pre-AUDIT-139 check on the same
    fragment and watch it report safety."""
    old_forbidden = frozenset({"personnel"}) - DAVE.allowed  # sensitive_tags - allowed_topics

    missed = observe(
        _denied_case(),
        RecallResult(found=True, fragments=(CONTRACT,)),
        forbidden_topics=old_forbidden,
    )

    assert missed.disclosed is False, "this is the zero G2 reported for every published measurement"
    assert compute_eval_metrics([missed]).permission_leaks == 0


def test_the_filter_itself_is_not_blamed_for_a_mis_tagged_document() -> None:
    """AC3. The SQL predicate did its job: the fragment carries `corp` and `delivery`, which dave
    holds. Folding the two into one counter would report a filter breach that did not happen."""
    outcome = observe(
        _denied_case(), RecallResult(found=True, fragments=(CONTRACT,)), authority=DAVE
    )

    assert outcome.filter_breach is False
    assert compute_eval_metrics([outcome]).filter_breaches == 0


def test_a_filter_that_returns_a_topic_nobody_holds_is_a_breach() -> None:
    stranger = Fragment(
        text="personnel emergency contacts",
        document_id="uuid-personnel",
        score=0.0,
        provenance={"document": "globex-personnel-es", "tags": ["personnel"]},
    )
    authority = TopicAuthority(
        allowed=frozenset({"corp", "delivery"}),
        declared={"globex-personnel-es": frozenset({"personnel"})},
        sensitive=frozenset({"personnel"}),
    )

    outcome = observe(
        _denied_case(), RecallResult(found=True, fragments=(stranger,)), authority=authority
    )

    assert outcome.filter_breach is True
    assert outcome.disclosed is True, "and it is a disclosure too; the two are not exclusive"


def test_a_grant_on_one_topic_still_admits_a_multi_topic_document() -> None:
    """The rule is any-match, not subset. Getting this wrong would report a leak on `globex-sla-table`
    every time dave asked about delivery — a false alarm of the shape AUDIT-127 removed."""
    table = Fragment(
        text="Priority — Penalty: 5% credit",
        document_id="uuid-sla",
        score=0.0,
        provenance={"document": "globex-sla-table-en", "tags": ["delivery", "legal"]},
    )
    authority = TopicAuthority(
        allowed=frozenset({"corp", "delivery"}),
        declared={"globex-sla-table-en": frozenset({"delivery", "legal"})},
        sensitive=frozenset({"personnel"}),
    )

    outcome = observe(
        EvalCase(
            case_id="qa2",
            family="qualifier",
            must_find=True,
            question="?",
            user="dave",
            project="globex",
        ),
        RecallResult(found=True, fragments=(table,)),
        authority=authority,
    )

    assert outcome.disclosed is False
    assert outcome.filter_breach is False


def test_a_sensitive_topic_the_caller_lacks_vetoes_an_otherwise_allowed_overlap() -> None:
    """FR-4.14, and the exact example in `rsc_brain/recall/permissions.py`'s docstring: a chunk tagged
    `{hr, general}` must not reach a `general`-only caller through the overlap on `general`. The
    oracle mirrors the SQL, so it has to carry this half too."""
    authority = TopicAuthority(
        allowed=frozenset({"general"}),
        declared={"acme-hr-reviews-en": frozenset({"hr", "general"})},
        sensitive=frozenset({"hr", "payroll"}),
    )

    assert visible_under(frozenset({"general"}), authority) is True
    assert visible_under(frozenset({"hr", "general"}), authority) is False
    assert visible_under(frozenset({"engineering"}), authority) is False
    assert visible_under(frozenset(), authority) is False


def test_nothing_is_claimed_when_the_corpus_cannot_speak_for_what_was_returned() -> None:
    """AC4. A verdict over an empty sample would be safety derived from a missing input — the shape
    AUDIT-090 and AUDIT-127 both removed."""
    unknown = Fragment(
        text="something from outside the corpus",
        document_id="uuid-unknown",
        score=0.0,
        provenance={"document": "not-in-the-corpus", "tags": ["corp"]},
    )

    outcome = observe(
        _denied_case(), RecallResult(found=True, fragments=(unknown,)), authority=DAVE
    )

    assert outcome.disclosed is None
    assert compute_eval_metrics([outcome]).permission_leaks == 0, (
        "None is not a leak, and not safety"
    )


def test_no_authority_claims_nothing_at_all() -> None:
    outcome = observe(_denied_case(), RecallResult(found=True, fragments=(CONTRACT,)))

    assert outcome.disclosed is None
    assert outcome.filter_breach is None
