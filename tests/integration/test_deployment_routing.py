"""Every deployment target routes the same paths to the same owner (AUDIT-046 / R45-R48, T009 RED).

One route map, four targets, and today each disagrees with it differently:

* **Compose/Caddy (R45)** forwards *everything* to ``api:8080``. The ``console`` service is built,
  started and unreachable: there is no route to it at all, so the product's own UI does not exist on
  its reference deployment.
* **Helm (R48)** sends ``/api`` as a prefix to the service, which swallows ``/api/auth/*`` and
  ``/api/proxy/*`` — the console's BFF. Those are Next.js route handlers; the API has never served
  them, so console login is routed to a 404.
* **Coolify (R46)** and **Dokploy (R47)** publish the api service and nothing else, so the console is
  unreachable there too, and Dokploy's Traefik labels claim the whole host for the API.

The ratified ownership map (plan §3 ``edge.route``):

    console:  /            /_next/*      /api/auth/*     /api/proxy/*
    service:  /api/v1/*    /mcp*         /oauth/*        /.well-known/*
    metrics:  /metrics     (service, but operator-protected — R10)

The tests assert the CONFIGURATION each target ships, which is what determines reachability before a
single request is made. Black-box traversal through a live proxy is R56/T010's evidence and is not
duplicated here; what this file prevents is shipping a target whose config cannot possibly work.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Paths the CONSOLE must own on every target. `/api/auth` and `/api/proxy` are Next.js route
#: handlers — the browser's session lives there — so a target that routes them to the API has no login.
CONSOLE_PATHS = ("/", "/_next/static/chunk.js", "/api/auth/session", "/api/proxy/projects")

#: Paths the SERVICE must own on every target.
SERVICE_PATHS = (
    "/api/v1/admin/projects",
    "/mcp",
    "/oauth/authorize",
    "/.well-known/oauth-authorization-server",
)


def _read(*relative: str) -> str:
    return (REPO_ROOT.joinpath(*relative)).read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# R45 — Compose + Caddy
# --------------------------------------------------------------------------- #


def _caddy_routes() -> list[tuple[str, str]]:
    """The Caddyfile's ``handle`` blocks as ``(matcher, upstream)``, in declaration order.

    Order matters: ``handle`` is first-match-wins in Caddy, so resolving a path means walking the list
    exactly as the proxy does. Substring matching would pass on a file that declares the right words in
    the wrong order — which is the same bug from the outside.
    """
    routes: list[tuple[str, str]] = []
    matcher = ""
    for line in _read("Caddyfile").splitlines():
        stripped = line.strip()
        if stripped.startswith("handle"):
            parts = stripped.split()
            matcher = parts[1] if len(parts) > 1 and parts[1] != "{" else "*"
        elif stripped.startswith("reverse_proxy") and matcher:
            routes.append((matcher, stripped))
            matcher = ""
    return routes


def _caddy_owner(path: str) -> str:
    """Which upstream Caddy sends ``path`` to, honouring first-match-wins."""
    for matcher, upstream in _caddy_routes():
        if matcher == "*":
            return upstream
        if matcher.endswith("*"):
            if path.startswith(matcher[:-1]):
                return upstream
        elif path == matcher:
            return upstream
    return ""


def test_caddy_routes_the_console_and_the_service_separately() -> None:
    """Resolved through the declared handlers, every path must reach its ratified owner."""
    routes = _caddy_routes()
    assert routes, (
        "the Caddyfile declares no path handlers, so it cannot express an ownership map: every "
        "request goes to a single upstream, and the console container runs unreachable"
    )
    for path in CONSOLE_PATHS:
        upstream = _caddy_owner(path)
        assert "console" in upstream.lower(), (
            f"{path} resolves to {upstream!r} instead of the console"
        )
    for path in SERVICE_PATHS:
        upstream = _caddy_owner(path)
        assert upstream and "console" not in upstream.lower(), (
            f"{path} resolves to {upstream!r} instead of the API service"
        )


def test_the_compose_console_is_reachable_from_the_edge() -> None:
    """A service nobody can reach is not deployed. Caddy must be able to resolve the console."""
    compose = yaml.safe_load(_read("deploy", "docker-compose.prod.yml"))
    caddy = compose["services"]["caddy"]
    upstreams = " ".join(
        f"{key}={value}" for key, value in (caddy.get("environment") or {}).items()
    )
    assert "console" in upstreams, (
        f"Caddy is configured with no console upstream: {upstreams!r} — the console container runs "
        "and nothing can route to it"
    )
    assert "console" in (caddy.get("depends_on") or []), (
        "Caddy does not depend on the console, so the edge can start pointing at a container that is "
        "not up yet"
    )


# --------------------------------------------------------------------------- #
# R46 / R47 — Coolify and Dokploy
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "overlay",
    ["docker-compose.coolify.yml", "docker-compose.dokploy.yml"],
    ids=["coolify", "dokploy"],
)
def test_a_paas_overlay_publishes_the_console_too(overlay: str) -> None:
    """The PaaS overlays must publish both surfaces, and no host/path may have two owners.

    R46 is specifically about duplicate owners: two services claiming the same host and path is a
    coin flip at deploy time, and which one wins is not something the operator chose.
    """
    compose = yaml.safe_load(_read("deploy", overlay))
    services = compose.get("services") or {}

    # Each PaaS publishes differently — Coolify through SERVICE_FQDN_* env, Dokploy through Traefik
    # labels — so "is it published" has to be asked in the target's own terms rather than by looking
    # for `ports`, which neither uses.
    def _is_published(service: dict[str, Any] | None) -> bool:
        if not service:
            return False
        environment: dict[str, Any] = service.get("environment") or {}
        labels: list[Any] = service.get("labels") or []
        labelled = any("traefik.enable" in str(label) for label in labels)
        fqdn = any(str(key).startswith("SERVICE_FQDN") for key in environment)
        return bool(labelled or fqdn or service.get("ports"))

    published = {name: service for name, service in services.items() if _is_published(service)}
    assert "console" in published, (
        f"{overlay} publishes {sorted(published)} and never the console, so the UI is unreachable on "
        "this target"
    )
    assert "api" in published, f"{overlay} does not publish the api service: {sorted(published)}"

    host_claims: list[str] = []
    for name, service in services.items():
        for label in service.get("labels") or []:
            if "rule=Host(" in str(label):
                host_claims.append(f"{name}:{label}")
    rules = [claim.split("rule=", 1)[1] for claim in host_claims]
    assert len(rules) == len(set(rules)), (
        f"{overlay} has two services claiming the same host AND path, so which one answers is the "
        f"proxy's choice rather than the operator's: {host_claims}"
    )


# --------------------------------------------------------------------------- #
# R48 — Helm
# --------------------------------------------------------------------------- #


def _render_ingress() -> list[dict[str, object]]:
    """Render the chart and return the ingress rules, so the assertion is on real output."""
    helm = shutil.which("helm")
    if helm is None:  # pragma: no cover - CI installs helm; a local run without it says so
        pytest.skip("helm is not installed")
    rendered = subprocess.run(
        [helm, "template", "rb", str(REPO_ROOT / "deploy" / "helm" / "rsc-brain")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    paths: list[dict[str, object]] = []
    for document in yaml.safe_load_all(rendered):
        if not document or document.get("kind") != "Ingress":
            continue
        for rule in document["spec"].get("rules", []):
            for entry in rule.get("http", {}).get("paths", []):
                paths.append(
                    {
                        "path": entry["path"],
                        "type": entry.get("pathType"),
                        "service": entry["backend"]["service"]["name"],
                    }
                )
    return paths


def _owner_for(paths: list[dict[str, object]], request_path: str) -> str:
    """Which backend an Ingress sends ``request_path`` to — longest prefix wins, as Kubernetes does."""
    best: tuple[int, str] = (-1, "")
    for entry in paths:
        prefix = str(entry["path"])
        matches = request_path == prefix or request_path.startswith(prefix.rstrip("/") + "/")
        if matches and len(prefix) > best[0]:
            best = (len(prefix), str(entry["service"]))
    return best[1]


def test_helm_gives_the_console_its_own_bff_routes() -> None:
    """``/api`` as a single prefix swallows the console's own endpoints.

    ``/api/auth/*`` and ``/api/proxy/*`` are Next.js route handlers — the browser's session and the
    typed proxy to the API. Routing them to the service means console login answers 404 on Kubernetes
    while working locally, which is the worst shape a routing bug can take.
    """
    paths = _render_ingress()
    assert paths, "the chart renders no ingress rules at all"
    for request_path in CONSOLE_PATHS:
        owner = _owner_for(paths, request_path)
        assert "console" in owner, (
            f"{request_path} is routed to {owner!r} instead of the console — the rendered rules are "
            f"{[(p['path'], p['service']) for p in paths]}"
        )


def test_helm_keeps_every_service_path_on_the_service() -> None:
    paths = _render_ingress()
    for request_path in SERVICE_PATHS:
        owner = _owner_for(paths, request_path)
        assert owner and "console" not in owner, (
            f"{request_path} is routed to {owner!r} instead of the API service"
        )


def test_no_path_in_the_map_is_left_unowned() -> None:
    """Every path in the ratified map resolves somewhere on every target.

    An unowned path is a 404 the operator cannot explain; two owners is a coin flip at deploy time.
    Both are the same defect from the outside, which is why the map is asserted as a whole.
    """
    for path in (*CONSOLE_PATHS, *SERVICE_PATHS, "/metrics"):
        assert _caddy_owner(path), f"Caddy leaves {path} unrouted"
    ingress = _render_ingress()
    for path in (*CONSOLE_PATHS, *SERVICE_PATHS):
        assert _owner_for(ingress, path), f"the Helm ingress leaves {path} unrouted"
