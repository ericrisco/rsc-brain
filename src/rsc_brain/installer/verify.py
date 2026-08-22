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

from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import Capability, HardwareProfile, RecallConfig, RerankerKind
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import Message, ModelGateway
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


def _real_probes() -> dict[Capability, tuple[list[Message], type[BaseModel]]]:
    """Each capability probed with its OWN prompt and schema.

    AUDIT-099: a generic probe cannot predict whether a capability works. Measured on a live route,
    the probe's prompt-and-schema pair passed 3/3 while swapping in either real half failed 0/3 — a
    probe prompt spells out the JSON it wants, so the model copies it. This layer may import the
    prompts, so this is where the real pairs are built; the gateway stays free of that dependency.

    The reranker is included because abstention silently reverts to the blended threshold when its
    route cannot serve `complete_structured` (AUDIT-085, AUDIT-096), which is the failure an operator
    is least able to notice.
    """
    from rsc_brain.ingest.prompts import (
        ClaimExtraction,
        EntityExtraction,
        TopicAssignment,
        load_prompt,
    )
    from rsc_brain.recall.reranker import ScoresOut

    sample = "Acme Corp is a software company founded in 2015, headquartered in Barcelona."

    def pair(prompt: str, payload: str) -> list[Message]:
        return [{"role": "system", "content": prompt}, {"role": "user", "content": payload}]

    return {
        Capability.EXTRACTOR: (pair(load_prompt("extractor_entities"), sample), EntityExtraction),
        Capability.JUDGE: (pair(load_prompt("extractor_claims"), sample), ClaimExtraction),
        Capability.TOPICALIZER: (pair(load_prompt("topicalizer"), sample), TopicAssignment),
        Capability.RERANKER: (
            pair(
                load_prompt("relevance_reranker"),
                "QUESTION: where is Acme?\n\nPASSAGES:\n[0] " + sample,
            ),
            ScoresOut,
        ),
    }


async def _check_gateway(gateway: ModelGateway) -> CheckResult:
    try:
        statuses = await gateway.healthcheck(_real_probes())
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


def _check_rerank_threshold_is_calibrated(
    kind: RerankerKind | None, *, reranker_enabled: bool, recall: RecallConfig | None
) -> CheckResult | None:
    """AUDIT-131: `tau_rerank`'s default was calibrated for the CHAT route, not this one.

    Measured — `BAAI/bge-reranker-v2-m3` (568M) on **CPU**, 8 threads, ten passages: 0.19 s warm
    against the chat reranker's 142-256 s on the same profile. So a `cpu_only` install *can* refuse
    through this route, which is the answer to AUDIT-128's open question.

    But the scale differs. The chat model puts an answer at 0.9-1.0; the cross-encoder put the same
    answer at **0.34** and the qualifier sibling at 0.003 — better separation, lower absolute numbers.
    An operator who switches `reranker.kind` and leaves `tau_rerank` at 0.5 gets an install that
    abstains from everything: the mirror image of AUDIT-085, where the switch read as on and the
    capability never ran.

    Reported in the deep diagnostic only, for AUDIT-044's reason: readiness is a healthcheck, and a
    configuration opinion must not restart working containers.
    """
    if kind is not RerankerKind.RERANK_API or not reranker_enabled:
        return None
    if recall is None or recall.tau_rerank != RecallConfig().tau_rerank:
        return None
    return CheckResult(
        "rerank_threshold",
        False,
        "reranker.kind is rerank_api with the default recall.tau_rerank (0.5), which was calibrated "
        "for the chat route where an answer scores 0.9-1.0. Measured on this route, the passage that "
        "answers scored 0.34 and its qualifier sibling 0.003 — so 0.5 abstains from everything. Set "
        "recall.tau_rerank explicitly for your reranker model.",
    )


def _check_reranker_fits_the_hardware(
    profile: HardwareProfile | None, reranker_enabled: bool
) -> CheckResult | None:
    """AUDIT-100: a `cpu_only` profile cannot carry the reranker capability. Measured, not assumed.

    On the documented default route — `qwen2.5:3b-instruct` on a local ollama — one 10-passage
    relevance call took **141.8 s** positional and **256.1 s** with the indexed contract, against a
    60 s default `timeout_s`. Every call times out, surfaces as `provider_unavailable`, and abstention
    falls back to the blended threshold that measurably cannot meet G4. The install answers every
    question it is asked and never asks a human anything — which is the promise the capability exists
    to keep.

    Reported only in the deep diagnostic, never in readiness. `run_verify` IS the container
    healthcheck, so failing it here would restart working containers over a configuration choice
    (AUDIT-044). The operator asked a deep question with `--probe-models`; this is part of the answer.
    """
    if profile is not HardwareProfile.CPU_ONLY or not reranker_enabled:
        return None
    return CheckResult(
        "reranker_profile",
        False,
        "reranker is enabled on a cpu_only profile: measured 142-256 s per 10-passage call against a "
        "60 s timeout, so every call times out and abstention silently falls back. Use a GPU profile, "
        "route the capability to a remote model, or disable it and accept threshold-only abstention.",
    )


async def run_verify(
    *,
    gateway: ModelGateway,
    sessionmaker: async_sessionmaker[AsyncSession],
    smoke: SmokeCheck | None = None,
    probe_models: bool = False,
    hardware_profile: HardwareProfile | None = None,
    reranker_enabled: bool = False,
    reranker_kind: RerankerKind | None = None,
    recall: RecallConfig | None = None,
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
        mismatch = _check_reranker_fits_the_hardware(hardware_profile, reranker_enabled)
        if mismatch is not None:
            checks.append(mismatch)
        uncalibrated = _check_rerank_threshold_is_calibrated(
            reranker_kind, reranker_enabled=reranker_enabled, recall=recall
        )
        if uncalibrated is not None:
            checks.append(uncalibrated)
    if smoke is not None:
        try:
            ok, detail = await smoke()
        except Exception as exc:
            ok, detail = False, f"smoke crashed ({type(exc).__name__})"
        checks.append(CheckResult("ingest_smoke", ok, detail))
    return VerifyReport(checks=checks)
