"""Relevance reranking for the abstention decision (FR-3.6, spec `reranked-abstention`).

G4 measured **0 of 8** on a real host: every question answered, gibberish included, and
`gap_registered` false throughout — so the hunting loop, the product's differentiating promise, never
fired. Calibration could not fix it. Measured against the ingested corpus, the two populations
overlap on embedding similarity:

    worst question that SHOULD be answered   0.542
    best question that should ABSTAIN        0.574      margin -0.032

No scalar threshold separates overlapping populations. That is a property of bi-encoder retrieval: an
embedding measures topical proximity, and "what is Globex's cloud provider" sits close to Globex
documents that never mention one. Deciding whether a passage *answers* a question is a different
judgement — and the product already declares the component for it, whose route every operator is made
to supply and which nothing ever called (AUDIT-077).

This module is a **seam**, not a rewrite. It consumes the candidates the existing pipeline already
produced — after the in-query permission filter (FR-4.2), never before — and returns scores. It does
not retrieve, does not filter, and does not reorder: the blended score still decides order (FR-3.2),
and this decides only whether to answer at all (FR-3.3).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from pydantic import BaseModel, ConfigDict

from rsc_brain.config.models import Capability
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.prompts import load_prompt

#: Bounded like every other public surface (R38): the gate needs the best candidate, and scoring an
#: unbounded page would turn one recall into an unbounded number of model calls.
DEFAULT_RERANK_CANDIDATES = 10


class RerankerUnavailable(RuntimeError):
    """The reranker could not form an opinion. Not an answer, and not a failed query.

    A recall that raises because a model is down is worse for the caller than one that answers with
    the threshold it already had, so this is caught at the seam and the query degrades.
    """


class Reranker(Protocol):
    @property
    def version(self) -> str: ...

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]: ...


class _ScoresOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scores: list[float]


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


class LlmReranker:
    """Scores relevance through the `reranker` capability, mirroring `LlmJudge`.

    An LLM rather than a dedicated cross-encoder because the capability is a route like the other
    four: any chat provider an operator already configured can serve it, with no GPU requirement and
    no second serving stack. A dedicated reranker model can be routed to the same capability.
    """

    def __init__(self, gateway: ModelGateway, *, version: str = "llm-reranker-v1") -> None:
        self._gateway = gateway
        self._version = version
        self._prompt = load_prompt("relevance_reranker")

    @property
    def version(self) -> str:
        return self._version

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float]:
        if not passages:
            return []
        numbered = "\n\n".join(f"[{i}] {p}" for i, p in enumerate(passages))
        messages = [
            {"role": "system", "content": self._prompt},
            {"role": "user", "content": f"QUESTION: {query}\n\nPASSAGES:\n{numbered}"},
        ]
        try:
            out = await self._gateway.complete_structured(Capability.RERANKER, messages, _ScoresOut)
        except (GatewayError, Exception) as exc:
            if isinstance(exc, RerankerUnavailable):
                raise
            raise RerankerUnavailable(str(exc)) from exc
        if len(out.scores) != len(passages):
            raise RerankerUnavailable(
                f"the model returned {len(out.scores)} scores for {len(passages)} passages"
            )
        return [_clamp01(s) for s in out.scores]


async def abstains(
    reranker: Reranker, query: str, passages: Sequence[str], threshold: float
) -> bool | None:
    """Whether recall should abstain: ``True``/``False``, or ``None`` for no opinion.

    ``None`` is deliberate and load-bearing. An unavailable reranker and an empty candidate list are
    both "this seam cannot decide", and the caller must fall back to the blended threshold rather
    than treat silence as either verdict. Collapsing that into a boolean is how a degraded provider
    would start silently answering — or silently refusing — every question on the install.
    """
    if not passages:
        return None
    try:
        scores = await reranker.relevance(query, passages)
    except RerankerUnavailable:
        return None
    if len(scores) != len(passages):
        raise ValueError(
            f"reranker returned {len(scores)} scores for {len(passages)} passages: the contract is "
            "one score per passage, in order — a short list mis-attributes every score after the gap"
        )
    return max(scores) < threshold


async def degradation_of(reranker: Reranker, query: str, passages: Sequence[str]) -> str | None:
    """Why the reranker could not decide, or ``None`` when it did.

    AUDIT-085: the spec said the fallback happens "and the degradation is recorded", and the first
    implementation had the fallback without the recording. A degradation nobody can observe is how a
    measurement concludes "the reranker does not improve abstention" about a component that never
    ran — which is exactly what happened, twice, before this existed.

    Separate from `abstains` so the decision stays a decision: the caller asks whether to abstain,
    and asks *separately* whether the answer it got was the reranker's opinion or the fallback's.
    """
    if not passages:
        return "no candidates to score"
    try:
        await reranker.relevance(query, passages)
    except RerankerUnavailable as exc:
        return f"reranker unavailable, abstention fell back to the blended threshold: {exc}"
    return None
