"""The `tau_rerank` sweep no longer fits on the cases the gates report (AUDIT-136).

`_calibrate` used to build its sweep from `golden.yaml` — the same file `_measure` scores. For one
family the overlap was total: every `abstain` case was in the sweep, and `abstain` is exactly what
`_measure` prints as "G4 (abstain family)". So the product's headline promise, "says *I don't have
that*", was certified by a number fitted on the cases it was reported over.

AUDIT-135 made that visible and this replaces it with a split: the sweep reads
`evals/rerank_calibration.yaml`, and disjointness from `golden.yaml` is COMPUTED (`evals.holdout`)
rather than promised — by id, by question, and by reworded near-duplicate. The old test asserted the
disclosure kept being printed; these assert the overlap is gone and cannot come back silently.

What a split does not buy, and what the sweep's own output therefore states: both corpora run over
the same 27 documents (a threshold has to be fitted on the score distribution the install will serve,
so swapping the corpus would fit it to the wrong one) and one person wrote both.
"""

from __future__ import annotations

import inspect

import pytest
import yaml
from evals.gate_run import _calibrate, _load
from evals.holdout import NEAR_DUPLICATE_JACCARD, holdout_report, jaccard, normalize_question
from evals.schema import Golden, RerankCalibration, RerankCalibrationCase


@pytest.fixture(scope="module")
def golden() -> Golden:
    return _load(Golden, "golden.yaml")


@pytest.fixture(scope="module")
def calibration() -> RerankCalibration:
    return _load(RerankCalibration, "rerank_calibration.yaml")


def test_the_shipped_corpora_are_disjoint(calibration: RerankCalibration, golden: Golden) -> None:
    report = holdout_report(calibration.cases, golden.cases)
    assert report.held_out, report.explain()
    assert "HELD OUT" in report.explain()
    # The two residual limits are part of the claim, not a footnote someone can drop.
    assert "SAME documents" in report.explain()
    assert "same person wrote" in report.explain()


def test_no_g4_case_is_inside_the_sweep(calibration: RerankCalibration, golden: Golden) -> None:
    """The finding itself: G4's family had been wholly inside the sweep."""
    g4 = {case.id for case in golden.cases if case.family == "abstain"}
    assert g4, "the abstain family is what G4 reports; an empty one would make the gate vacuous"
    swept = {case.id for case in calibration.cases}
    assert not (g4 & swept)
    g4_questions = {normalize_question(c.question) for c in golden.cases if c.family == "abstain"}
    assert not (g4_questions & {normalize_question(c.question) for c in calibration.cases})


def test_the_sweep_reads_the_held_out_corpus_and_not_the_exam() -> None:
    source = inspect.getsource(_calibrate)
    assert '"rerank_calibration.yaml"' in source
    assert "holdout_report(swept, golden.cases)" in source
    # `golden` survives in `_calibrate` only to be compared against. If cases are ever built from it
    # again the sweep is fitted on the exam once more, whatever the printed flag says.
    assert "eval_case_from_golden" not in source


def test_the_verdict_is_derived_and_not_asserted() -> None:
    """AC1: the statement comes from the case ids, so an edit cannot leave it stale."""
    source = inspect.getsource(_calibrate)
    assert '"held_out": holdout.held_out' in source
    assert '"held_out": False' not in source
    assert '"held_out": True' not in source


def test_a_reused_id_is_caught(calibration: RerankCalibration, golden: Golden) -> None:
    stolen = golden.cases[0]
    intruder = RerankCalibrationCase(
        id=stolen.id,
        question="An entirely unrelated question about nothing.",
        user="alice",
        project="acme",
        must_find=False,
    )
    report = holdout_report([*calibration.cases, intruder], golden.cases)
    assert not report.held_out
    assert report.shared_ids == (stolen.id,)
    assert "NOT HELD OUT" in report.explain()


def test_a_reused_question_under_a_new_id_is_caught(
    calibration: RerankCalibration, golden: Golden
) -> None:
    """A renamed id with the same text is the same case; ids alone would have missed it."""
    twin = next(case for case in golden.cases if case.id == "ab3")
    assert twin.question == "¿Cuántos empleados tiene Globex?"
    # Upper-cased, re-spaced, and with the accent dropped — three ways a duplicate arrives in a
    # bilingual corpus by hand, none of which an equality check on the raw text would catch.
    intruder = RerankCalibrationCase(
        id="cal-intruder",
        question="  ¿CUANTOS EMPLEADOS TIENE GLOBEX?  ",
        user=twin.user,
        project=twin.project,
        must_find=twin.must_find,
    )
    report = holdout_report([*calibration.cases, intruder], golden.cases)
    assert not report.held_out
    assert report.shared_questions == (f"cal-intruder = {twin.id}",)
    assert not report.shared_ids


def test_a_reworded_question_is_caught(calibration: RerankCalibration, golden: Golden) -> None:
    """The subtle one: same case, different words, which an equality check cannot see."""
    twin = next(case for case in golden.cases if case.id == "qa1")
    assert twin.question == "What is the Globex Standard tier response time?"
    intruder = RerankCalibrationCase(
        id="cal-intruder",
        question="What response time is the Globex Standard tier?",
        user=twin.user,
        project=twin.project,
        must_find=True,
    )
    report = holdout_report([*calibration.cases, intruder], golden.cases)
    assert not report.held_out
    caught = {(left, right) for left, right, _ in report.near_duplicates}
    assert ("cal-intruder", "qa1") in caught
    # It also trips against `qa2`, which asks the same thing about the *Priority* tier. That is the
    # guard working, not a false positive: qa1 and qa2 are themselves 0.778 apart, so anything close
    # to one is close to the other, and a case that near either is held out from neither.
    assert ("cal-intruder", "qa2") in caught


def test_the_near_duplicate_threshold_has_real_margin(
    calibration: RerankCalibration, golden: Golden
) -> None:
    """The threshold is only meaningful if the shipped corpora are not near it.

    Measured when the split was written: the closest genuine pair is `cal-22` ~ `t4` at **0.538** —
    "Until what date was the 100 EUR Globex day rate in force?" against "What was the Globex day rate
    in 2022?". Two different questions about the same fact (a boundary date, a value) that happen to
    share seven common words, which is what a token-set measure sees. Against a 0.75 threshold that is
    comfortable; if a new case pushes it past the guard rail, the failure names the pair.
    """
    worst = max(
        (
            (jaccard(left.question, right.question), left.id, right.id)
            for left in calibration.cases
            for right in golden.cases
        ),
    )
    score, left_id, right_id = worst
    assert score < NEAR_DUPLICATE_JACCARD, f"{left_id} ~ {right_id} at {score:.3f}"
    assert score < 0.65, (
        f"closest genuine pair is now {left_id} ~ {right_id} at {score:.3f}; it was 0.538 when the "
        "split was written. Rising margin means the sets are converging."
    )


def test_the_sweep_has_enough_of_both_labels(calibration: RerankCalibration) -> None:
    """A sweep needs positives AND negatives; one label has nothing to separate."""
    positives = [case for case in calibration.cases if case.must_find]
    negatives = [case for case in calibration.cases if not case.must_find]
    assert len(positives) >= 5
    assert len(negatives) >= 5
    # Golden's own sweep drew on 23 cases. A much thinner set would move the threshold on one
    # passage's score, which is how a "calibrated" number becomes noise.
    assert len(calibration.cases) >= 20


def test_every_calibration_principal_exists_and_matches_its_project(
    calibration: RerankCalibration,
) -> None:
    """An answerable case asked as the wrong project's principal is an unanswerable one mislabeled,
    and it would drag the suggested threshold down for every install."""
    from evals.gate_run import EVALS

    users = yaml.safe_load((EVALS / "users.yaml").read_text(encoding="utf-8"))["users"]
    for case in calibration.cases:
        assert case.user in users, case.id
        assert users[case.user]["project"] == case.project, case.id


def test_the_calibration_corpus_carries_no_expectation_field() -> None:
    """Nothing scores these cases. A field that looks gradeable invites grading them, and a graded
    calibration case is an evaluation case again — the overlap this file exists to remove."""
    forbidden = {"expected", "must_include", "must_exclude", "expected_evidence", "family"}
    assert not forbidden & set(RerankCalibrationCase.model_fields)
    raw = yaml.safe_load(
        (
            __import__("pathlib").Path(inspect.getfile(_calibrate)).parent
            / "rerank_calibration.yaml"
        ).read_text(encoding="utf-8")
    )
    assert all(not forbidden & set(case) for case in raw["cases"])


def test_the_content_gate_refuses_an_overlapping_corpus(tmp_path: object) -> None:
    """The same disjointness, enforced where `evals.validate` runs — CI's content gate, not pytest.

    Two guards in one place would be redundant if they ran in the same place; they do not. A corpus
    edit that reintroduces the overlap has to fail the gate a release runs, which is this one.
    """
    from pathlib import Path as _Path

    from evals.gate_run import EVALS
    from evals.validate import check_rerank_calibration

    assert check_rerank_calibration() == []

    repo = _Path(str(tmp_path))
    (repo / "evals").mkdir()
    for name in ("golden.yaml", "users.yaml"):
        (repo / "evals" / name).write_text((EVALS / name).read_text(encoding="utf-8"), "utf-8")
    overlapping = (
        (EVALS / "rerank_calibration.yaml")
        .read_text(encoding="utf-8")
        .replace(
            '{id: cal-11, question: "How many offices does Acme Corp have worldwide?"',
            '{id: cal-11, question: "What is Acme\'s revenue in 2024?"',
        )
    )
    (repo / "evals" / "rerank_calibration.yaml").write_text(overlapping, "utf-8")
    errors = check_rerank_calibration(repo=repo)
    assert errors and "NOT HELD OUT" in errors[0]
    assert "cal-11 = ab1" in errors[0]


def test_the_content_gate_refuses_a_one_sided_sweep(tmp_path: object) -> None:
    """A sweep of positives only has no boundary to find; it would suggest a threshold anyway."""
    from pathlib import Path as _Path

    from evals.validate import check_rerank_calibration

    repo = _Path(str(tmp_path))
    (repo / "evals").mkdir()
    (repo / "evals" / "rerank_calibration.yaml").write_text(
        "cases:\n"
        + "".join(
            f'  - {{id: cal-{n}, question: "Question number {n} about Acme?", '
            f"user: alice, project: acme, must_find: true}}\n"
            for n in range(1, 8)
        ),
        "utf-8",
    )
    errors = check_rerank_calibration(repo=repo)
    assert errors and "nothing to separate" in errors[0]


def test_the_calibration_positives_span_the_shapes_the_gates_score(
    calibration: RerankCalibration,
) -> None:
    """Held out is necessary and not sufficient: the set must also be as hard as the exam.

    Measured while writing the split. The first version held only plain, undated, unqualified
    positives and the sweep suggested **0.395**; adding the five below — table cells under a
    qualifier and dated facts, the two shapes golden's `qualifier` and `temporal` families score —
    brought it to **0.325**. Applied to golden, the easier set's threshold would have bought
    abstention with recall at every install that followed its advice.

    Each case is pinned by the token that makes it hard, not by its id alone: an id can survive a
    question being softened back into a plain lookup, which is the edit this guard has to catch. A
    keyword heuristic would not do either — "digit in the question" passes on "Q3 partner meeting",
    which is a plain lookup. If one of these is deliberately replaced, replace its row here and
    re-run the sweep, because the threshold moves.
    """
    hard = {
        "cal-18": ("Standard", "table cell under a qualifier: the Standard tier's penalty"),
        "cal-19": ("F-2024-119", "table cell under a qualifier: which customer an invoice is for"),
        "cal-20": ("12-hour", "dated fact: the boundary date of the 12-hour Acme SLA"),
        "cal-21": ("120 EUR", "dated fact: the boundary date of the 120 EUR Globex rate"),
        "cal-22": ("100 EUR", "dated fact: the closing boundary of the 100 EUR Globex rate"),
    }
    answerable = {case.id: case.question for case in calibration.cases if case.must_find}
    lost = {
        case_id: why
        for case_id, (token, why) in hard.items()
        if token not in answerable.get(case_id, "")
    }
    assert not lost, (
        f"the sweep lost its hard positives: {lost}. Without them it suggested 0.395 instead of "
        "0.325 — a threshold that abstains from most of golden's qualified and dated answers."
    )
