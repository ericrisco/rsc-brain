"""The external origin a response may advertise (AUDIT-038 / R51).

Anything a client can set is not evidence about how the service is reached. ``Host``,
``X-Forwarded-Host`` and ``X-Forwarded-Proto`` all arrive from whoever connected, so deriving OAuth
metadata from them means a direct client sending ``Host: attacker.example`` receives an issuer and
three endpoint URLs on the attacker's host — and an OAuth client that discovers metadata that way
sends its authorization code and token request there.

The resolution order is therefore:

1. the configured ``ingress.public_origin`` — a deployment fact, and the only trustworthy answer;
2. otherwise, the request's own origin, but only when the immediate peer is a configured trusted
   proxy, since that is the one case where forwarding headers were set by us;
3. otherwise a scheme/host with no client influence at all.

Case 3 exists so a misconfigured deployment fails towards "wrong but harmless" instead of "attacker
controlled": a metadata document nobody can use is recoverable, credentials sent to an attacker are
not.
"""

from __future__ import annotations

import ipaddress

from fastapi import Request

from rsc_brain.config.models import IngressConfig

#: What an unconfigured deployment advertises. Deliberately not derived from the request.
UNCONFIGURED_ORIGIN = "https://localhost"


def _peer_is_trusted(request: Request, trusted: list[str]) -> bool:
    """Whether the immediate peer is a configured trusted proxy.

    The *immediate* peer, never a forwarded address: the whole point is that the forwarded chain is
    attacker-supplied until something we trust vouches for it.
    """
    if not trusted:
        return False
    client = request.client
    if client is None:
        return False
    try:
        address = ipaddress.ip_address(client.host)
    except ValueError:
        return False
    for entry in trusted:
        try:
            if address in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue
    return False


def external_origin(request: Request, ingress: IngressConfig | None) -> str:
    """The scheme+host this response may advertise, with no client influence unless it is trusted."""
    configured = (ingress.public_origin if ingress else None) or None
    if configured:
        return configured.rstrip("/")
    if ingress and _peer_is_trusted(request, ingress.trusted_proxies):
        return str(request.base_url).rstrip("/")
    return UNCONFIGURED_ORIGIN
