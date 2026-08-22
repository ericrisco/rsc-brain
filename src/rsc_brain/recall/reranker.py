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
from dataclasses import dataclass
from typing import Protocol, cast

from pydantic import BaseModel, ConfigDict

from rsc_brain.config.models import Capability, RerankerKind
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

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]: ...


class PassageScore(BaseModel):
    """One passage's relevance, carrying the index it was labelled with."""

    model_config = ConfigDict(extra="forbid")
    index: int
    score: float


class ScoresOut(BaseModel):
    """The reranker's structured output, keyed by passage index (AUDIT-100).

    This was a bare `list[float]`, positional. Measured end to end on the documented default route,
    the model returned **9 scores for 10 passages on every query** — and a positional list with a hole
    mis-attributes every score after the gap, so the only safe response was to discard the entire
    judgement. Abstention then fell back to the blended threshold in 26 of 26 cases, which means the
    feature this capability exists for never ran.

    Carrying the index makes a missing score cost one passage instead of all of them, without giving up
    the property the refusal protected: a score can still only ever be attributed to the passage the
    model named.

    Public because `installer.verify` probes this capability with its real schema (AUDIT-099), and
    reaching into another module's private name to do that is coupling that gets quietly copied.
    """

    model_config = ConfigDict(extra="forbid")
    scores: list[PassageScore]


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


class RerankApiReranker:
    """Scores relevance through a real rerank endpoint (AUDIT-130).

    The same seam as :class:`LlmReranker`, so everything built on the verdict — the threshold, the
    winner confirmation (AUDIT-104/120), the treatment of an unscored candidate (AUDIT-100) — is
    unchanged and cannot tell the two apart.

    Why it exists: the chat implementation costs one 12B inference per query and cannot run on a
    `cpu_only` profile at all, which is the whole reason such an install cannot refuse anything
    (AUDIT-128). A cross-encoder is the right tool for scoring a (query, passage) pair, and until now
    it had no way in — `config.example.yaml` even named one (AUDIT-129).

    A rerank API returns indexed scores natively, so the property the chat path had to be taught by
    prompt comes for free here: a score belongs to the document whose index it carries.
    """

    def __init__(self, gateway: object, *, version: str = "rerank-api-v1") -> None:
        self._gateway = gateway
        self._version = version

    @property
    def version(self) -> str:
        return self._version

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        """One score per passage in order, ``None`` where the provider did not score it."""
        if not passages:
            return []
        rerank = getattr(self._gateway, "rerank", None)
        if rerank is None:  # pragma: no cover - a gateway without the method is a wiring error
            raise RerankerUnavailable("the configured gateway exposes no rerank endpoint")
        try:
            scores = await rerank(query, list(passages))
        except GatewayError as exc:
            raise RerankerUnavailable(f"rerank endpoint unavailable: {exc}") from exc
        if len(scores) != len(passages):
            raise RerankerUnavailable(
                f"rerank returned {len(scores)} scores for {len(passages)} passages"
            )
        return list(scores)


class LlmReranker:
    """Scores relevance through the `reranker` capability, mirroring `LlmJudge`.

    An LLM rather than a dedicated cross-encoder because the capability is a route like the other
    four: any chat provider an operator already configured can serve it, with no GPU requirement and
    no second serving stack. A dedicated reranker model can be routed to the same capability.
    """

    def __init__(self, gateway: ModelGateway, *, version: str = "llm-reranker-v2") -> None:
        self._gateway = gateway
        self._version = version
        # AUDIT-122: v3 adds the qualifier-mismatch discrimination. Measured on the same probes:
        # "Premium support customers receive a 4-hour SLA" scored 0.9 for "What was the Acme support
        # SLA as of 2023-06-01?" under v2 — as high as the passage that answers it — and 0.1 under
        # v3, while the true answers went 0.95 -> 1.0.
        self._prompt = load_prompt("relevance_reranker", version="v3")

    @property
    def version(self) -> str:
        return self._version

    async def relevance(self, query: str, passages: Sequence[str]) -> Sequence[float | None]:
        """One entry per passage, in order; ``None`` where the model returned no score for it.

        ``None`` is not zero. "The model did not judge this passage" and "this passage is irrelevant"
        are different facts, and collapsing them would manufacture refusals out of miscounting —
        which is the defect AUDIT-100 exists to remove, not to relocate.
        """
        if not passages:
            return []
        # AUDIT-103: labelled from 1, not 0. With zero-based labels the model returned `index 10` for a
        # page of 10 twice in one measured run — it was answering one-based while being asked
        # zero-based, and the out-of-range guard correctly refused the whole judgement both times.
        # There is no way to tell that apart from a genuine hallucination, so the ambiguity is removed
        # at the source rather than guessed at on arrival.
        numbered = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(passages))
        messages = [
            {"role": "system", "content": self._prompt},
            {"role": "user", "content": f"QUESTION: {query}\n\nPASSAGES:\n{numbered}"},
        ]
        try:
            out = await self._gateway.complete_structured(Capability.RERANKER, messages, ScoresOut)
        except (GatewayError, Exception) as exc:
            if isinstance(exc, RerankerUnavailable):
                raise
            raise RerankerUnavailable(str(exc)) from exc
        by_index: dict[int, float] = {}
        for entry in out.scores:
            if not 1 <= entry.index <= len(passages):
                # An index nobody offered is mis-attribution arriving by another route.
                raise RerankerUnavailable(
                    f"the model scored index {entry.index}, outside the {len(passages)} passages sent"
                )
            position = entry.index - 1
            if position in by_index:
                raise RerankerUnavailable(f"the model scored index {entry.index} twice")
            by_index[position] = _clamp01(entry.score)
        if not by_index:
            raise RerankerUnavailable(f"the model scored none of the {len(passages)} passages")
        return [by_index.get(i) for i in range(len(passages))]


@dataclass(frozen=True, slots=True)
class Decision:
    """What the seam decided, and — in the same breath — whether it decided at all.

    AUDIT-096: `abstains` and `degradation_of` each answer half of this, and each costs a model call,
    so a caller that wanted both paid twice per recall. Nothing in the product ever did: the retriever
    took the verdict and dropped the reason on the floor for as long as both functions existed. An
    observability path priced at double the query cost is one nobody switches on, which is a design
    fault and not an oversight by its callers.
    """

    #: ``True``/``False`` from the reranker, or ``None`` when the seam had no opinion.
    abstains: bool | None
    #: What an operator should know about how this decision was reached, or ``None`` when there is
    #: nothing to say.
    #:
    #: AUDIT-100 made this independent of ``abstains`` rather than its complement. A partial
    #: judgement — some candidates scored, some not — now yields a real verdict AND a note, because
    #: both are true and the earlier either/or forced the caller to discard one of them. When
    #: ``abstains`` is ``None`` this always explains why.
    degradation: str | None

    #: The index of the passage that held its score alone, or ``None`` when nothing was confirmed —
    #: an abstention, an unavailable reranker, or an answer that rests on the batch score because the
    #: confirmation call could not run.
    #:
    #: AUDIT-124: without this the verdict cannot be honoured downstream. The reranker decided only
    #: WHETHER to answer while the blend decided WHAT to return, so a query could answer while
    #: returning fragments the reranker scored 0.1 — and the passage that justified answering need
    #: not be returned at all. Measured: "¿Cuál es la tarifa por hora vigente de Globex?" answered
    #: `found=true` and returned five fragments, none of them the rate.
    confirmed: int | None = None
    #: The batch scores, one per passage in order, ``None`` where unscored — so a caller can drop what
    #: the reranker refused instead of serving it as evidence for an answer it did not support.
    scores: tuple[float | None, ...] | None = None


async def decide(
    reranker: Reranker, query: str, passages: Sequence[str], threshold: float
) -> Decision:
    """The verdict and the reason, from ONE scoring call.

    This is what callers should use. `abstains` and `degradation_of` remain for the callers that only
    want one half, and `degradation_of` re-scores — so it is a diagnostic, never the second half of a
    pair.
    """
    if not passages:
        return Decision(abstains=None, degradation="no candidates to score")
    try:
        scores = await reranker.relevance(query, passages)
    except RerankerUnavailable as exc:
        return Decision(
            abstains=None,
            degradation=(
                f"reranker unavailable, abstention fell back to the blended threshold: {exc}"
            ),
        )
    if len(scores) != len(passages):
        raise ValueError(
            f"reranker returned {len(scores)} entries for {len(passages)} passages: the contract is "
            "one entry per passage, in order, `None` where unscored — a shorter list mis-attributes "
            "every entry after the gap"
        )
    judged = [s for s in scores if s is not None]
    if not judged:
        return Decision(
            abstains=None,
            degradation=(
                f"reranker scored none of the {len(passages)} candidates, abstention fell back to "
                "the blended threshold"
            ),
        )
    # AUDIT-100: decided over the passages the model actually judged. An unscored passage is not a
    # zero, so it cannot drag the maximum down and manufacture a refusal; and when SOME were judged
    # the judgement is used rather than thrown away, which is what made this feature never run.
    best = max(judged)
    note: str | None = None
    if len(judged) < len(passages):
        unscored = len(passages) - len(judged)
        note = f"reranker judged {len(judged)} of {len(passages)} candidates; {unscored} unscored"

    if best < threshold:
        return Decision(abstains=True, degradation=note, scores=tuple(scores))

    # AUDIT-104: answering rests on ONE passage — the top score. Confirm that one alone.
    #
    # Measured: for "What is Acme's marketing budget?" the judge scored a passage about the
    # deployment pipeline 1.0 inside the page of 10, reproducibly, and 0.0 when handed the same text
    # by itself. The indexed contract (AUDIT-100) stops a score sliding between positions; it cannot
    # detect a model attaching a score to the wrong index. A batch score is therefore not a property
    # of the (question, passage) pair, and the whole abstention decision was resting on one.
    #
    # So the decision to ANSWER requires agreement: the batch nominates, the solo call confirms. The
    # decision to abstain needs no second opinion — it is the conservative direction, and a product
    # whose promise is "ask a human rather than guess" should not need convincing to keep it.
    #
    # Costs exactly one extra call, and only when the answer would be yes.
    # AUDIT-120: confirm candidates in descending batch order, not just the top one.
    #
    # Measured on the corpus: for "What database does Acme run in production?" a passage answering
    # nothing scored 1.00 in a page of ten while the passage holding "Production runs on PostgreSQL
    # 16" scored 0.95 — so the impostor took the nomination, failed its solo call, and the query
    # abstained. With eight candidates nothing outscored the answer and the same question was
    # answered. The size of the page decided whether the product could answer at all.
    #
    # Confirming only the top nominee treats a bad nomination as a verdict about the QUESTION when it
    # is a verdict about one passage. Every candidate the batch put above the threshold gets its own
    # chance to confirm; abstention still requires that none of them holds its score alone, which is
    # the conservative property AUDIT-104 was protecting.
    #
    # A candidate the batch already scored below the threshold is never re-asked: it was refused on
    # its own merits and the call would buy nothing.
    ranked = sorted(
        (index for index, score in enumerate(scores) if score is not None and score >= threshold),
        key=lambda index: cast("float", scores[index]),
        reverse=True,
    )
    rejected: list[str] = []
    for rank, winner in enumerate(ranked):
        try:
            alone = await reranker.relevance(query, [passages[winner]])
        except RerankerUnavailable as exc:
            return Decision(
                abstains=False,
                degradation=(
                    f"top candidate could not be confirmed alone ({exc}); answered on the batch score"
                ),
                scores=tuple(scores),
            )
        solo = alone[0] if alone else None
        if solo is not None and solo >= threshold:
            if rank == 0:
                return Decision(
                    abstains=False, degradation=note, confirmed=winner, scores=tuple(scores)
                )
            confirmed = (
                f"the batch's top {rank} candidate(s) did not hold their score alone "
                f"({', '.join(rejected)}); confirmed the next one instead"
            )
            return Decision(
                abstains=False,
                degradation=f"{note}; {confirmed}" if note else confirmed,
                confirmed=winner,
                scores=tuple(scores),
            )
        rejected.append(f"{scores[winner]} in the page and {solo} alone")

    return Decision(
        abstains=True,
        degradation=(
            f"no candidate held its score alone ({', '.join(rejected)}): a batch score was not a "
            "property of the passage, so none of them carried the answer"
        ),
        scores=tuple(scores),
    )


async def abstains(
    reranker: Reranker, query: str, passages: Sequence[str], threshold: float
) -> bool | None:
    """Whether recall should abstain: ``True``/``False``, or ``None`` for no opinion.

    ``None`` is deliberate and load-bearing. An unavailable reranker and an empty candidate list are
    both "this seam cannot decide", and the caller must fall back to the blended threshold rather
    than treat silence as either verdict. Collapsing that into a boolean is how a degraded provider
    would start silently answering — or silently refusing — every question on the install.
    """
    # Delegates so the two cannot drift into deciding differently — the reason `decide` exists.
    return (await decide(reranker, query, passages, threshold)).abstains


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


def reranker_for(
    gateway: ModelGateway, *, enabled: bool, kind: RerankerKind | None
) -> Reranker | None:
    """The configured reranker implementation, or ``None`` when the operator has not opted in.

    AUDIT-130 gave this seam two implementations: ``chat`` asks a chat model for JSON scores — the only
    route for most of this product's life — and ``rerank_api`` calls a real rerank endpoint, which is
    what a cross-encoder speaks and what a ``cpu_only`` install would need to refuse anything at all
    (AUDIT-128). The default stays ``chat`` so an existing install keeps the behaviour it was measured
    with.

    It lives here, beside both implementations, because two places were choosing and a third was not.
    ``api/app.py`` honoured ``kind``; ``evals.gate_run._calibrate`` honoured it; and
    ``evals.gate_run._measure`` — the function that produces the G2/G4 gate numbers — hardcoded
    ``LlmReranker``. So an install configured for ``rerank_api`` could calibrate ``tau_rerank`` on its
    cross-encoder's scale (which AUDIT-131 measured as a completely different scale: 0.34 where a chat
    model says 0.95) and then have its gates measured by the chat route against that threshold. Not a
    crash — a number that looks like a gate result. One selector, so the instrument cannot measure a
    reranker the product would not serve.
    """
    if not enabled:
        return None
    if kind is RerankerKind.RERANK_API:
        return RerankApiReranker(gateway)
    return LlmReranker(gateway)
