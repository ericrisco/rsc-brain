"""Prove that a calibration set is disjoint from the set the gates are scored on (AUDIT-136).

`recall.tau_rerank` decides abstention and abstention is gate G4, so where the threshold's cases come
from decides whether G4 means anything. Until this module existed the sweep drew from `golden.yaml`
and the answer was "nowhere" — the threshold was fitted on the cases it was then reported over.

The guarantee here is deliberately mechanical: it is computed from the two corpora, not asserted by a
comment next to them. Three ways a case can fail to be held out, in increasing subtlety:

1. **Same id.** The obvious one, and the one a copy-paste produces.
2. **Same question.** A renamed id with the same text is the same case.
3. **A reworded near-duplicate.** "What is the Globex Standard tier response time?" and "What
   response time does the Globex Standard tier have?" are one case wearing two coats. Token-set
   overlap catches these; the threshold is high enough that questions merely *about the same entity*
   stay distinct, which they must, since the whole corpus is two fictional companies.

What this cannot prove: that the two sets are independent in distribution or in authorship. They
share documents on purpose (a threshold has to be fitted on the scores the install will really see)
and one person wrote both. Whoever quotes a held-out number states that limit alongside it — the
sweep's own output does.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

# Letters-or-digits runs, Unicode-aware: the corpus is bilingual and "años" must not tokenize as
# "a" + "os". `\W` with the `re.UNICODE` default already keeps accented letters as word characters.
_WORD = re.compile(r"[^\W\d_]+|\d+")

# Chosen against the shipped corpora, not picked round. Measured: the closest genuine calibration ↔
# golden pair scores **0.455** (`cal-05` ~ `qa2`, both about the Globex Priority tier), while inside
# `golden.yaml` a one-word qualifier rewording scores **0.778** (`qa1` ~ `qa2`, Standard vs Priority)
# and the cross-project family reuses whole questions verbatim at **1.0** (`h7` ~ `x1`). So 0.75 sits
# above every honest pair and below a one-word rewording — which is exactly the case this number has
# to catch, since it is the one an equality check cannot see. Raising it silently lets a paraphrase
# through; the test that pins the 0.455 margin fails before that can happen quietly.
NEAR_DUPLICATE_JACCARD = 0.75


class HasQuestion(Protocol):
    """Both a `GoldenCase` and a `RerankCalibrationCase` satisfy this; nothing else is needed."""

    id: str
    question: str


def normalize_question(text: str) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace.

    Accents go because "¿En que año...?" and "¿En qué año...?" are the same question typed twice, and
    a diacritic is not a distinguishing feature of a case. Two different questions do not become
    equal by losing their accents.
    """
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(_WORD.findall(stripped))


def _tokens(text: str) -> frozenset[str]:
    return frozenset(normalize_question(text).split())


def jaccard(left: str, right: str) -> float:
    """Token-set overlap of two questions. 1.0 is the same words, 0.0 shares none."""
    first, second = _tokens(left), _tokens(right)
    if not first or not second:
        return 0.0
    return len(first & second) / len(first | second)


@dataclass(frozen=True)
class HoldoutReport:
    """Why a calibration set is, or is not, held out from the scored set."""

    calibration_cases: int
    scored_cases: int
    shared_ids: tuple[str, ...]
    shared_questions: tuple[str, ...]
    near_duplicates: tuple[tuple[str, str, float], ...]

    @property
    def held_out(self) -> bool:
        return not (self.shared_ids or self.shared_questions or self.near_duplicates)

    def explain(self) -> str:
        if self.held_out:
            return (
                f"HELD OUT: the {self.calibration_cases} calibration cases share no id, no question "
                f"and no near-duplicate with any of the {self.scored_cases} cases the gates score, "
                "so the threshold was chosen without seeing them. Two limits remain and are not "
                "fixed by a split: both sets run over the SAME documents (a threshold has to be "
                "fitted on the score distribution the install will serve) and the same person wrote "
                "both. Quote the number with those two sentences attached."
            )
        reasons: list[str] = []
        if self.shared_ids:
            reasons.append(f"ids in both sets: {', '.join(self.shared_ids)}")
        if self.shared_questions:
            reasons.append(f"questions in both sets: {'; '.join(self.shared_questions)}")
        if self.near_duplicates:
            reasons.append(
                "near-duplicate questions: "
                + "; ".join(
                    f"{left} ~ {right} ({score:.2f})" for left, right, score in self.near_duplicates
                )
            )
        return (
            "NOT HELD OUT: the threshold was fitted on cases the gates also score, so a gate result "
            "produced with it is fitted rather than held out — say so wherever the number is quoted. "
            "The bias runs one way: fitting inflates the fitted families, so a comparison against a "
            "route using an unswept default understates that route's advantage, never overstates it. "
            + " | ".join(reasons)
        )


def holdout_report(
    calibration: Sequence[HasQuestion], scored: Sequence[HasQuestion]
) -> HoldoutReport:
    """Compare the two corpora and return what is shared, if anything."""
    scored_ids = {case.id for case in scored}
    scored_questions = {normalize_question(case.question): case.id for case in scored}
    shared_ids = sorted(case.id for case in calibration if case.id in scored_ids)
    shared_questions: list[str] = []
    near: list[tuple[str, str, float]] = []
    for case in calibration:
        normalized = normalize_question(case.question)
        twin = scored_questions.get(normalized)
        if twin is not None:
            shared_questions.append(f"{case.id} = {twin}")
            continue  # already the same case; a near-duplicate line would only repeat it
        for other in scored:
            score = jaccard(case.question, other.question)
            if score >= NEAR_DUPLICATE_JACCARD:
                near.append((case.id, other.id, score))
    return HoldoutReport(
        calibration_cases=len(calibration),
        scored_cases=len(scored),
        shared_ids=tuple(shared_ids),
        shared_questions=tuple(shared_questions),
        near_duplicates=tuple(near),
    )
