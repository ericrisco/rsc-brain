"""Every ratified route, traversed through a REAL proxy (AUDIT-046 / R56).

R45-R48 fixed the route map and are checked by parsing configuration. R56 exists because that is not
enough: a config assertion can pass on a file whose directives are correct individually and wrong in
order, and it cannot see the proxy's own matching rules at all. So this brings up the actual Caddy with
the actual `Caddyfile` and asks it, over HTTP, which upstream owns each path.

The upstreams are stand-ins that report their own identity, not the product's containers. That is
deliberate: the property under test is the EDGE's decision — "which service owns this path" — and using
the real images would mean building two of them to learn something they are not what decides. Everything
behind those routes is covered by the rest of the suite; nothing else covers the proxy.

Skips when Docker is unavailable. Marked ``e2e`` so it can be selected or excluded on its own.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.e2e]

REPO_ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = REPO_ROOT / "Caddyfile"

#: The ratified ownership map (plan §3 `edge.route`), as a black-box expectation: request path → the
#: service that must answer it. Kept here in the terms an operator would use, not in the proxy's terms.
ROUTES: tuple[tuple[str, str], ...] = (
    ("/api/v1/health", "service"),
    ("/mcp", "service"),
    ("/oauth/authorize", "service"),
    ("/.well-known/oauth-authorization-server", "service"),
    ("/metrics", "service"),
    # The console owns the root AND its own Next.js route handlers — the two that R45/R48 sent to the
    # service, which left console login working locally and answering 404 behind the proxy.
    ("/", "console"),
    ("/projects", "console"),
    ("/_next/static/chunk.js", "console"),
    ("/api/auth/session", "console"),
    ("/api/proxy/recall", "console"),
)

_UPSTREAM_IMAGE = "traefik/whoami:v1.10"
_CADDY_IMAGE = "caddy:2.8-alpine"


def _docker() -> str:
    binary = shutil.which("docker")
    if binary is None:
        pytest.skip("docker not available (this check needs a real proxy)")
    if subprocess.run([binary, "info"], capture_output=True, check=False).returncode != 0:
        pytest.skip("docker is installed but not running")
    return binary


def _run(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def live_edge() -> Iterator[str]:
    """Caddy, configured by the repository's own Caddyfile, in front of two identifiable upstreams."""
    docker = _docker()
    suffix = uuid.uuid4().hex[:8]
    network = f"rsc-edge-{suffix}"
    service = f"rsc-service-{suffix}"
    console = f"rsc-console-{suffix}"
    proxy = f"rsc-caddy-{suffix}"
    started: list[str] = []
    try:
        _run(docker, "network", "create", network)
        for name, port in ((service, "8080"), (console, "3000")):
            _run(
                docker,
                "run",
                "-d",
                "--name",
                name,
                "--network",
                network,
                "-e",
                f"WHOAMI_NAME={name}",
                "-e",
                f"WHOAMI_PORT_NUMBER={port}",
                _UPSTREAM_IMAGE,
            )
            started.append(name)
        _run(
            docker,
            "run",
            "-d",
            "--name",
            proxy,
            "--network",
            network,
            "-p",
            "0:80",
            "-v",
            f"{CADDYFILE}:/etc/caddy/Caddyfile:ro",
            "-e",
            "RSC_BRAIN_DOMAIN=:80",
            "-e",
            f"RSC_BRAIN_APP_UPSTREAM={service}:8080",
            "-e",
            f"RSC_BRAIN_CONSOLE_UPSTREAM={console}:3000",
            _CADDY_IMAGE,
        )
        started.append(proxy)
        published = json.loads(_run(docker, "inspect", proxy))[0]["NetworkSettings"]["Ports"]
        mapped = published.get("80/tcp")
        if not mapped:
            # Caddy exited: almost always a Caddyfile it refused to parse, which is exactly the failure
            # this check should report clearly rather than as a KeyError on a port that never opened.
            logs = subprocess.run(
                [docker, "logs", proxy], capture_output=True, text=True, check=False
            )
            pytest.fail(
                "the proxy never published a port — Caddy refused to start:\n"
                + (logs.stdout + logs.stderr)[-2000:]
            )
        host_port = mapped[0]["HostPort"]
        base = f"http://127.0.0.1:{host_port}"
        _await_ready(base, proxy, docker)
        yield base
    finally:
        for name in reversed(started):
            subprocess.run([docker, "rm", "-f", name], capture_output=True, check=False)
        subprocess.run([docker, "network", "rm", network], capture_output=True, check=False)


def _await_ready(base: str, proxy: str, docker: str) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base}/", timeout=2) as response:  # noqa: S310
                if response.status:
                    return
        except (urllib.error.URLError, OSError, TimeoutError):
            time.sleep(1)
    logs = subprocess.run(
        [docker, "logs", proxy], capture_output=True, text=True, check=False
    ).stdout
    pytest.fail(f"the proxy never answered; caddy logs:\n{logs[-2000:]}")


def _who_answered(base: str, path: str) -> str:
    """The upstream that served ``path``, from the identity it reports about itself."""
    request = urllib.request.Request(f"{base}{path}")  # noqa: S310
    try:
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # a routed 4xx still tells us who answered
        body = exc.read().decode("utf-8", "replace")
    if "rsc-service-" in body:
        return "service"
    if "rsc-console-" in body:
        return "console"
    return f"nobody ({body.strip()[:80]!r})"


def test_every_ratified_route_reaches_its_owner_through_a_real_proxy(live_edge: str) -> None:
    """The one check in this program that a wrong configuration cannot pass by looking right.

    Each path is requested through Caddy, and the answer says which upstream served it. A directive in
    the wrong order, a match that is subtly broader than intended, or a proxy rule the parser does not
    model all show up here and nowhere else.
    """
    wrong: list[str] = []
    for path, expected in ROUTES:
        answered = _who_answered(live_edge, path)
        if answered != expected:
            wrong.append(f"{path} → {answered} (expected {expected})")
    assert not wrong, "the live edge routes these paths to the wrong service:\n" + "\n".join(wrong)


def test_an_unclaimed_path_belongs_to_the_console(live_edge: str) -> None:
    """The map has a default owner, and it is the UI.

    An unmatched path reaching the API would expose the service's error surface at the product's root;
    reaching nothing at all would make every console page a 404 the moment someone adds a route.
    """
    assert _who_answered(live_edge, f"/whatever-{uuid.uuid4().hex[:6]}") == "console"
