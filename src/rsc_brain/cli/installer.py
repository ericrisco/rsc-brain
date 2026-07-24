"""Installer + evals CLI (SPEC-06): ``brain doctor`` · ``brain verify`` · ``brain eval`` ·
``brain calibrate``.

``doctor`` detects the host + recommends a profile + scans config for secrets. ``verify`` smokes
the gateway + database. ``eval``/``calibrate`` load the golden set and report its composition; a
full recall-metrics run requires an ingested corpus + model (exercised by the integration runner,
``evals.runner.run_eval``) — a live-model run is blocked-by-resource.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from pathlib import Path

import typer
import yaml

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.installer import doctor as doctor_mod
from rsc_brain.installer.verify import run_verify

_CONFIG_CANDIDATES = [Path("config.yaml"), Path("config.example.yaml")]
_GOLDEN = Path("evals/golden.yaml")


def doctor(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Detect the host, recommend a hardware profile, and scan config for hardcoded secrets."""
    report = doctor_mod.run_doctor(_CONFIG_CANDIDATES)
    payload = {
        "status": "ok" if report.ok else "secrets_found",
        "recommended_profile": report.recommended_profile,
        "host": report.host,
        "tls": report.tls,
        "secret_findings": [
            {"path": f.path, "line": f.line, "reason": f.reason} for f in report.secret_findings
        ],
    }
    tls_note = report.tls.get("warning") or f"TLS domain={report.tls.get('domain')}"
    human = (
        f"doctor: profile={report.recommended_profile}, docker={report.host['docker']}, "
        f"gpu={report.host['has_gpu']}, ram_gb={report.host['ram_gb']}; "
        + ("no hardcoded secrets. " if report.ok else f"{len(report.secret_findings)} secret(s)! ")
        + str(tls_note)
    )
    emit_result(ctx, json_output, payload, human)
    if not report.ok:
        raise typer.Exit(code=1)


def verify(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Smoke-test the running system: gateway probe + database (extensions + schema at head)."""

    async def _run() -> tuple[bool, list[dict[str, object]]]:
        from rsc_brain.config import load_settings
        from rsc_brain.gateway.model_gateway import ModelGateway
        from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

        settings = load_settings()
        engine = make_engine()
        try:
            report = await run_verify(
                gateway=ModelGateway(settings.capabilities),
                sessionmaker=make_sessionmaker(engine),
            )
        finally:
            await engine.dispose()
        return report.ok, [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in report.checks]

    ok, checks = asyncio.run(_run())
    payload = {"status": "ok" if ok else "failed", "checks": checks}
    human = "\n".join(
        f"  [{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}" for c in checks
    )
    emit_result(ctx, json_output, payload, human)
    if not ok:
        raise typer.Exit(code=1)


def _load_golden() -> dict[str, object]:
    if not _GOLDEN.is_file():
        raise typer.Exit(code=2)
    cases = yaml.safe_load(_GOLDEN.read_text(encoding="utf-8")).get("cases", [])
    families = Counter(c["family"] for c in cases)
    must_find = sum(1 for c in cases if c.get("must_find"))
    return {
        "total": len(cases),
        "families": dict(families),
        "must_find": must_find,
        "must_abstain": len(cases) - must_find,
    }


def eval_command(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Report the golden set composition. A full recall-metrics run requires an ingested corpus +
    model (see evals.runner.run_eval, exercised by the integration suite)."""
    composition = _load_golden()
    payload = {"status": "ok", "golden": composition, "note": "full run needs ingested corpus"}
    human = (
        f"eval: {composition['total']} golden cases "
        f"({composition['must_find']} must-find, {composition['must_abstain']} must-abstain); "
        f"families={composition['families']}"
    )
    emit_result(ctx, json_output, payload, human)


def calibrate(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Report the calibration set (τ is swept over recall scores by evals.runner.run_calibration;
    a full run requires an ingested corpus + model)."""
    composition = _load_golden()
    payload = {
        "status": "ok",
        "golden": composition,
        "default_tau": 0.45,
        "note": "τ suggested by run_calibration over recall scores (needs ingested corpus)",
    }
    emit_result(
        ctx, json_output, payload, f"calibrate: {composition['total']} cases; default τ=0.45"
    )
