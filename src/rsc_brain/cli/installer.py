"""Installer + evals CLI (SPEC-06): ``brain doctor`` · ``brain verify`` · ``brain eval`` ·
``brain calibrate``.

``doctor`` detects the host + recommends a profile + scans config for secrets. ``verify`` smokes
the gateway + database. ``eval``/``calibrate`` load the golden set and report its composition; a
full recall-metrics run requires an ingested corpus + model (exercised by the integration runner,
``evals.runner.run_eval``) — a live-model run is blocked-by-resource.
"""

from __future__ import annotations

import asyncio
import os
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


def init(
    ctx: typer.Context,
    json_output: bool = JSON_OPTION,
    admin_email: str = typer.Option(
        None, "--admin-email", envvar="RSC_BRAIN_ADMIN_EMAIL", help="First-admin email."
    ),
    admin_password: str = typer.Option(
        None,
        "--admin-password",
        envvar="RSC_BRAIN_ADMIN_PASSWORD",
        help="First-admin password (generated into an owner-only file if omitted).",
    ),
) -> None:
    """Bootstrap a deployment (SPEC-18): apply migrations, then create the first admin if none
    exists. Idempotent — safe as a migrate-on-boot one-shot (re-run does not reset the admin)."""
    from rsc_brain.deploy.bootstrap import DEFAULT_ADMIN_EMAIL, ensure_first_admin
    from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
    from rsc_brain.stores.relational.migrations import upgrade_to_head

    upgrade_to_head()  # migrate-on-boot (NFR-8): idempotent, before serving traffic

    async def _bootstrap() -> tuple[str, bool, str | None]:
        engine = make_engine()
        try:
            result = await ensure_first_admin(
                make_sessionmaker(engine),
                email=admin_email or DEFAULT_ADMIN_EMAIL,
                password=admin_password or None,
            )
        finally:
            await engine.dispose()
        return result.email, result.created, result.generated_password

    email, created, generated = asyncio.run(_bootstrap())
    payload: dict[str, object] = {
        "status": "ok",
        "migrated": True,
        "admin": {"email": email, "created": created},
    }
    # R13: a generated credential goes to an owner-only file and NEVER to stdout or the JSON payload.
    # This command is the migrate-on-boot one-shot, so its output is the migrate service's log, and
    # AUDIT-034 requires no credential value in application logs, lifecycle logs, rendered notes or CI
    # artifacts. What the operator gets is the location — which is also all the Helm path ever gave.
    credential_path: str | None = None
    if generated:
        from rsc_brain.deploy.bootstrap import store_generated_credential

        # Read straight from the environment rather than through `load_settings()`: bootstrapping a
        # fresh deployment must not require a complete model configuration to exist first.
        directory = os.environ.get("RSC_BRAIN_INGEST__DATA_DIR", "data")
        credential_path = str(store_generated_credential(directory, email, generated))
        payload["admin_credential_file"] = credential_path
    if created:
        human_admin = f"first admin created: {email}"
        if credential_path:
            human_admin += (
                f"; its generated password was stored in {credential_path} (mode 0600) — "
                "retrieve it from there and delete the file"
            )
        else:
            human_admin += " with the password you supplied"
    else:
        human_admin = f"admin already present ({email})"
    emit_result(ctx, json_output, payload, f"migrations applied; {human_admin}")


def usage(
    ctx: typer.Context,
    json_output: bool = JSON_OPTION,
    days: int = typer.Option(7, "--days", help="How many days back to report."),
    project: str | None = typer.Option(
        None, "--project", help="Report one project's own usage instead of the whole instance."
    ),
) -> None:
    """Report token + call usage by day (SPEC-22, FR-9.5).

    Counters are per project (AUDIT-021 / R12). Without ``--project`` this is the operator view —
    the instance total, which reconciles with no single project; with it, that project's own figures,
    the same ones the console shows.
    """
    from sqlalchemy import select

    from rsc_brain.gateway.usage import usage_all_projects, usage_by_day
    from rsc_brain.stores.relational import models
    from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

    async def _run() -> list[dict[str, object]]:
        engine = make_engine()
        sessionmaker = make_sessionmaker(engine)
        try:
            if project is None:
                return await usage_all_projects(sessionmaker, days=days)
            async with sessionmaker() as session:
                project_id = await session.scalar(
                    select(models.Project.id).where(models.Project.slug == project)
                )
            if project_id is None:
                raise typer.BadParameter(f"unknown project: {project}")
            return await usage_by_day(sessionmaker, days=days, project_id=str(project_id))
        finally:
            await engine.dispose()

    rows = asyncio.run(_run())
    human = "\n".join(
        f"{r['day']} {r['capability']}: {r['tokens']} tok / {r['calls']} calls" for r in rows
    )
    emit_result(ctx, json_output, {"usage": rows}, human or "no usage recorded")


def _doctor_facts() -> tuple[str, bool, dict[int, bool]]:
    """Consume `brain doctor` for the profile + host facts the plan is built from (SPEC-16)."""
    from typing import cast

    report = doctor_mod.run_doctor(_CONFIG_CANDIDATES)
    free_ports = cast("dict[int, bool]", report.host["free_ports"])
    return report.recommended_profile, bool(report.host["docker"]), free_ports


def plan(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Dry-run: turn `brain doctor` into the concrete phase plan `brain apply` would execute
    (unmet host preconditions are listed as blockers, never resolved — D8)."""
    from rsc_brain.installer.plan import build_plan

    profile, docker, free_ports = _doctor_facts()
    install_plan = build_plan(profile=profile, docker=docker, free_ports=free_ports)
    payload = {
        "status": "blocked" if install_plan.blocked else "ok",
        "plan": install_plan.to_dict(),
    }
    lines = [f"plan: profile={install_plan.profile}, {len(install_plan.phases)} phases"]
    for blocker in install_plan.blockers:
        lines.append(f"  [BLOCKER] {blocker.detail} -> {blocker.remediation}")
    for phase in install_plan.phases:
        lines.append(f"  - {phase.id}: {phase.title}")
    emit_result(ctx, json_output, payload, "\n".join(lines))
    if install_plan.blocked:
        raise typer.Exit(code=1)


def apply(
    ctx: typer.Context,
    json_output: bool = JSON_OPTION,
    yes: bool = typer.Option(
        False, "--yes", help="Skip all confirmations. UNSAFE — for CI/automation only (FR-11.4)."
    ),
) -> None:
    """Execute the install plan phase by phase: idempotent (re-run = no-op), resumable from the last
    checkpoint, with per-phase rollback. Asks for confirmation before starting and before any
    destructive action unless --yes (FR-11.3/11.4)."""
    from rsc_brain.installer.apply import (
        CheckpointStore,
        CommandVerifier,
        SubprocessActionRunner,
        apply_plan,
    )
    from rsc_brain.installer.plan import build_plan

    profile, docker, free_ports = _doctor_facts()
    install_plan = build_plan(profile=profile, docker=docker, free_ports=free_ports)
    report = apply_plan(
        install_plan,
        runner=SubprocessActionRunner(),
        verifier=CommandVerifier(),
        checkpoints=CheckpointStore(),
        confirm=None if yes else typer.confirm,
        assume_yes=yes,
    )
    payload = {"status": "ok" if report.ok else "failed", "apply": report.to_dict()}
    human = "\n".join(f"  [{r.status}] {r.id}: {r.detail}" for r in report.results)
    emit_result(ctx, json_output, payload, human)
    if not report.ok:
        raise typer.Exit(code=1)


def wait_for_schema(
    ctx: typer.Context,
    timeout: int = typer.Option(300, "--timeout", help="Seconds to wait before giving up."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Block until the database schema is at head, then exit 0 (AUDIT-047 / R49).

    This is what an init container waits on. The alternative — letting READINESS be the only gate — is a
    deadlock on Kubernetes: `helm install --wait` waits for the app to be Ready, and the app is not Ready
    until the schema is at head, which the migration Job has not applied yet because Helm is still
    waiting. Gating the pod on the schema in an init container inverts that dependency and leaves
    readiness meaning what it should: "this process can serve".

    Deliberately narrow: it asks whether the schema is at head and nothing else. It must not need a model
    gateway, a full configuration tree, or anything else that can fail for unrelated reasons while a
    perfectly good migration is running.
    """
    import time

    from rsc_brain.stores.relational.migrations import schema_state

    deadline = time.monotonic() + timeout
    while True:
        # T022 re-audit: this used to ask whether `alembic_version` had a ROW. On a fresh install the
        # table is empty until the Job stamps it, so it worked; on an UPGRADE the row is already there
        # from the previous version, so the gate passed instantly and api/worker started against the old
        # schema — the exact ordering failure this command exists to prevent.
        state = schema_state()
        if state.at_head:
            emit_result(
                ctx,
                json_output,
                {"status": "ok", "schema": "head", "revision": state.stamped},
                f"brain: {state.explain()}.",
            )
            return
        if time.monotonic() >= deadline:
            typer.echo(
                f"brain wait-for-schema: not ready within {timeout}s — {state.explain()}", err=True
            )
            raise typer.Exit(code=1)
        time.sleep(2)


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
