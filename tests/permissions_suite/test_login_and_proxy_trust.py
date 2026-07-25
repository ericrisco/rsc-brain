"""Login abuse and proxy trust (AUDIT-038 / R09 + R51, T003 RED).

**R09.** ``sessions.login`` looks the email up and, when it exists, verifies argon2id — on every
attempt, with no per-account or per-source budget. Two consequences:

* brute force is bounded only by argon2's cost, and that cost is the server's, not the attacker's:
  each attempt burns a hash on our CPU, so the same request stream is also a cheap denial of service;
* an unknown email returns BEFORE the verify, a known one after it. That difference is an account
  enumeration oracle, and it is measurable from outside regardless of how uniform the response body
  is.

The enumeration check here counts hash invocations instead of timing wall clocks. The observable is
the same difference an attacker measures, but the assertion is deterministic — a timing-band test on a
loaded CI machine is a coin flip, and a flaky security test gets muted.

**R51.** OAuth metadata is built from ``str(request.base_url)`` (``api/oauth/routes.py``), which
derives from the request's own ``Host``/scheme. With no trusted-proxy policy, a direct client that
sends ``Host: attacker.example`` receives an issuer and three endpoint URLs on the attacker's host.
A client that discovers metadata that way then sends its authorization code and token requests
there — so a header turns into credential redirection.

Not covered here: the two-replica concurrent burst (R09's third criterion), which needs the shared
limiter's storage contract T005 introduces; asserting it now would fail on a missing API rather than
on behaviour.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain import security
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity import sessions
from rsc_brain.identity.service import IdentityService
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

PASSWORD = "correct horse battery staple"  # test fixture credential, never real

#: Attempts a single source/account may make before expensive verification stops. The ratified
#: threshold is a deployment setting; what R09 fixes is that there is none at all, so this file uses a
#: number far above any plausible human retry and still expects the limiter to have engaged.
ABUSIVE_ATTEMPTS = 25


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _existing_user(harness: Harness) -> str:
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('victim')}@example.com"
    issued = await identity.invite_user(email, role="member")
    await identity.accept_invitation(issued.token, PASSWORD)
    return email


async def test_repeated_failures_stop_consuming_the_password_hash(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """R09: over the threshold, expensive verification must be refused before it runs.

    Counting the hash is the point: an implementation that answers 401 but keeps hashing has fixed
    nothing — the attacker still spends our CPU, and the limit is not a limit.
    """
    harness = build_harness()
    email = await _existing_user(harness)

    calls = 0
    real_verify = security.verify_password

    def _counting_verify(stored: str, candidate: str) -> bool:
        nonlocal calls
        calls += 1
        return real_verify(stored, candidate)

    monkeypatch.setattr(security, "verify_password", _counting_verify)

    for _ in range(ABUSIVE_ATTEMPTS):
        assert await sessions.login(harness.sm, email, "wrong-password") is None

    assert calls < ABUSIVE_ATTEMPTS, (
        f"{calls} of {ABUSIVE_ATTEMPTS} failed attempts each consumed a full argon2id verification — "
        "brute force is limited only by our own CPU cost, which makes the same stream a denial of "
        "service"
    )


async def test_a_known_and_an_unknown_account_cost_the_same(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """R09: account existence must not be disclosed by the work performed.

    The response body is already uniform; the WORK is not. An unknown email returns before the
    verify, so the two paths differ measurably — the standard fix is to verify against a dummy hash so
    both cost the same.
    """
    harness = build_harness()
    email = await _existing_user(harness)

    counts = {"known": 0, "unknown": 0}
    current = "known"
    real_verify = security.verify_password

    def _counting_verify(stored: str, candidate: str) -> bool:
        counts[current] += 1
        return real_verify(stored, candidate)

    monkeypatch.setattr(security, "verify_password", _counting_verify)

    assert await sessions.login(harness.sm, email, "wrong-password") is None
    current = "unknown"
    assert await sessions.login(harness.sm, f"{unique_slug('ghost')}@example.com", "x") is None

    assert counts["known"] == counts["unknown"], (
        f"a known account cost {counts['known']} verification(s) and an unknown one "
        f"{counts['unknown']} — the difference is an enumeration oracle measurable from outside"
    )


async def test_the_login_endpoint_rate_limits_before_the_response_is_uniform(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R09 through the real HTTP surface: the burst has to be refused, not merely answered 401.

    A limiter must be visible in the outcome — a distinct status (429) or a retry hint — because a
    caller cannot otherwise distinguish "wrong password" from "stop".
    """
    harness = build_harness()
    email = await _existing_user(harness)

    statuses: list[int] = []
    async with _client(harness, tmp_path) as client:
        for _ in range(ABUSIVE_ATTEMPTS):
            response = await client.post(
                "/api/v1/auth/login", json={"email": email, "password": "wrong-password"}
            )
            statuses.append(response.status_code)

    assert any(code == 429 for code in statuses), (
        f"{ABUSIVE_ATTEMPTS} consecutive failures were all answered {set(statuses)} — no attempt was "
        "ever rate limited"
    )


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "attacker.example"},
        {"Host": "attacker.example", "X-Forwarded-Proto": "http"},
        {"X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https"},
    ],
    ids=["host", "host+proto", "forwarded-host"],
)
async def test_oauth_metadata_ignores_untrusted_forwarding_headers(
    headers: dict[str, str], build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R51: a direct client's headers must not decide the issuer or any endpoint URL.

    This is the whole exploit: an OAuth client that discovers metadata from a spoofed Host sends its
    authorization code and token request to the host named there.
    """
    harness = build_harness()
    async with _client(harness, tmp_path) as client:
        response = await client.get("/.well-known/oauth-authorization-server", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    reflected = {
        key: value
        for key, value in body.items()
        if isinstance(value, str) and "attacker.example" in value
    }
    assert not reflected, (
        "OAuth metadata reflected an untrusted client's forwarding headers, so a spoofed request "
        f"redirects credentials to the attacker's host: {reflected}"
    )


async def test_oauth_metadata_advertises_a_secure_external_origin(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R51's other half: the advertised origin has to be the configured PUBLIC one.

    OAuth-capable endpoints are never advertised over plaintext (AUDIT-038 acceptance), and the
    external origin behind a proxy is a deployment fact, not something the request can imply.
    """
    harness = build_harness()
    async with _client(harness, tmp_path) as client:
        response = await client.get("/.well-known/oauth-authorization-server")

    assert response.status_code == 200, response.text
    body = response.json()
    issuer = str(body["issuer"])
    assert not issuer.startswith("http://test"), (
        f"the issuer is derived from the request rather than from configuration: {issuer!r}"
    )
