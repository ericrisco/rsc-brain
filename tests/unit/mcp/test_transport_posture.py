"""The DNS-rebinding posture survives the trip from configuration to the ASGI app.

mcp 2.0 moved `transport_security` and `stateless_http` out of the server constructor and into
`streamable_http_app()`. That relocation is silent in the worst way: a mount site that simply
stops passing the settings still builds a working server, still serves every tool, and still
passes every other test in this suite — it just answers to any `Host` and any `Origin`, which is
the whole attack the SDK's protection exists to stop.

Nothing asserted this before the migration (the only prior mention of "rebinding" in the tests was
the documentation-coverage check). So this is the test that makes the posture observable: it drives
the real ASGI app the API mounts, with a hostile host and with the configured one.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, cast

import pytest
from mcp.types import Tool as MCPTool
from starlette.requests import Request
from starlette.testclient import TestClient

from rsc_brain.mcp.server import AuthorizedSkillMCP

_PUBLIC_ORIGIN = "https://brain.example.com"
_LIST_TOOLS = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
_HEADERS = {"content-type": "application/json", "accept": "application/json, text/event-stream"}


def _server() -> AuthorizedSkillMCP:
    server = AuthorizedSkillMCP(name="rsc-brain")
    server.configure_transport(stateless=True, public_origin=_PUBLIC_ORIGIN)
    return server


def test_a_host_the_deployment_never_configured_is_refused() -> None:
    with TestClient(_server().mcp_app()) as client:
        response = client.post(
            "/mcp",
            json=_LIST_TOOLS,
            headers={**_HEADERS, "host": "evil.example", "origin": "https://evil.example"},
        )
    assert response.status_code == 421, response.text


def test_the_configured_public_origin_is_admitted() -> None:
    with TestClient(_server().mcp_app()) as client:
        response = client.post(
            "/mcp",
            json=_LIST_TOOLS,
            headers={**_HEADERS, "host": "brain.example.com", "origin": _PUBLIC_ORIGIN},
        )
    assert response.status_code == 200, response.text


def test_the_callers_own_skills_reach_the_wire() -> None:
    """A per-request skill appears in `tools/list`, serialized like a registered tool.

    This is the property the mcp 2.0 migration put at risk. `list_tools()` no longer receives a
    context, so the per-principal catalogue moved to a middleware — and the first version of that
    middleware silently returned the unmodified result, because it expected a `ListToolsResult`
    model where the dispatcher actually hands over a serialized dict. Every static tool still
    answered, so only the DB-backed discovery tests noticed. This asserts it without a database.
    """
    server = _server()

    async def _visible(_request: Request | None) -> list[MCPTool]:
        return [MCPTool(name="skill_payroll", inputSchema={"type": "object"})]

    async def _run(
        _request: Request | None, name: str, arguments: dict[str, object]
    ) -> dict[str, object]:
        return {"invoked": name}

    server.configure_dynamic_skills(_visible, _run)

    with TestClient(server.mcp_app()) as client:
        response = client.post(
            "/mcp",
            json=_LIST_TOOLS,
            headers={**_HEADERS, "host": "brain.example.com", "origin": _PUBLIC_ORIGIN},
        )

    assert response.status_code == 200, response.text
    payload = json.loads(response.text.split("data: ", 1)[1])
    listed = payload["result"]["tools"]
    by_name = {tool["name"]: tool for tool in listed}
    assert "skill_payroll" in by_name, listed
    # Serialized the way the dispatcher serializes its own: aliased key, no nulls.
    assert by_name["skill_payroll"]["inputSchema"] == {"type": "object"}
    assert "title" not in by_name["skill_payroll"]


async def test_a_changed_dispatcher_contract_fails_loudly() -> None:
    """An unrecognized result shape raises instead of quietly dropping every skill."""
    server = _server()

    async def _visible(_request: Request | None) -> list[MCPTool]:
        return [MCPTool(name="skill_payroll", inputSchema={"type": "object"})]

    async def _run(
        _request: Request | None, name: str, arguments: dict[str, object]
    ) -> dict[str, object]:
        return {"invoked": name}

    server.configure_dynamic_skills(_visible, _run)

    async def _returns_a_shape_we_do_not_know(_ctx: object) -> str:
        return "surprise"

    context = SimpleNamespace(method="tools/list", request=None)
    with pytest.raises(RuntimeError, match="result contract changed"):
        await server._extend_catalogue(
            cast(Any, context), cast(Any, _returns_a_shape_we_do_not_know)
        )


@pytest.mark.parametrize("client_version", ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"])
def test_every_published_protocol_version_still_initializes(client_version: str) -> None:
    """A client that spoke to the 1.x server still completes the handshake against 2.0.

    This is the product-facing risk of the SDK major bump: the MCP endpoint is how Claude and
    ChatGPT reach the company memory, and a server that answered only the newest protocol revision
    would silently stop serving every client already deployed. mcp 2.0 raised its own
    `LATEST_PROTOCOL_VERSION` to `2026-07-28`, so this pins what the server actually negotiates
    rather than trusting that a version list stays generous.

    Measured alongside this: a client requesting `2026-07-28` is answered `2025-11-25`, because the
    newest revision needs the SDK's separate modern-transport path. The migration therefore changes
    no protocol behaviour for any client — which is the intent.
    """
    with TestClient(_server().mcp_app()) as client:
        response = client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": client_version,
                    "capabilities": {},
                    "clientInfo": {"name": "probe", "version": "1"},
                },
            },
            headers={**_HEADERS, "host": "brain.example.com", "origin": _PUBLIC_ORIGIN},
        )

    assert response.status_code == 200, response.text
    negotiated = json.loads(response.text.split("data: ", 1)[1])["result"]["protocolVersion"]
    assert negotiated == client_version
