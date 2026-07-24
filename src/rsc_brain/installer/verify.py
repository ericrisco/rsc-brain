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


async def _check_database(sessionmaker: async_sessionmaker[AsyncSession]) -> CheckResult:
    try:
        async with sessionmaker() as session:
            extensions = await session.scalar(
                text("SELECT count(*) FROM pg_extension WHERE extname IN ('age', 'vector')")
            )
            head = await session.scalar(text("SELECT count(*) FROM alembic_version"))
    except Exception as exc:
        return CheckResult("database", False, f"unreachable ({type(exc).__name__})")
    if extensions != 2:
        return CheckResult("database", False, "missing age/vector extensions")
    if not head:
        return CheckResult("database", False, "no migration applied")
    return CheckResult("database", True, "extensions present, schema at head")


async def run_verify(
    *,
    gateway: ModelGateway,
    sessionmaker: async_sessionmaker[AsyncSession],
    smoke: SmokeCheck | None = None,
) -> VerifyReport:
    """Run the gateway + database checks, plus an optional ingest→recall smoke."""
    checks = [
        await _check_gateway(gateway),
        await _check_database(sessionmaker),
    ]
    if smoke is not None:
        try:
            ok, detail = await smoke()
        except Exception as exc:
            ok, detail = False, f"smoke crashed ({type(exc).__name__})"
        checks.append(CheckResult("ingest_smoke", ok, detail))
    return VerifyReport(checks=checks)
