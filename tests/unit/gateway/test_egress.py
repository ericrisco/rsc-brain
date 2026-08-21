"""AUDIT-005 model endpoint, DNS and redirect boundaries."""

from __future__ import annotations

import json
import threading
from collections.abc import Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from pydantic import BaseModel

from rsc_brain.config import (
    CapabilitiesConfig,
    Capability,
    CapabilityConfig,
    ModelEgressConfig,
)
from rsc_brain.gateway import GatewayEgressError, GatewayUnavailableError, ModelGateway


class _Out(BaseModel):
    value: int


class _Completion:
    def __init__(self, contents: Sequence[str] = ('{"value": 1}',)) -> None:
        self.contents = list(contents)
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        content = self.contents.pop(0)
        message = type("Message", (), {"content": content})()
        choice = type("Choice", (), {"message": message})()
        return type("Response", (), {"choices": [choice]})()


class _Embedding:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return type("Response", (), {"data": [{"embedding": [0.1] * 1024}]})()


class _Resolver:
    def __init__(self, *answers: Sequence[str] | Exception) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[str, int]] = []

    async def __call__(self, host: str, port: int) -> Sequence[str]:
        self.calls.append((host, port))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def _cap(
    *,
    api_base: str = "https://models.example.com/v1",
    allow_http: bool = False,
    allow_private: bool = False,
    fallback_model: str | None = None,
) -> CapabilityConfig:
    return CapabilityConfig(
        provider="ollama",
        model="m",
        api_base=api_base,
        fallback_model=fallback_model,
        egress=ModelEgressConfig(
            allow_http=allow_http,
            allow_private_network=allow_private,
        ),
    )


def _caps(cap: CapabilityConfig) -> CapabilitiesConfig:
    return CapabilitiesConfig(
        extractor=cap,
        judge=cap,
        topicalizer=cap,
        embedder=cap,
        reranker=cap,
    )


@pytest.mark.parametrize(
    "answer",
    [
        ["127.0.0.1"],
        ["10.0.0.8"],
        ["172.16.0.8"],
        ["192.168.1.8"],
        ["::1"],
        ["169.254.169.254"],
        ["fe80::1"],
        ["0.0.0.0"],  # noqa: S104 - an address value, never a listening interface
        ["224.0.0.1"],
        ["100.64.0.1"],
        ["192.0.2.1"],
        ["93.184.216.34", "10.0.0.8"],
        [],
    ],
)
async def test_public_policy_denies_every_non_public_or_inconclusive_answer(
    answer: Sequence[str],
) -> None:
    completion = _Completion()
    gateway = ModelGateway(
        _caps(_cap()), completion_fn=completion, endpoint_resolver=_Resolver(answer)
    )

    with pytest.raises(GatewayEgressError) as caught:
        await gateway.complete(Capability.EXTRACTOR, [{"role": "user", "content": "secret"}])

    assert caught.value.code == "model_egress_denied"
    assert completion.calls == []
    assert "models.example.com" not in str(caught.value)
    assert all(address not in str(caught.value) for address in answer)


async def test_private_grant_allows_loopback_but_never_link_local() -> None:
    completion = _Completion(contents=['{"value": 1}'])
    allowed = _cap(
        api_base="http://localhost:11434",
        allow_http=True,
        allow_private=True,
    )
    gateway = ModelGateway(
        _caps(allowed), completion_fn=completion, endpoint_resolver=_Resolver(["127.0.0.1"])
    )
    assert await gateway.complete(Capability.EXTRACTOR, []) == '{"value": 1}'

    blocked = ModelGateway(
        _caps(allowed),
        completion_fn=completion,
        endpoint_resolver=_Resolver(["169.254.169.254"]),
    )
    with pytest.raises(GatewayEgressError):
        await blocked.complete(Capability.EXTRACTOR, [])
    assert len(completion.calls) == 1


@pytest.mark.parametrize("answer", [["10.2.3.4"], ["fd00::1"]])
async def test_private_grant_allows_only_explicit_private_networks(answer: Sequence[str]) -> None:
    completion = _Completion()
    cap = _cap(allow_private=True)
    gateway = ModelGateway(
        _caps(cap), completion_fn=completion, endpoint_resolver=_Resolver(answer)
    )

    assert await gateway.complete(Capability.EXTRACTOR, []) == '{"value": 1}'
    assert len(completion.calls) == 1


async def test_dns_error_is_redacted_and_fails_before_provider() -> None:
    marker = "dns failed for secret.internal?token=do-not-leak"
    completion = _Completion()
    gateway = ModelGateway(
        _caps(_cap()),
        completion_fn=completion,
        endpoint_resolver=_Resolver(RuntimeError(marker)),
    )

    with pytest.raises(GatewayEgressError) as caught:
        await gateway.complete(Capability.EXTRACTOR, [])

    assert marker not in str(caught.value)
    assert completion.calls == []


async def test_injected_provider_seam_has_no_endpoint_to_resolve() -> None:
    completion = _Completion()
    cap = CapabilityConfig(provider="openai", model="m")
    resolver = _Resolver()
    gateway = ModelGateway(_caps(cap), completion_fn=completion, endpoint_resolver=resolver)

    assert await gateway.complete(Capability.EXTRACTOR, []) == '{"value": 1}'
    assert resolver.calls == []


async def test_production_transport_refuses_an_implicit_provider_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import litellm

    async def _network_must_not_run(**kwargs: Any) -> Any:
        raise AssertionError("provider invoked")

    monkeypatch.setattr(litellm, "acompletion", _network_must_not_run)
    cap = CapabilityConfig(provider="openai", model="m", api_key="test-key")
    gateway = ModelGateway(_caps(cap))

    with pytest.raises(GatewayEgressError) as caught:
        await gateway.complete(Capability.EXTRACTOR, [])

    assert caught.value.code == "model_egress_denied"


def test_missing_explicit_endpoint_is_reported_as_an_unresolved_capability() -> None:
    implicit = CapabilityConfig(provider="openai", model="m")
    explicit = _cap()

    assert ModelGateway(_caps(implicit)).unresolved_capabilities() == [
        "extractor",
        "judge",
        "topicalizer",
        "embedder",
        "reranker",
    ]
    assert ModelGateway(_caps(explicit)).unresolved_capabilities() == []


async def test_dns_is_rechecked_before_each_structured_repair() -> None:
    completion = _Completion(contents=["not-json", '{"value": 2}'])
    resolver = _Resolver(["93.184.216.34"], ["127.0.0.1"])
    gateway = ModelGateway(_caps(_cap()), completion_fn=completion, endpoint_resolver=resolver)

    with pytest.raises(GatewayEgressError):
        await gateway.complete_structured(Capability.EXTRACTOR, [], _Out)

    assert len(resolver.calls) == 2
    assert len(completion.calls) == 1


async def test_dns_is_rechecked_before_fallback_attempt() -> None:
    completion = _Completion(contents=["not-json", '{"value": 2}'])
    resolver = _Resolver(["93.184.216.34"], ["127.0.0.1"])
    gateway = ModelGateway(
        _caps(_cap(fallback_model="backup")),
        completion_fn=completion,
        endpoint_resolver=resolver,
        max_repair_attempts=0,
    )

    with pytest.raises(GatewayEgressError):
        await gateway.complete_structured(Capability.EXTRACTOR, [], _Out)

    assert len(resolver.calls) == 2
    assert len(completion.calls) == 1


async def test_embed_checks_egress_before_provider() -> None:
    embedding = _Embedding()
    gateway = ModelGateway(
        _caps(_cap()),
        completion_fn=_Completion(),
        embedding_fn=embedding,
        endpoint_resolver=_Resolver(["10.0.0.8"]),
    )

    with pytest.raises(GatewayEgressError):
        await gateway.embed(["private text"])

    assert embedding.calls == []


class _RedirectSource(BaseHTTPRequestHandler):
    target: str
    hits = 0

    def do_POST(self) -> None:
        type(self).hits += 1
        self.send_response(307)
        self.send_header("Location", self.target)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


class _RedirectTarget(BaseHTTPRequestHandler):
    hits = 0

    def do_POST(self) -> None:
        type(self).hits += 1
        body = json.dumps(
            {
                "response": "redirected",
                "done": True,
                "id": "chatcmpl_redirected",
                "object": "chat.completion",
                "created": 0,
                "model": "m",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "redirected"}}
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                "embeddings": [[0.1] * 1024],
                "data": [{"object": "embedding", "index": 0, "embedding": [0.1] * 1024}],
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


@pytest.mark.parametrize(
    ("provider", "operation"),
    [("ollama", "complete"), ("openai", "complete"), ("ollama", "embed"), ("openai", "embed")],
)
async def test_default_litellm_transport_does_not_follow_redirects(
    provider: str, operation: str
) -> None:
    target = ThreadingHTTPServer(("127.0.0.1", 0), _RedirectTarget)
    source = ThreadingHTTPServer(("127.0.0.1", 0), _RedirectSource)
    _RedirectSource.hits = 0
    _RedirectTarget.hits = 0
    _RedirectSource.target = f"http://127.0.0.1:{target.server_port}/private"
    threads = [
        threading.Thread(target=server.serve_forever, daemon=True) for server in (source, target)
    ]
    for thread in threads:
        thread.start()
    try:
        cap = CapabilityConfig(
            provider=provider,
            model="m",
            api_base=f"http://127.0.0.1:{source.server_port}",
            api_key="test-key",
            egress=ModelEgressConfig(allow_http=True, allow_private_network=True),
        )
        gateway = ModelGateway(_caps(cap))

        with pytest.raises(GatewayUnavailableError):
            if operation == "complete":
                await gateway.complete(Capability.EXTRACTOR, [{"role": "user", "content": "x"}])
            else:
                await gateway.embed(["x"])

        assert _RedirectSource.hits >= 1
        assert _RedirectTarget.hits == 0
    finally:
        source.shutdown()
        target.shutdown()
        source.server_close()
        target.server_close()
