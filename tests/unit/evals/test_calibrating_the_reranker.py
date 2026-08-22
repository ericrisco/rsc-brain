"""τ can be swept over the RERANKER's own scores, not only the blended ones (AUDIT-132).

`calibrate_tau` sweeps `(must_find, max_score)` pairs, and `run_calibration` fed it the blended
similarity — the quantity measured *unable* to meet G4 (populations overlapping by -0.032). Since
AUDIT-085 abstention is decided by `recall.tau_rerank` over the reranker's relevance score, and nothing
could suggest a value for it.

AUDIT-131 made that urgent: a cross-encoder puts an answer at 0.34 where a chat model puts it at 0.95,
so a threshold carried between routes abstains from everything. "Set it explicitly for your model" is
correct advice and a poor tool.
"""

from __future__ import annotations

from collections.abc import Sequence

from evals.metrics import calibrate_tau
from evals.runner import EvalCase, calibrate_reranker_tau


class _Separating:
    """A reranker whose scores separate the populations at 0.3, the way a cross-encoder does."""

    version = "separating"

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        return [0.34 if "answer" in passages[0] else 0.003]


def _case(case_id: str, *, must_find: bool) -> EvalCase:
    return EvalCase(
        case_id=case_id,
        family="hit" if must_find else "abstain",
        must_find=must_find,
        question="q",
        user="alice",
        project="acme",
    )


async def test_the_sweep_finds_the_threshold_between_the_populations() -> None:
    cases = [_case("h1", must_find=True), _case("a1", must_find=False)]

    async def passages(case: EvalCase) -> list[str]:
        return ["the answer is here"] if case.must_find else ["something unrelated"]

    tau = await calibrate_reranker_tau(cases, _Separating(), passages)

    assert 0.003 < tau <= 0.34, (
        "a threshold between the two populations; the chat route's 0.5 sits above both and would "
        f"abstain from everything, which is the defect AUDIT-131 guards against — got {tau}"
    )


async def test_an_unscored_candidate_does_not_count_as_zero() -> None:
    """AUDIT-100's rule, carried into calibration: an unscored passage is not evidence of
    irrelevance, and treating it as 0.0 would drag the suggested threshold down."""

    class _Unscored:
        version = "unscored"

        async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
            return [None]

    async def passages(case: EvalCase) -> list[str]:
        return ["p"]

    tau = await calibrate_reranker_tau([_case("h1", must_find=True)], _Unscored(), passages)

    assert tau == calibrate_tau([]), "no usable sample means no opinion, not a swept zero"


async def test_a_case_with_no_candidates_is_skipped() -> None:
    async def nothing(case: EvalCase) -> list[str]:
        return []

    tau = await calibrate_reranker_tau([_case("h1", must_find=True)], _Separating(), nothing)

    assert tau == calibrate_tau([])
