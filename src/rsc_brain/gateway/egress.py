"""Fail-closed endpoint checks for explicit model routes (AUDIT-005)."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Sequence
from typing import Any
from urllib.parse import urlsplit

from rsc_brain.config.models import CapabilityConfig
from rsc_brain.gateway.errors import GatewayEgressError

EndpointResolver = Callable[[str, int], Awaitable[Sequence[str]]]
_PRIVATE_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("fc00::/7"),
)


def _ref() -> str:
    # Importing the model gateway's private helper would create a cycle. Egress errors preserve the
    # same opaque, random reference shape without sharing implementation state.
    import uuid

    return uuid.uuid4().hex[:12]


async def resolve_endpoint(host: str, port: int) -> Sequence[str]:
    """Resolve every stream address without blocking the event loop."""

    def _lookup() -> tuple[str, ...]:
        rows = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        return tuple(dict.fromkeys(str(row[4][0]) for row in rows))

    return await asyncio.to_thread(_lookup)


def _address_allowed(address: str, *, allow_private: bool) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return _address_allowed(str(ip.ipv4_mapped), allow_private=allow_private)

    # These classes are never model destinations. In particular, the private-network grant must
    # not turn the cloud metadata link-local range into a valid model route.
    if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        return False
    # Python correctly labels loopback as reserved too; it is the one reserved class the explicit
    # local-network grant exists to support (Ollama on 127.0.0.1 / ::1).
    if ip.is_loopback:
        return allow_private
    if ip.is_reserved:
        return False
    if ip.is_global:
        return True
    return allow_private and any(ip in network for network in _PRIVATE_NETWORKS)


async def enforce_endpoint(
    capability: CapabilityConfig,
    resolver: EndpointResolver = resolve_endpoint,
    *,
    require_explicit: bool = False,
) -> None:
    """Validate the resolved destination of one imminent provider attempt.

    Every production route must be explicit. A null endpoint exists only for injected offline/test
    adapters; otherwise it fails before LiteLLM can consult provider-specific environment defaults.
    DNS is intentionally repeated so a repair, fallback or later call cannot reuse an earlier allow
    decision.
    """

    if capability.api_base is None:
        if require_explicit:
            raise GatewayEgressError("model_egress_denied", _ref())
        return
    parsed = urlsplit(capability.api_base)
    host = parsed.hostname
    if host is None:  # defensive: configuration validation normally makes this unreachable
        raise GatewayEgressError("model_egress_denied", _ref())
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = tuple(await resolver(host, port))
    except Exception:
        raise GatewayEgressError("model_egress_denied", _ref()) from None
    if not addresses or not all(
        _address_allowed(address, allow_private=capability.egress.allow_private_network)
        for address in addresses
    ):
        raise GatewayEgressError("model_egress_denied", _ref())


def harden_litellm_redirects(litellm: object) -> None:
    """Make LiteLLM's shared async HTTP transports refuse every redirect.

    LiteLLM's OpenAI-compatible route consults ``aclient_session`` while Ollama and several native
    providers use ``module_level_aclient``. Point both at the same existing module-level HTTPX
    client and force its per-request default off. Reapplying this before every default call repairs
    accidental process-global changes by another integration.
    """

    handler = getattr(litellm, "module_level_aclient", None)
    client = getattr(handler, "client", None)
    if client is None or not hasattr(client, "follow_redirects"):
        raise RuntimeError("LiteLLM async transport cannot enforce redirect policy")
    client.follow_redirects = False
    typed_litellm: Any = litellm
    typed_litellm.aclient_session = client


def secure_litellm_http_handler() -> Any:
    """Return an isolated LiteLLM native-provider handler with redirects disabled."""

    from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler

    handler = AsyncHTTPHandler()
    handler.client.follow_redirects = False
    return handler
