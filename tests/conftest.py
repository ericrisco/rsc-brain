"""Integration fixtures: a real Postgres 16 + Apache AGE + pgvector container (testcontainers).

Uses the product's own data image (`rsc-brain/db:pg16-age-pgvector`), so integration evidence
runs against the exact runtime the product ships — not a mock or vanilla Postgres.

Also provides deterministic model-gateway fakes (shared by unit + integration tests) so the
pipeline is exercised end-to-end without a live LLM/embedder — the gateway's injectable
completion/embedding functions are the seam (AUDIT-005, matching `test_model_gateway`).
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable, Iterator, Sequence
from types import SimpleNamespace
from typing import Any

import pytest
from testcontainers.community.postgres import PostgresContainer

from rsc_brain.config.models import ANCHORED_EMBEDDING_DIM, CapabilitiesConfig, CapabilityConfig
from rsc_brain.gateway.model_gateway import CompletionFn, EmbeddingFn, ModelGateway
from rsc_brain.stores.relational.database import DSN_ENV_VAR
from rsc_brain.stores.relational.migrations import upgrade_to_head

_IMAGE = "rsc-brain/db:pg16-age-pgvector"
# >=16 chars and not a placeholder, so the image's password guard accepts it.
_PASSWORD = "testcontainers-strong-pw-abc123"


def _fake_capabilities() -> CapabilitiesConfig:
    cap = CapabilityConfig(provider="test", model="dummy")
    return CapabilitiesConfig(extractor=cap, judge=cap, topicalizer=cap, embedder=cap, reranker=cap)


def completion_response(content: str) -> SimpleNamespace:
    """Shape a LiteLLM-style completion response carrying ``content``."""
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def deterministic_embedding(text: str) -> list[float]:
    """A stable, non-zero 1024-dim vector for ``text`` (zero vectors break cosine distance)."""
    vector = [0.0] * ANCHORED_EMBEDDING_DIM
    index = int(hashlib.sha256(text.encode("utf-8")).hexdigest(), 16) % ANCHORED_EMBEDDING_DIM
    vector[index] = 1.0
    vector[0] = 1.0
    return vector


def embedding_fn(**kwargs: Any) -> Any:
    texts: Sequence[str] = kwargs["input"]

    async def _call() -> SimpleNamespace:
        return SimpleNamespace(data=[{"embedding": deterministic_embedding(t)} for t in texts])

    return _call()


def canned_completion(
    *,
    entities: list[dict[str, Any]] | None = None,
    relations: list[dict[str, Any]] | None = None,
    claims: list[dict[str, Any]] | None = None,
    tags: list[str] | None = None,
    invalid_for: str | None = None,
) -> CompletionFn:
    """A completion fn that answers by the requested structured schema. If ``invalid_for`` text
    appears in the user message, extraction schemas get non-JSON back → validation fails →
    the pipeline discards+logs that chunk (FR-1.8)."""
    payloads: dict[str, dict[str, Any]] = {
        "EntityExtraction": {"entities": entities or []},
        "RelationExtraction": {"relations": relations or []},
        "ClaimExtraction": {"claims": claims or []},
        "TopicAssignment": {"tags": tags if tags is not None else []},
        "_HealthProbe": {"ok": True},
    }

    async def _fn(**kwargs: Any) -> Any:
        schema = kwargs.get("response_format")
        name = getattr(schema, "__name__", "")
        messages = kwargs.get("messages", [])
        # Scan the whole conversation: the original chunk message persists across the gateway's
        # repair retries, so a poisoned chunk stays invalid instead of "healing" on retry.
        conversation = " ".join(str(m.get("content", "")) for m in messages)
        if invalid_for and invalid_for in conversation and name.endswith("Extraction"):
            return completion_response("this is not valid json for the schema")
        return completion_response(json.dumps(payloads.get(name, {})))

    return _fn


@pytest.fixture
def gateway_factory() -> Callable[..., ModelGateway]:
    """Build a ModelGateway with injected fns; embedding defaults to the deterministic fake."""

    def _build(*, completion: CompletionFn, embedding: EmbeddingFn | None = None) -> ModelGateway:
        return ModelGateway(
            _fake_capabilities(),
            completion_fn=completion,
            embedding_fn=embedding or embedding_fn,
        )

    return _build


@pytest.fixture
def make_completion() -> Callable[..., CompletionFn]:
    """Expose :func:`canned_completion` to tests as a fixture."""
    return canned_completion


@pytest.fixture(scope="session")
def pg_dsn() -> Iterator[str]:
    """Start the AGE+pgvector container once per session; yield an async DSN."""
    container = PostgresContainer(
        _IMAGE, username="rsc_brain", password=_PASSWORD, dbname="rsc_brain"
    ).with_command("postgres -c shared_preload_libraries=age")
    with container as running:
        host = running.get_container_host_ip()
        port = running.get_exposed_port(5432)
        yield f"postgresql+asyncpg://rsc_brain:{_PASSWORD}@{host}:{port}/rsc_brain"


@pytest.fixture(scope="session")
def migrated_dsn(pg_dsn: str) -> Iterator[str]:
    """Apply migrations to head against the container; yield the DSN."""
    previous = os.environ.get(DSN_ENV_VAR)
    os.environ[DSN_ENV_VAR] = pg_dsn
    try:
        upgrade_to_head()
        yield pg_dsn
    finally:
        if previous is None:
            os.environ.pop(DSN_ENV_VAR, None)
        else:
            os.environ[DSN_ENV_VAR] = previous
