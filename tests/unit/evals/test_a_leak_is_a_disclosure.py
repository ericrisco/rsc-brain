"""`permission_leaks` must count disclosures, not answers (AUDIT-127).

Measured on a `cpu_only` install — the only cpu_only configuration the product permits, with the
reranker off because it cannot run there (AUDIT-100):

    correct_abstention_rate  0.0
    permission_leaks          11        <- reported
    actual disclosures         0        <- measured against the real forbidden set

Every one of the eleven `denied`/`cross_project` cases returned *something* rather than abstaining,
and not one returned a fragment carrying a topic its principal was not authorized for. The in-query
permission filter holds with or without the reranker, which is the point of putting it in SQL.

So the figure named `permission_leaks` was counting abstention failures as confidentiality breaches.
That is wrong in both directions: it raises a security alarm where there is none, and a real
disclosure among those eleven would not change the number.
"""

from __future__ import annotations

from evals.metrics import compute_eval_metrics
from evals.runner import EvalCase, observe

from rsc_brain.recall.interfaces import Fragment, RecallResult

# Production carries a fragment's topics in its provenance (`retriever._assemble`), so that is where
# a disclosure check has to look.
VISIBLE = Fragment(
    text="Acme was founded in 2015",
    document_id="d1",
    score=0.4,
    provenance={"tags": ["general"]},
)
SENSITIVE = Fragment(
    text="engineering salary band 45000-70000",
    document_id="d2",
    score=0.9,
    provenance={"tags": ["payroll"]},
)


def _denied_case() -> EvalCase:
    return EvalCase(
        case_id="d1",
        family="denied",
        must_find=False,
        question="What are the 2024 salary bands?",
        user="bob",
        project="acme",
    )


def test_answering_with_authorized_content_is_not_a_leak() -> None:
    """It is still a failure — the case must abstain — but it is not a disclosure."""
    result = RecallResult(found=True, fragments=(VISIBLE,))

    outcome = observe(_denied_case(), result, forbidden_topics=frozenset({"hr", "payroll"}))

    assert outcome.passed is False, "answering a denied question is a failure"
    assert outcome.disclosed is False
    assert compute_eval_metrics([outcome]).permission_leaks == 0


def test_returning_a_forbidden_topic_is_a_leak() -> None:
    result = RecallResult(found=True, fragments=(VISIBLE, SENSITIVE))

    outcome = observe(_denied_case(), result, forbidden_topics=frozenset({"hr", "payroll"}))

    assert outcome.passed is False
    assert outcome.disclosed is True
    assert compute_eval_metrics([outcome]).permission_leaks == 1


def test_a_leak_counts_even_when_the_transport_says_not_found() -> None:
    """The stricter rule this metric already had, kept: a fragment is disclosed however it is
    labelled."""
    result = RecallResult(found=False, fragments=(SENSITIVE,))

    outcome = observe(_denied_case(), result, forbidden_topics=frozenset({"payroll"}))

    assert outcome.disclosed is True
    assert compute_eval_metrics([outcome]).permission_leaks == 1


def test_without_a_forbidden_set_nothing_is_claimed() -> None:
    """A caller that cannot say what was forbidden must not have a leak inferred for it — absence of
    the input is not evidence of a breach (AUDIT-090), nor of safety."""
    result = RecallResult(found=True, fragments=(SENSITIVE,))

    outcome = observe(_denied_case(), result)

    assert outcome.passed is False
    assert outcome.disclosed is None
    assert compute_eval_metrics([outcome]).permission_leaks == 0
