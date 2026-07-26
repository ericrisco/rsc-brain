"""`brain verify` (FR-11.2, D7): a smoke of the running system.

Checks the gateway (a real structured probe, FR-9.3), the database (extensions present + schema at
head), and — when a smoke callback is supplied — an end-to-end ingest→recall round-trip through
the MCP-shaped tools. Each check is independent and reports pass/fail with a redacted detail; the
overall verdict is the AND. A live model backend is required for the gateway check, so a full
green run is environment-dependent — the runner is real and returns a clean per-check verdict.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.stores.relational.migrations import schema_state

SmokeCheck = Callable[[], Awaitable[tuple[bool, str]]]


@dataclass(frozen=True, slots=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


@dataclass(frozen=True, slots=True)
class VerifyReport:
    checks: list[CheckResult]

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)


async def _check_gateway(gateway: ModelGateway) -> CheckResult:
    try:
        statuses = await gateway.healthcheck()
    except GatewayError as exc:
        return CheckResult("gateway", False, f"probe failed ({exc.correlation_id})")
    failed = [name for name, status in statuses.items() if not status.ok]
    if failed:
        return CheckResult("gateway", False, f"unhealthy capabilities: {sorted(failed)}")
    return CheckResult("gateway", True, "all capabilities healthy")


def _check_capabilities_configured(gateway: ModelGateway) -> CheckResult:
    """Every enabled capability RESOLVES — provider and model present — without calling anything.

    Configuration completeness is what readiness can answer locally and cheaply, and it is the failure
    an operator actually needs caught before traffic (R36): a capability with no model is broken
    whatever the provider's status page says.
    """
    unresolved = gateway.unresolved_capabilities()
    if unresolved:
        return CheckResult("capabilities", False, f"unresolved: {sorted(unresolved)}")
    return CheckResult("capabilities", True, "every capability is configured")


async def _check_database(sessionmaker: async_sessionmaker[AsyncSession]) -> CheckResult:
    try:
        async with sessionmaker() as session:
            extensions = await session.scalar(
                text("SELECT count(*) FROM pg_extension WHERE extname IN ('age', 'vector')")
            )
    except Exception as exc:
        return CheckResult("database", False, f"unreachable ({type(exc).__name__})")
    if extensions != 2:
        return CheckResult("database", False, "missing age/vector extensions")
    # T022 re-audit: this used to report "schema at head" after checking only that `alembic_version` had
    # a row, so a pod one revision behind answered Ready and served queries against a schema this build
    # does not expect. Readiness is what an installer and a load balancer both act on.
    state = schema_state()
    if not state.at_head:
        return CheckResult("database", False, state.explain())
    return CheckResult("database", True, f"extensions present, {state.explain()}")


async def run_verify(
    *,
    gateway: ModelGateway,
    sessionmaker: async_sessionmaker[AsyncSession],
    smoke: SmokeCheck | None = None,
    probe_models: bool = False,
) -> VerifyReport:
    """Readiness: configuration and the local stores, with NO model invocation (R50).

    This is what the container healthcheck runs, so whatever it does happens on a timer. Probing the
    providers here meant an outage at the provider restarted every healthy container, and a healthy
    deployment paid provider tokens on every probe. AUDIT-044 is explicit that deep dependency health
    is an authenticated operator diagnostic, so it moved behind ``probe_models=True`` (``brain doctor``
    and an explicit `--probe-models`), never the default.

    ``gateway`` is still taken so the operator diagnostic and the readiness path share one entry point
    and cannot drift into answering different questions.
    """
    checks = [
        _check_capabilities_configured(gateway),
        await _check_database(sessionmaker),
    ]
    if probe_models:
        checks.append(await _check_gateway(gateway))
    if smoke is not None:
        try:
            ok, detail = await smoke()
        except Exception as exc:
            ok, detail = False, f"smoke crashed ({type(exc).__name__})"
        checks.append(CheckResult("ingest_smoke", ok, detail))
    return VerifyReport(checks=checks)
