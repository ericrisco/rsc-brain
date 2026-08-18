"""Tests for the model gateway (SPEC-01 AC-4, FR-9.1-9.4) and AUDIT-005 boundaries.

LiteLLM is mocked: completion/embedding functions are injected. No network is used.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from rsc_brain.config.models import CapabilitiesConfig, Capability, CapabilityConfig
from rsc_brain.gateway import (
    GatewayDimensionError,
    GatewayUnavailableError,
    GatewayValidationError,
    GenerationOptions,
    ModelGateway,
)
from rsc_brain.gateway.errors import GatewayError

# --- fakes mimicking the LiteLLM response shapes ---


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)


class _FakeResp:
    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]


class _FakeEmbResp:
    def __init__(self, vectors: list[list[float]]) -> None:
        self.data = [{"embedding": v} for v in vectors]


class FakeCompletion:
    """Injected completion function recording calls; returns queued/fixed content or raises."""

    def __init__(
        self,
        *,
        contents: list[str] | None = None,
        always: str | None = None,
        exc: Exception | None = None,
    ) -> None:
        self.contents = list(contents or [])
        self.always = always
        self.exc = exc
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.exc is not None:
            raise self.exc
        if self.always is not None:
            return _FakeResp(self.always)
        content = self.contents.pop(0) if self.contents else "{}"
        return _FakeResp(content)


class FakeEmbedding:
    def __init__(self, *, dim: int = 1024, exc: Exception | None = None) -> None:
        self.dim = dim
        self.exc = exc

    async def __call__(self, **kwargs: Any) -> Any:
        if self.exc is not None:
            raise self.exc
        n = len(kwargs["input"])
        return _FakeEmbResp([[0.1] * self.dim for _ in range(n)])


class Extracted(BaseModel):
    value: int


def _cap(**over: Any) -> CapabilityConfig:
    base: dict[str, Any] = {
        "provider": "ollama",
        "model": "m",
        "api_base": "http://localhost:11434",
    }
    base.update(over)
    return CapabilityConfig(**base)


def _caps(**over: Any) -> CapabilitiesConfig:
    caps: dict[str, Any] = {k: _cap() for k in ("extractor", "judge", "topicalizer", "reranker")}
    caps["embedder"] = _cap(model="bge-m3")
    caps.update(over)
    return CapabilitiesConfig(**caps)


# --- FR-9.2: success / repair / fallback / definitive failure ---


async def test_structured_success() -> None:
    comp = FakeCompletion(contents=['{"value": 7}'])
    gw = ModelGateway(_caps(), completion_fn=comp, embedding_fn=FakeEmbedding())
    result = await gw.complete_structured(
        Capability.EXTRACTOR, [{"role": "user", "content": "x"}], Extracted
    )
    assert result == Extracted(value=7)
    assert len(comp.calls) == 1


async def test_structured_repairs_after_invalid_output() -> None:
    comp = FakeCompletion(contents=["not-json", '{"value": 9}'])
    gw = ModelGateway(_caps(), completion_fn=comp, embedding_fn=FakeEmbedding())
    result = await gw.complete_structured(
        Capability.EXTRACTOR, [{"role": "user", "content": "x"}], Extracted
    )
    assert result.value == 9
    assert len(comp.calls) == 2  # first failed, repair succeeded
    # the repair turn carried the schema name as feedback
    assert any("Extracted" in str(m) for m in comp.calls[1]["messages"])


async def test_structured_falls_back_then_succeeds() -> None:
    # primary model never produces valid output across all attempts; fallback does.
    caps = _caps(extractor=_cap(fallback_model="ollama/backup"))
    comp = FakeCompletion(contents=["bad", "bad", "bad", '{"value": 3}'])
    gw = ModelGateway(caps, completion_fn=comp, embedding_fn=FakeEmbedding(), max_repair_attempts=2)
    result = await gw.complete_structured(
        Capability.EXTRACTOR, [{"role": "user", "content": "x"}], Extracted
    )
    assert result.value == 3
    assert any(c["model"] == "ollama/backup" for c in comp.calls)


async def test_structured_definitive_failure_raises_typed_error() -> None:
    comp = FakeCompletion(always="still-not-json")
    gw = ModelGateway(_caps(), completion_fn=comp, embedding_fn=FakeEmbedding())
    with pytest.raises(GatewayValidationError):
        await gw.complete_structured(
            Capability.JUDGE, [{"role": "user", "content": "x"}], Extracted
        )


# --- AUDIT-005: routing is immutable + errors are redacted ---


async def test_routing_comes_only_from_config() -> None:
    comp = FakeCompletion(contents=['{"value": 1}'])
    gw = ModelGateway(_caps(), completion_fn=comp, embedding_fn=FakeEmbedding())
    await gw.complete_structured(
        Capability.EXTRACTOR,
        [{"role": "user", "content": "x"}],
        Extracted,
        GenerationOptions(temperature=0.2, max_tokens=64),
    )
    call = comp.calls[0]
    assert call["model"] == "ollama/m"
    assert call["api_base"] == "http://localhost:11434"
    assert call["temperature"] == 0.2 and call["max_tokens"] == 64


def test_generation_options_reject_routing_overrides() -> None:
    with pytest.raises(ValidationError):
        GenerationOptions(model="evil/model")  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        GenerationOptions(api_base="http://attacker")  # type: ignore[call-arg]


def test_complete_has_no_var_keyword_escape_hatch() -> None:
    # No **kwargs on the public completion methods => callers cannot smuggle routing.
    for method in (ModelGateway.complete, ModelGateway.complete_structured):
        kinds = [p.kind for p in inspect.signature(method).parameters.values()]
        assert inspect.Parameter.VAR_KEYWORD not in kinds


async def test_provider_error_is_redacted() -> None:
    secret = "cred=sk-DO-NOT-LEAK-123"
    comp = FakeCompletion(exc=RuntimeError(f"upstream 500 {secret}"))
    gw = ModelGateway(_caps(), completion_fn=comp, embedding_fn=FakeEmbedding())
    with pytest.raises(GatewayUnavailableError) as ei:
        await gw.complete(Capability.EXTRACTOR, [{"role": "user", "content": "x"}])
    assert secret not in str(ei.value)
    assert ei.value.correlation_id  # a ref is still available for internal diagnosis


# --- FR-9.4: embedding dimension anchoring ---


async def test_embed_returns_vectors_at_anchor_dimension() -> None:
    gw = ModelGateway(_caps(), completion_fn=FakeCompletion(), embedding_fn=FakeEmbedding(dim=1024))
    vectors = await gw.embed(["a", "b"])
    assert len(vectors) == 2 and all(len(v) == 1024 for v in vectors)


async def test_embed_wrong_dimension_fails_loudly() -> None:
    gw = ModelGateway(_caps(), completion_fn=FakeCompletion(), embedding_fn=FakeEmbedding(dim=512))
    with pytest.raises(GatewayDimensionError):
        await gw.embed(["a"])


# --- FR-9.3: real per-capability healthcheck ---


async def test_healthcheck_all_capabilities_ok() -> None:
    # AUDIT-099: with no probes supplied, healthcheck falls back to the generic `{ok: bool}` shape —
    # which certifies almost nothing on a real route. `installer.verify` supplies the real ones.
    comp = FakeCompletion(always='{"ok": true}')
    gw = ModelGateway(_caps(), completion_fn=comp, embedding_fn=FakeEmbedding(dim=1024))
    statuses = await gw.healthcheck()
    assert set(statuses) == {"extractor", "judge", "topicalizer", "embedder", "reranker"}
    assert all(s.ok for s in statuses.values())


async def test_healthcheck_failure_is_reported_and_redacted() -> None:
    secret = "sk-HEALTH-LEAK"
    comp = FakeCompletion(exc=RuntimeError(secret))
    gw = ModelGateway(
        _caps(), completion_fn=comp, embedding_fn=FakeEmbedding(exc=RuntimeError(secret))
    )
    statuses = await gw.healthcheck()
    assert all(not s.ok for s in statuses.values())
    assert all(s.correlation_id for s in statuses.values())
    assert secret not in repr(statuses)


def test_gateway_error_hierarchy() -> None:
    assert issubclass(GatewayValidationError, GatewayError)
    assert issubclass(GatewayUnavailableError, GatewayError)
    assert issubclass(GatewayDimensionError, GatewayError)
