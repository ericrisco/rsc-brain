"""Model usage accounting must be tenant-safe (AUDIT-021, R12).

``token_usage`` carries no ``project_id`` (``models.py:449-457``): the recorder's report
(``gateway/usage.py:101-122``) and the admin ``/usage`` endpoint (``api/admin.py:633-642``) are
both instance-global — every project's attempts land in the same per-capability/day counter and
every authorized caller sees the same pooled total, regardless of which project's token it holds.

These tests encode the R12 safe expectation: usage must be stored, budgeted and reported **per
project**. They fail today against the documented vulnerable (pooled/global) outcome. R29 — the
atomic per-attempt reservation under concurrency — is deliberately out of scope here; it is owned
by task T015 and is not re-tested in this file.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig
from rsc_brain.gateway.usage import BudgetExceededError, PgUsageRecorder
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational.store import PgRelationalStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


def _caps(*, embedder_budget: int | None = None) -> CapabilitiesConfig:
    """Minimal capabilities config, mirroring ``tests/integration/test_usage_cache.py``."""
    cap = CapabilityConfig(provider="none", model="none")
    embedder = CapabilityConfig(provider="none", model="none", daily_token_budget=embedder_budget)
    return CapabilitiesConfig(
        extractor=cap, judge=cap, topicalizer=cap, embedder=embedder, reranker=cap
    )


async def _mint_pat(harness: Harness, project_id: str, *, project_role: str = "member") -> str:
    """Mint a PAT for a human membership in ``project_id``.

    ``can_curate=True`` is the only existing primitive that reaches the admin surface's
    ``_is_admin`` gate today (there is no project-role check yet — a later task adds one). Using
    it here only gets the principal through the door; it is not what this file is testing — R03
    (``can_curate`` granting administration) is already canonized elsewhere.
    """
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('user')}@example.com", status="active", role="member")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id,
        project_id,
        role=project_role,
        allowed_topics=("general",),
        can_curate=True,
    )
    return (await identity.issue_pat(membership)).token


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _tokens_for(payload: dict[str, Any], capability: str) -> int:
    return next((r["tokens"] for r in payload["usage"] if r["capability"] == capability), 0)


async def test_two_projects_reconcile_to_their_own_usage_only(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R12 scenarios 1+2: every attempt is attributable to exactly one project, and each
    project's own reconciled usage equals its own consumption only — the other project's
    consumption never appears in its totals.

    Today ``token_usage`` has no project column, so both projects' PATs read the identical
    pooled total instead of their own.
    """
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acct-a"), [("general", 0), ("ops", 0)])
    project_b = await harness.setup_project(unique_slug("acct-b"), [("general", 0), ("ops", 0)])
    pat_a = await _mint_pat(harness, project_a)
    pat_b = await _mint_pat(harness, project_b)

    capability = f"acct-{unique_slug('cap')}"
    # Each attempt is recorded by the accounting bound to the project that made it. T001 wrote both
    # lines against one unbound recorder, which cannot express whose attempt each was — no
    # implementation could have attributed them, so the arrange was unsatisfiable while the
    # assertions were right. The binding is the contract R12 introduces (`for_project`).
    accounting = PgUsageRecorder(harness.sm, _caps())
    await accounting.for_project(project_a).record(capability, 111)  # project A's own attempt
    await accounting.for_project(project_b).record(capability, 222)  # project B's own attempt

    async with _client(harness, tmp_path) as client:
        resp_a = await client.get(
            "/api/v1/admin/usage", headers={"Authorization": f"Bearer {pat_a}"}
        )
        resp_b = await client.get(
            "/api/v1/admin/usage", headers={"Authorization": f"Bearer {pat_b}"}
        )

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    tokens_a = _tokens_for(resp_a.json(), capability)
    tokens_b = _tokens_for(resp_b.json(), capability)

    assert tokens_a == 111, (
        f"project A's usage report must reconcile to its own 111 tokens, got {tokens_a} "
        "— it must not include project B's consumption"
    )
    assert tokens_b == 222, (
        f"project B's usage report must reconcile to its own 222 tokens, got {tokens_b} "
        "— it must not include project A's consumption"
    )


async def test_foreign_and_viewer_principal_cannot_observe_other_projects_usage(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R12 scenario 3 (negative authority): a principal of a foreign project, and a read-only
    viewer of that same foreign project, must not be able to observe another project's usage.
    Their own authorized report must reconcile to their own (zero) consumption — absence-
    equivalent, exactly as if the other project's activity did not exist.
    """
    harness = build_harness()
    # Project A exists and has its own attempt on record; B never calls this capability at all.
    project_a = await harness.setup_project(unique_slug("acct-a"), [("general", 0), ("ops", 0)])
    project_b = await harness.setup_project(unique_slug("acct-b"), [("general", 0), ("ops", 0)])

    capability = f"acct-{unique_slug('cap')}"
    accounting = PgUsageRecorder(harness.sm, _caps())
    await accounting.for_project(project_a).record(capability, 999)  # A's attempt; B never called

    pat_member_b = await _mint_pat(harness, project_b, project_role="member")
    pat_viewer_b = await _mint_pat(harness, project_b, project_role="viewer")

    async with _client(harness, tmp_path) as client:
        member_resp = await client.get(
            "/api/v1/admin/usage", headers={"Authorization": f"Bearer {pat_member_b}"}
        )
        viewer_resp = await client.get(
            "/api/v1/admin/usage", headers={"Authorization": f"Bearer {pat_viewer_b}"}
        )

    assert member_resp.status_code == 200
    assert viewer_resp.status_code == 200

    member_tokens = _tokens_for(member_resp.json(), capability)
    viewer_tokens = _tokens_for(viewer_resp.json(), capability)

    assert member_tokens == 0, (
        f"a foreign-project member must see 0 tokens for a capability it never used, got "
        f"{member_tokens} — project A's activity leaked into project B's own report"
    )
    assert viewer_tokens == 0, (
        f"a foreign-project viewer must see 0 tokens for a capability it never used, got "
        f"{viewer_tokens} — project A's activity leaked into project B's own report"
    )


async def test_project_daily_budget_is_independent_not_shared(
    build_harness: Callable[..., Harness],
) -> None:
    """R12 scenario 4: a project's budget/limit must be evaluated against that project's own
    consumption, so another project's traffic cannot exhaust it.

    This is a sequential (non-concurrent) tenant-isolation check — the atomic per-attempt
    reservation under a concurrent race is R29 (task T015), not this file.
    """
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("budget-a"), [("general", 0)])
    project_b = await harness.setup_project(unique_slug("budget-b"), [("general", 0)])

    # Each project's budget is evaluated against its OWN consumption, so A's baseline is A's.
    scout = PgUsageRecorder(harness.sm, _caps(), project_id=project_a)
    baseline_rows = await scout.usage(days=1)
    baseline = 0
    for row in baseline_rows:
        if row["capability"] == "embedder":
            baseline = cast(int, row["tokens"])
            break

    headroom = 50
    budget = baseline + headroom
    accounting = PgUsageRecorder(harness.sm, _caps(embedder_budget=budget))
    recorder_a = accounting.for_project(project_a)
    recorder_b = accounting.for_project(project_b)

    # Project A has spent nothing under this fresh budget window; its own check must pass.
    await recorder_a.enforce_budget("embedder")

    # Project B's attempt, on the same capability/day, consumes well past A's headroom.
    await recorder_b.record("embedder", headroom + 1)

    # Safe expectation: project A's independent budget decision is untouched by B's traffic.
    try:
        await recorder_a.enforce_budget("embedder")
    except BudgetExceededError as exc:
        pytest.fail(
            "project A's budget check was exhausted by project B's traffic on a shared "
            f"instance-global counter — budgets must be evaluated per project: {exc}"
        )
