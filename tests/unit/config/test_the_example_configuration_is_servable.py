"""The shipped example configuration must name models the provider can serve (AUDIT-129).

`config.example.yaml` named `bge-reranker-v2-m3` for the reranker. It is a real, well-known
cross-encoder and it is the wrong thing here twice over:

- it is not in ollama's library — `ollama pull bge-reranker-v2-m3` answers *"file does not exist"*;
- `LlmReranker` asks a **chat** model for JSON scores validated against `ScoresOut`, which is not an
  interface a cross-encoder has.

Measured: `brain verify --probe-models` on that configuration reports
`unhealthy capabilities: ['reranker']`. The probe works — but the operator hit it on their first
install, over a name that looks exactly right.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[3]
EXAMPLE = REPO / "config.example.yaml"
#: Capabilities the gateway calls with a chat completion and a response schema.
CHAT_CAPABILITIES = ("extractor", "judge", "topicalizer", "reranker")


def _capabilities() -> dict[str, dict[str, object]]:
    loaded = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))
    capabilities = loaded["capabilities"]
    assert isinstance(capabilities, dict)
    return capabilities


def test_every_chat_capability_names_a_chat_model() -> None:
    """The reranker speaks the judge's interface, so it must name a model of the same kind.

    Asserted as "one of the models the other chat capabilities use", because that is checkable here
    without a network call and it is the property that was violated: a cross-encoder cannot answer a
    chat completion, whoever serves it.
    """
    capabilities = _capabilities()
    chat_models = {
        str(capabilities[name]["model"]) for name in CHAT_CAPABILITIES if name in capabilities
    }
    reranker = str(capabilities["reranker"]["model"])
    others = {
        str(capabilities[name]["model"])
        for name in ("extractor", "judge", "topicalizer")
        if name in capabilities
    }

    assert reranker in others, (
        f"the reranker names {reranker!r}, which no other chat capability uses. It is called with a "
        f"chat completion and a response schema, exactly like {sorted(others)} — a model that cannot "
        "answer one produces `unhealthy capabilities: ['reranker']` on first install."
    )
    assert "reranker" not in {model.split(":")[0] for model in chat_models}, (
        "a model whose name says 'reranker' is almost certainly a cross-encoder, which this seam "
        "cannot call"
    )


def test_the_embedder_is_not_a_chat_model() -> None:
    """The complement: the embedder is called with an embedding request, so it must not be one of the
    chat models either."""
    capabilities = _capabilities()
    embedder = str(capabilities["embedder"]["model"])
    chat = {
        str(capabilities[name]["model"])
        for name in ("extractor", "judge", "topicalizer", "reranker")
        if name in capabilities
    }

    assert embedder not in chat, f"the embedder names {embedder!r}, which is used as a chat model"


def test_no_shipped_configuration_names_a_cross_encoder_as_the_reranker() -> None:
    """AUDIT-085 fixed this in the Compose defaults and stopped there.

    Two places kept the unservable name: `config.example.yaml` — the file the getting-started tutorial
    tells the reader to use — and `deploy/helm/e2e.sh`, the Kubernetes end-to-end script. An
    incomplete fix is the shape this campaign finds most often, so the property is asserted across
    every shipped configuration surface rather than per file.
    """
    surfaces = [
        REPO / "config.example.yaml",
        REPO / "deploy" / "docker-compose.prod.yml",
        REPO / "deploy" / "docker-compose.version.yml",
        REPO / "deploy" / "helm" / "e2e.sh",
        REPO / "deploy" / "helm" / "rsc-brain" / "values.yaml",
    ]
    offenders = [
        path.relative_to(REPO).as_posix()
        for path in surfaces
        if path.is_file()
        # The prose explaining why the name is wrong necessarily contains it; a VALUE assignment does
        # not sit inside a comment.
        and any(
            "bge-reranker" in line and not line.lstrip().startswith("#")
            for line in path.read_text(encoding="utf-8").splitlines()
        )
    ]

    assert not offenders, (
        "these shipped configurations name a cross-encoder as the reranker model, which the "
        f"LLM-based seam cannot call: {offenders}"
    )
