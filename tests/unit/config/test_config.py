"""Tests for the 12-factor configuration layer (SPEC-01 AC-5)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError

from rsc_brain.config import (
    ANCHORED_EMBEDDING_DIM,
    CapabilitiesConfig,
    Capability,
    CapabilityConfig,
    ScoreWeights,
    load_settings,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_CONFIG = REPO_ROOT / "config.example.yaml"


def _capability(**overrides: object) -> CapabilityConfig:
    base: dict[str, object] = {"provider": "ollama", "model": "m"}
    base.update(overrides)
    return CapabilityConfig(**base)


def _capabilities(**overrides: object) -> CapabilitiesConfig:
    caps: dict[str, object] = {
        name: _capability() for name in ("extractor", "judge", "topicalizer", "reranker")
    }
    caps["embedder"] = _capability(model="bge-m3")
    caps.update(overrides)
    return CapabilitiesConfig(**caps)


# --- example config loads and carries the documented defaults ---


def test_example_config_loads_with_documented_defaults() -> None:
    settings = load_settings(EXAMPLE_CONFIG)
    assert settings.recall.tau == 0.45
    assert settings.recall.answer_token_budget == 2000
    assert settings.recall.half_life_days == 365
    assert (
        settings.capabilities.get(Capability.EMBEDDER).effective_dimension == ANCHORED_EMBEDDING_DIM
    )


def test_score_weights_default_sum_to_one() -> None:
    settings = load_settings(EXAMPLE_CONFIG)
    w = settings.recall.weights
    assert abs(w.similarity + w.credibility + w.freshness + w.importance - 1.0) < 1e-9


# --- precedence: env > file > default (AC-5) ---


def test_env_overrides_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RSC_BRAIN_RECALL__TAU", "0.6")
    settings = load_settings(EXAMPLE_CONFIG)
    assert settings.recall.tau == 0.6  # env beats the file's 0.45


def test_file_overrides_default(tmp_path: Path) -> None:
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "capabilities:\n"
        + "".join(
            f"  {name}:\n    provider: ollama\n    model: m\n"
            for name in ("extractor", "judge", "topicalizer", "embedder", "reranker")
        )
        + "recall:\n  tau: 0.30\n",
        encoding="utf-8",
    )
    settings = load_settings(cfg)
    assert settings.recall.tau == 0.30  # file beats the code default of 0.45


def test_env_nested_secret_not_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RSC_BRAIN_CAPABILITIES__EMBEDDER__API_KEY", "sk-super-secret-value")
    settings = load_settings(EXAMPLE_CONFIG)
    key = settings.capabilities.get(Capability.EMBEDDER).api_key
    assert isinstance(key, SecretStr)
    assert key.get_secret_value() == "sk-super-secret-value"
    assert "sk-super-secret-value" not in repr(settings)


# --- validation invariants ---


def test_embedder_dimension_mismatch_is_rejected() -> None:
    with pytest.raises(ValidationError, match="1024"):
        _capabilities(embedder=_capability(model="bge-m3", dimension=512))


def test_score_weights_must_sum_to_one() -> None:
    with pytest.raises(ValidationError, match=r"sum to 1\.0"):
        ScoreWeights(similarity=0.9, credibility=0.25, freshness=0.10, importance=0.10)


def test_unknown_capability_key_is_forbidden() -> None:
    with pytest.raises(ValidationError):
        _capabilities(unexpected=_capability())


# --- the example file must never carry a secret (FR-4.7) ---


def test_example_config_has_no_secrets() -> None:
    text = EXAMPLE_CONFIG.read_text(encoding="utf-8")
    # No populated api_key / password lines, no obvious key material.
    assert not re.search(r"(?im)^\s*api_key\s*:\s*\S", text)
    assert not re.search(r"(?im)^\s*(password|dsn)\s*:\s*\S", text)
    assert "sk-" not in text
