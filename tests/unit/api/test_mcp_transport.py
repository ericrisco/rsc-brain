"""Transport contract for the MCP endpoint mounted in the combined ASGI app."""

from __future__ import annotations

import gc
import warnings
from collections.abc import Callable

import httpx
import pytest
from fastapi import FastAPI

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.config.models import IngressConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker


@pytest.fixture
def app_no_db(gateway_factory: Callable[..., ModelGateway]) -> FastAPI:
    """Build the combined app without opening a database connection."""

    async def _completion(**_: object) -> object:  # pragma: no cover - never invoked
        raise AssertionError

    engine = make_engine("postgresql+asyncpg://u:p@localhost:5432/none")
    deps = ApiDeps(
        sessionmaker=make_sessionmaker(engine),
        gateway=gateway_factory(completion=_completion),
    )
    return create_app(deps=deps)


@pytest.fixture
def public_app_no_db(gateway_factory: Callable[..., ModelGateway]) -> FastAPI:
    """Build an app configured for one public HTTPS origin without opening the database."""

    async def _completion(**_: object) -> object:  # pragma: no cover - never invoked
        raise AssertionError

    engine = make_engine("postgresql+asyncpg://u:p@localhost:5432/none")
    deps = ApiDeps(
        sessionmaker=make_sessionmaker(engine),
        gateway=gateway_factory(completion=_completion),
        ingress=IngressConfig(public_origin="https://brain.example.com"),
    )
    return create_app(deps=deps)


@pytest.fixture
def app_for_public_origin(
    gateway_factory: Callable[..., ModelGateway],
) -> Callable[[str], FastAPI]:
    """Build an isolated app for a caller-supplied public origin."""

    async def _completion(**_: object) -> object:  # pragma: no cover - never invoked
        raise AssertionError

    def _build(public_origin: str) -> FastAPI:
        engine = make_engine("postgresql+asyncpg://u:p@localhost:5432/none")
        deps = ApiDeps(
            sessionmaker=make_sessionmaker(engine),
            gateway=gateway_factory(completion=_completion),
            ingress=IngressConfig(public_origin=public_origin),
        )
        return create_app(deps=deps)

    return _build


async def test_streamable_http_mcp_is_served_at_public_mcp_path(app_no_db: FastAPI) -> None:
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "transport-test", "version": "1.0"},
        },
    }
    async with app_no_db.router.lifespan_context(app_no_db):
        transport = httpx.ASGITransport(app=app_no_db)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
            follow_redirects=False,
        ) as client:
            response = await client.post(
                "/mcp",
                json=initialize,
                headers={
                    "Accept": "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
            )
            status_code = response.status_code
            body = response.text
            await response.aclose()

    # mcp's SSE response leaves its internal receive stream for cyclic GC after the response is
    # complete. Collect it here so the SDK's ResourceWarning cannot escape into the next test.
    del response
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore", message=r"Unclosed <MemoryObjectReceiveStream.*", category=ResourceWarning
        )
        gc.collect()

    assert status_code == 200
    assert '"serverInfo":{"name":"rsc-brain"' in body


async def test_mcp_mount_preserves_rest_routing_and_unknown_404(app_no_db: FastAPI) -> None:
    transport = httpx.ASGITransport(app=app_no_db)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        rest_response = await client.get("/api/v1/ingest/runs")
        unknown_response = await client.get("/not-a-real-route")

    assert rest_response.status_code == 401
    assert unknown_response.status_code == 404


async def test_mcp_allows_configured_public_host_and_rejects_attacker(
    public_app_no_db: FastAPI,
) -> None:
    async with public_app_no_db.router.lifespan_context(public_app_no_db):
        transport = httpx.ASGITransport(app=public_app_no_db)
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            allowed = await client.get(
                "https://brain.example.com/mcp",
                headers={"Origin": "https://brain.example.com"},
            )
            blocked = await client.get(
                "https://attacker.example/mcp",
                headers={"Origin": "https://brain.example.com"},
            )
            blocked_origin = await client.get(
                "https://brain.example.com/mcp",
                headers={"Origin": "https://attacker.example"},
            )
            blocked_port = await client.get(
                "https://brain.example.com:8443/mcp",
                headers={"Origin": "https://brain.example.com"},
            )

    assert allowed.status_code == 406
    assert "Client must accept text/event-stream" in allowed.text
    assert blocked.status_code == 421
    assert blocked_origin.status_code == 403
    assert blocked_port.status_code == 421


@pytest.mark.parametrize(
    ("configured_origin", "normalized_origin", "explicit_host", "wrong_port"),
    [
        (
            "https://brain.example.com:443",
            "https://brain.example.com",
            "brain.example.com:443",
            8443,
        ),
        (
            "http://brain.example.com:80",
            "http://brain.example.com",
            "brain.example.com:80",
            8080,
        ),
    ],
)
async def test_mcp_normalizes_only_the_configured_default_port(
    app_for_public_origin: Callable[[str], FastAPI],
    configured_origin: str,
    normalized_origin: str,
    explicit_host: str,
    wrong_port: int,
) -> None:
    app = app_for_public_origin(configured_origin)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            normalized = await client.get(
                f"{normalized_origin}/mcp", headers={"Origin": normalized_origin}
            )
            explicit = await client.get(
                f"{normalized_origin}/mcp",
                headers={"Host": explicit_host, "Origin": configured_origin},
            )
            blocked = await client.get(
                f"{normalized_origin.split('://', 1)[0]}://brain.example.com:{wrong_port}/mcp",
                headers={"Origin": normalized_origin},
            )

    assert normalized.status_code == 406
    assert explicit.status_code == 406
    assert blocked.status_code == 421


async def test_mcp_punycode_origin_does_not_alias_a_different_ascii_host(
    app_for_public_origin: Callable[[str], FastAPI],
) -> None:
    configured_origin = "https://xn--fa-hia.de"
    app = app_for_public_origin(configured_origin)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            allowed = await client.get(
                f"{configured_origin}/mcp",
                headers={"Origin": configured_origin},
            )
            aliased = await client.get(
                "https://fass.de/mcp",
                headers={"Origin": "https://fass.de"},
            )

    assert allowed.status_code == 406
    assert aliased.status_code == 421


async def test_mcp_host_and_origin_are_case_insensitive(
    public_app_no_db: FastAPI,
) -> None:
    async with public_app_no_db.router.lifespan_context(public_app_no_db):
        transport = httpx.ASGITransport(app=public_app_no_db)
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            response = await client.get(
                "https://brain.example.com/mcp",
                headers={
                    "Host": "Brain.Example.COM",
                    "Origin": "HTTPS://Brain.Example.COM",
                },
            )

    assert response.status_code == 406


async def test_mcp_requires_the_exact_configured_nonstandard_port(
    app_for_public_origin: Callable[[str], FastAPI],
) -> None:
    configured_origin = "https://brain.example.com:8443"
    app = app_for_public_origin(configured_origin)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            allowed = await client.get(
                f"{configured_origin}/mcp",
                headers={"Origin": configured_origin},
            )
            blocked_origin = await client.get(
                f"{configured_origin}/mcp",
                headers={"Origin": "https://brain.example.com:9443"},
            )
            blocked_host = await client.get(
                f"{configured_origin}/mcp",
                headers={"Host": "brain.example.com", "Origin": configured_origin},
            )

    assert allowed.status_code == 406
    assert blocked_origin.status_code == 403
    assert blocked_host.status_code == 421
