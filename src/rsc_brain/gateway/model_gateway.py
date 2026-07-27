"""The model gateway (FR-9.1-9.4) over LiteLLM - the single configured model boundary.

Guarantees:

* **FR-9.1** — capabilities (extractor/judge/topicalizer/embedder/reranker) are configured
  independently; each may point at a local (Ollama/vLLM) or cloud backend.
* **FR-9.2** — ``complete_structured`` validates the output against a Pydantic schema,
  **repairs** (retry with the validation error as feedback), then falls back to the
  configured fallback model, and finally raises a typed error so ingestion can discard-and-log
  (never garbage to the graph, FR-1.8).
* **FR-9.3** — ``healthcheck`` runs a *real* structured probe per capability (an embed probe
  for the embedder) and reports pass/fail, redacted.
* **FR-9.4** — the embedder dimension is anchored (1024); a different dimension fails loudly.

Security (AUDIT-005): routing — provider, model, endpoint, credentials, timeout, fallback —
is resolved **only** from configuration. Callers may pass a typed :class:`GenerationOptions`
allowlist and nothing else; there is no ``**kwargs`` path, so the destination cannot be
rebound from call data. Provider exception text is never propagated to public errors or the
health report.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from rsc_brain.config.models import CapabilitiesConfig, Capability, CapabilityConfig
from rsc_brain.gateway.errors import (
    GatewayDimensionError,
    GatewayError,
    GatewayUnavailableError,
    GatewayValidationError,
    UnknownCapabilityError,
)
from rsc_brain.gateway.options import GenerationOptions
from rsc_brain.gateway.usage import Attempt, EmbeddingCache, UsageRecorder, text_hash

T = TypeVar("T", bound=BaseModel)

Message = Mapping[str, Any]
CompletionFn = Callable[..., Awaitable[Any]]
EmbeddingFn = Callable[..., Awaitable[Any]]


class _HealthProbe(BaseModel):
    """Minimal schema the structured healthcheck probe must return."""

    ok: bool


@dataclass(frozen=True, slots=True)
class HealthStatus:
    """Per-capability health. Carries no upstream text — only pass/fail + a ref on failure."""

    ok: bool
    correlation_id: str | None = None


@dataclass(frozen=True, slots=True)
class _Attempt[V]:
    value: V | None = None
    error: GatewayError | None = None
    #: Tokens the provider reported across every round of this attempt — the initial call plus any
    #: repair rounds (R29). Structured completions used to record a flat zero, so extraction,
    #: topicalization and judging — most of the product's traffic — contributed nothing to any budget
    #: and a busy project reported spending nothing.
    tokens: int = 0


def _new_ref() -> str:
    return uuid.uuid4().hex[:12]


def _extract_content(response: Any) -> str:
    """Pull the assistant message text from a LiteLLM completion response."""
    try:
        message = response.choices[0].message
        content = message.content if hasattr(message, "content") else message["content"]
    except (AttributeError, KeyError, IndexError, TypeError):
        raise GatewayValidationError("empty_completion", _new_ref()) from None
    if not isinstance(content, str) or not content:
        raise GatewayValidationError("empty_completion", _new_ref())
    return content


def _usage_tokens(response: Any) -> int:
    """Best-effort total token count from a provider response (0 when the provider omits usage)."""
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return 0
    total = getattr(usage, "total_tokens", None)
    if total is None and isinstance(usage, dict):
        total = usage.get("total_tokens")
    return int(total or 0)


def _extract_embeddings(response: Any) -> list[list[float]]:
    try:
        data = response.data if hasattr(response, "data") else response["data"]
        vectors: list[list[float]] = []
        for item in data:
            emb = item["embedding"] if isinstance(item, Mapping) else item.embedding
            vectors.append([float(x) for x in emb])
    except (AttributeError, KeyError, IndexError, TypeError):
        raise GatewayValidationError("malformed_embedding", _new_ref()) from None
    return vectors


def _repair_message(schema: type[BaseModel], error: ValidationError) -> dict[str, str]:
    return {
        "role": "user",
        "content": (
            f"Your previous reply did not match the required JSON schema "
            f"'{schema.__name__}'. Fix these problems and reply with ONLY valid JSON:\n"
            f"{error.errors(include_url=False)}"
        ),
    }


class ModelGateway:
    """Configured, capability-routed access to LLM completion and embedding."""

    def __init__(
        self,
        capabilities: CapabilitiesConfig,
        *,
        completion_fn: CompletionFn | None = None,
        embedding_fn: EmbeddingFn | None = None,
        max_repair_attempts: int = 2,
        usage_recorder: UsageRecorder | None = None,
        embedding_cache: EmbeddingCache | None = None,
    ) -> None:
        self._caps = capabilities
        self._completion = completion_fn or _default_completion
        self._embedding = embedding_fn or _default_embedding
        self._max_repair = max_repair_attempts
        # SPEC-22 (FR-9.5/9.6): optional, injected — the gateway works without them.
        self._usage = usage_recorder
        self._cache = embedding_cache

    def for_project(self, project_id: str) -> ModelGateway:
        """This gateway with its accounting bound to ``project_id`` (AUDIT-021 / R12).

        The process builds one gateway before it knows whose work it will do; every boundary that
        holds a :class:`~rsc_brain.scope.ProjectScope` binds it here, so each attempt lands in that
        project's counter and each budget decision reads that project's consumption. Model routing,
        caches and repair behaviour are unchanged — only the accounting identity is.
        """
        recorder = self._usage
        binder = getattr(recorder, "for_project", None)
        if binder is None:  # no accounting configured, or a recorder that owns no project dimension
            return self
        bound: UsageRecorder = binder(project_id)
        clone = ModelGateway(
            self._caps,
            completion_fn=self._completion,
            embedding_fn=self._embedding,
            max_repair_attempts=self._max_repair,
            usage_recorder=bound,
            embedding_cache=self._cache,
        )
        return clone

    def _cap(self, capability: Capability) -> CapabilityConfig:
        try:
            return self._caps.get(capability)
        except AttributeError:
            raise UnknownCapabilityError("unknown_capability", _new_ref()) from None

    def _routing(self, cap: CapabilityConfig, model: str) -> dict[str, Any]:
        """Routing kwargs, resolved ONLY from configuration (never from call data)."""
        return {
            "model": model,
            "api_base": cap.api_base,
            "api_key": cap.api_key.get_secret_value() if cap.api_key else None,
            "timeout": cap.timeout_s,
        }

    async def complete(
        self,
        capability: Capability,
        messages: Sequence[Message],
        options: GenerationOptions | None = None,
    ) -> str:
        """Free-text completion for ``capability``. Provider failure → redacted typed error."""
        cap = self._cap(capability)
        # R29: the attempt HOLDS budget across the call and settles on the way out, whatever happened.
        async with self._attempt(capability) as attempt:
            try:
                response = await self._completion(
                    messages=list(messages),
                    **self._routing(cap, cap.litellm_model),
                    **(options.to_call_kwargs() if options else {}),
                )
            except Exception:
                raise GatewayUnavailableError("provider_unavailable", _new_ref()) from None
            attempt.spent = _usage_tokens(response)
            return _extract_content(response)

    async def complete_structured(
        self,
        capability: Capability,
        messages: Sequence[Message],
        schema: type[T],
        options: GenerationOptions | None = None,
    ) -> T:
        """Structured completion with validate → repair → fallback → typed error (FR-9.2)."""
        cap = self._cap(capability)
        # One reservation per ATTEMPT, the primary and the fallback alike: each is a real provider call.
        async with self._attempt(capability) as budgeted:
            attempt = await self._attempt_structured(
                cap, cap.litellm_model, messages, schema, options
            )
            budgeted.spent = attempt.tokens
        if attempt.value is not None:
            return attempt.value
        if cap.fallback_model is not None:
            async with self._attempt(capability) as budgeted_fallback:
                fb = await self._attempt_structured(
                    cap, cap.fallback_model, messages, schema, options
                )
                budgeted_fallback.spent = fb.tokens
            if fb.value is not None:
                return fb.value
            attempt = fb
        raise attempt.error or GatewayValidationError("structured_failed", _new_ref())

    @asynccontextmanager
    async def _attempt(self, capability: Capability) -> AsyncIterator[Attempt]:
        """Budget for one provider attempt: reserved on entry, settled on exit (R29).

        With no recorder configured the handle is a sink, so the call path is identical whether or not
        an install accounts for its usage.
        """
        if self._usage is None:
            yield Attempt()
            return
        async with self._usage.reserve(str(capability)) as attempt:
            yield attempt

    async def _attempt_structured(
        self,
        cap: CapabilityConfig,
        model: str,
        messages: Sequence[Message],
        schema: type[T],
        options: GenerationOptions | None,
    ) -> _Attempt[T]:
        convo: list[Message] = list(messages)
        spent = 0  # accumulated across repair rounds: each one is a real provider call (R29)
        for _ in range(self._max_repair + 1):
            try:
                response = await self._completion(
                    messages=convo,
                    response_format=schema,
                    **self._routing(cap, model),
                    **(options.to_call_kwargs() if options else {}),
                )
            except Exception:
                return _Attempt(
                    error=GatewayUnavailableError("provider_unavailable", _new_ref()), tokens=spent
                )
            spent += _usage_tokens(response)
            try:
                content = _extract_content(response)
                return _Attempt(value=schema.model_validate_json(content), tokens=spent)
            except (ValidationError, GatewayValidationError) as exc:
                if isinstance(exc, ValidationError):
                    convo = [*convo, _repair_message(schema, exc)]
                else:
                    convo = list(messages)
        return _Attempt(
            error=GatewayValidationError("structured_validation_failed", _new_ref()), tokens=spent
        )

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed ``texts`` and enforce the anchored dimension (FR-9.4).

        When a cache is configured (FR-9.6) the same text is served from it — within THIS project only
        (AUDIT-022). The project comes from the same binding that carries usage accounting, so a gateway
        that accounts correctly caches correctly; an unbound gateway simply gets no cache, because a
        cross-project hit is how a tenant used to confirm another tenant's content from its own bill.
        """
        cap = self._cap(Capability.EMBEDDER)
        ordered = list(texts)
        project_id = self._project_id()
        if self._cache is None or project_id is None:
            return await self._embed_raw(cap, ordered)
        model, dim = cap.litellm_model, cap.effective_dimension
        hashes = [text_hash(t) for t in ordered]
        cached = await self._cache.get_many(
            model, dim, list(dict.fromkeys(hashes)), project_id=project_id
        )
        miss_texts: list[str] = []
        miss_hashes: list[str] = []
        for text, digest in zip(ordered, hashes, strict=True):
            if digest not in cached and digest not in miss_hashes:
                miss_texts.append(text)
                miss_hashes.append(digest)
        if miss_texts:
            vectors = await self._embed_raw(cap, miss_texts)
            fresh = dict(zip(miss_hashes, vectors, strict=True))
            await self._cache.put_many(model, dim, fresh, project_id=project_id)
            cached = {**cached, **fresh}
        return [cached[digest] for digest in hashes]

    def _project_id(self) -> str | None:
        """The project this gateway is bound to, taken from its usage recorder (AUDIT-021 / R12).

        One binding, not two: the recorder already carries the project because that is the unit an attempt
        is attributable to, and the cache needs exactly the same answer. A second source of truth here
        would be a second thing to forget at a boundary.
        """
        recorder = self._usage
        return getattr(recorder, "project_id", None) if recorder is not None else None

    async def _embed_raw(self, cap: CapabilityConfig, texts: list[str]) -> list[list[float]]:
        # R29: reserved for the duration of the call and settled on the way out, so a batch that fails
        # halfway still accounts for what it cost and cannot leave a hold behind.
        async with self._attempt(Capability.EMBEDDER) as attempt:
            try:
                response = await self._embedding(
                    model=cap.litellm_model,
                    input=texts,
                    api_base=cap.api_base,
                    api_key=cap.api_key.get_secret_value() if cap.api_key else None,
                    timeout=cap.timeout_s,
                )
            except Exception:
                raise GatewayUnavailableError("provider_unavailable", _new_ref()) from None
            # Embedding providers often omit a usage block; the text count is the honest floor.
            attempt.spent = _usage_tokens(response) or len(texts)
            vectors = _extract_embeddings(response)
            for vector in vectors:
                if len(vector) != cap.effective_dimension:
                    raise GatewayDimensionError("embedding_dimension_mismatch", _new_ref())
            return vectors

    def unresolved_capabilities(self) -> list[str]:
        """Capabilities missing a provider or a model — a local check, no provider contact (R50).

        Readiness needs this; it must not need `healthcheck`, which spends a token per capability per
        probe and fails when someone else's service is down.
        """
        missing: list[str] = []
        for capability in Capability:
            try:
                config = self._caps.get(capability)
            except AttributeError:
                missing.append(capability.value)
                continue
            if not config.provider or not config.model:
                missing.append(capability.value)
        return missing

    async def healthcheck(self) -> dict[str, HealthStatus]:
        """Run a real structured/embed probe per configured capability (FR-9.3)."""
        statuses: dict[str, HealthStatus] = {}
        probe_messages: list[Message] = [
            {"role": "user", "content": 'Reply with exactly this JSON: {"ok": true}'}
        ]
        for capability in Capability:
            try:
                if capability is Capability.EMBEDDER:
                    vector = (await self.embed(["healthcheck"]))[0]
                    ok = len(vector) == self._cap(capability).effective_dimension
                    statuses[capability.value] = HealthStatus(ok=ok)
                else:
                    await self.complete_structured(capability, probe_messages, _HealthProbe)
                    statuses[capability.value] = HealthStatus(ok=True)
            except GatewayError as exc:
                statuses[capability.value] = HealthStatus(
                    ok=False, correlation_id=exc.correlation_id
                )
        return statuses


async def _default_completion(**kwargs: Any) -> Any:
    import litellm

    return await litellm.acompletion(**kwargs)


async def _default_embedding(**kwargs: Any) -> Any:
    import litellm

    return await litellm.aembedding(**kwargs)
