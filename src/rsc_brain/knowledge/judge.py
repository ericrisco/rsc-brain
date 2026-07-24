"""Contradiction judge (FR-5.2) behind a common interface, with swappable adapters.

The ``Judge`` protocol returns ``agree | contradict | unrelated`` + confidence for a claim pair.
Adapters:

* :class:`LlmJudge` — the SPEC-02 ``contradiction_judge`` prompt via ``ModelGateway`` (GPU profiles).
* :class:`NliJudge` — mDeBERTa-XNLI via HF Transformers (CPU, D3), lazy-imported (heavy, torch); its
  live use is blocked-by-resource in CI, like Docling.
* :class:`HeuristicJudge` — a deterministic, dependency-free adapter that drives the whole
  detect→cache→resolve pipeline in tests without a model.

The installation profile picks the adapter; verdicts are cached per ordered pair + ``version`` so
a judge change invalidates the cache.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from rsc_brain.config.models import Capability
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.prompts import load_prompt


class Verdict(StrEnum):
    AGREE = "agree"
    CONTRADICT = "contradict"
    UNRELATED = "unrelated"


@dataclass(frozen=True, slots=True)
class JudgeResult:
    verdict: Verdict
    confidence: float


class Judge(Protocol):
    @property
    def version(self) -> str: ...

    async def judge(self, a: str, b: str) -> JudgeResult: ...


class _VerdictOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verdict: Verdict
    confidence: float = 0.5


class LlmJudge:
    """LLM adapter using the SPEC-02 contradiction_judge prompt via the gateway."""

    def __init__(self, gateway: ModelGateway, *, version: str = "llm-judge-v1") -> None:
        self._gateway = gateway
        self._version = version
        self._prompt = load_prompt("contradiction_judge")

    @property
    def version(self) -> str:
        return self._version

    async def judge(self, a: str, b: str) -> JudgeResult:
        messages = [
            {"role": "system", "content": self._prompt},
            {"role": "user", "content": f"A: {a}\nB: {b}"},
        ]
        try:
            out = await self._gateway.complete_structured(Capability.JUDGE, messages, _VerdictOut)
        except GatewayError:
            # A judge failure is not a contradiction — leave the pair unresolved (unrelated).
            return JudgeResult(Verdict.UNRELATED, 0.0)
        return JudgeResult(out.verdict, clamp01(out.confidence))


class NliJudge:  # pragma: no cover - blocked-by-resource (torch/mDeBERTa not in CI)
    """NLI adapter (mDeBERTa-XNLI). Lazy-imports HF Transformers; operator/GPU-provided."""

    def __init__(
        self,
        model_name: str = "MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7",
        *,
        version: str = "nli-mdeberta-v1",
    ) -> None:
        self._model_name = model_name
        self._version = version

    @property
    def version(self) -> str:
        return self._version

    async def judge(self, a: str, b: str) -> JudgeResult:
        pipeline = self._pipeline()
        # XNLI labels: entailment / neutral / contradiction.
        result = pipeline(f"{a} [SEP] {b}")
        label = str(result[0]["label"]).lower()
        confidence = float(result[0]["score"])
        if "contradic" in label:
            return JudgeResult(Verdict.CONTRADICT, confidence)
        if "entail" in label:
            return JudgeResult(Verdict.AGREE, confidence)
        return JudgeResult(Verdict.UNRELATED, confidence)

    def _pipeline(self) -> Any:
        try:
            from transformers import pipeline
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "NliJudge requires 'transformers' + a model (operator-provided, heavy). "
                "Use LlmJudge on GPU profiles, or install the NLI extra."
            ) from exc
        return pipeline("text-classification", model=self._model_name)


_NEGATION = re.compile(r"\b(no|not|never|non|sin|nunca|ningún|ninguna)\b", re.IGNORECASE)
_TOKEN = re.compile(r"\w+", re.UNICODE)
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


class HeuristicJudge:
    """Deterministic, dependency-free judge for driving the pipeline in tests.

    Two claims are considered ``contradict`` when they overlap strongly (same subject matter) but
    disagree — a negation on exactly one side, or different numbers. Strong overlap without those
    is ``agree``; weak overlap is ``unrelated``. This is NOT accurate on real prose (that needs a
    real judge — blocked-by-resource); it only exercises detect→cache→resolve deterministically."""

    version = "heuristic-v1"

    def __init__(self, *, overlap_threshold: float = 0.4) -> None:
        self._overlap_threshold = overlap_threshold

    async def judge(self, a: str, b: str) -> JudgeResult:
        tokens_a = {t.lower() for t in _TOKEN.findall(a)}
        tokens_b = {t.lower() for t in _TOKEN.findall(b)}
        if not tokens_a or not tokens_b:
            return JudgeResult(Verdict.UNRELATED, 0.5)
        overlap = len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
        if overlap < self._overlap_threshold:
            return JudgeResult(Verdict.UNRELATED, 0.6)
        negated_a = bool(_NEGATION.search(a))
        negated_b = bool(_NEGATION.search(b))
        numbers_a = set(_NUMBER.findall(a))
        numbers_b = set(_NUMBER.findall(b))
        disagrees = (negated_a != negated_b) or (
            bool(numbers_a) and bool(numbers_b) and numbers_a != numbers_b
        )
        if disagrees:
            return JudgeResult(Verdict.CONTRADICT, 0.8)
        return JudgeResult(Verdict.AGREE, 0.7)


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))
