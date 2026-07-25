"""Living-knowledge admin API (SPEC-19, FR-13.5/FR-15.12): corrections feed + pending queue,
disputed claims, contradiction resolutions, §7 metrics, and server-side revert authorization.

The console consumes only these endpoints; here we prove the API surface + the authz (admin OR tag
owner can revert; anyone else is 403) + project isolation.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("pricing", 0), ("hr", 0)]


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _mint_pat(
    harness: Harness,
    project: str,
    *,
    can_curate: bool,
    user_id: str,
    project_role: str = "member",
) -> str:
    """A PAT with an explicit PROJECT role and authority over both of this file's topics.

    The feed is topic-filtered (AUDIT-020 / R01) and reverting needs the project role or topic
    ownership (FR-15.8), so the two are stated separately here: `can_curate` authorizes neither.
    """
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user_id,
        project,
        role=project_role,
        allowed_topics=("pricing", "hr"),
        can_curate=can_curate,
    )
    return (await identity.issue_pat(membership)).token


async def _make_user(harness: Harness) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('u')}@example.com", status="active")
    )
    return user.user_id


async def _seed_applied_correction(harness: Harness, project: str, tag: str) -> str:
    """An old (superseded) + new (active) claim and an applied correction between them."""
    async with harness.sm() as session:
        old = models.Claim(
            project_id=uuid.UUID(project),
            text="Old price 100",
            tags=[tag],
            credibility=0.1,
            valid_to=dt.datetime.now(dt.UTC),
        )
        new = models.Claim(
            project_id=uuid.UUID(project), text="New price 120", tags=[tag], credibility=0.9
        )
        session.add_all([old, new])
        await session.flush()
        correction = models.Correction(
            project_id=uuid.UUID(project),
            target_claim=old.id,
            new_claim=new.id,
            role_applied="owner_direct",
            status="applied",
            before_text="Old price 100",
            after_text="New price 120",
        )
        session.add(correction)
        await session.flush()
        cid = str(correction.id)
        await session.commit()
        return cid


async def test_corrections_feed_and_pending_queue(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_applied_correction(harness, project, "pricing")
    async with harness.sm() as session:
        target = models.Claim(
            project_id=uuid.UUID(project), text="Pending target", tags=["hr"], credibility=0.5
        )
        session.add(target)
        await session.flush()
        session.add(
            models.Correction(
                project_id=uuid.UUID(project),
                target_claim=target.id,
                role_applied="non_owner",
                status="pending_confirmation",
                before_text="x",
                after_text="y",
            )
        )
        await session.commit()
    admin = await _make_user(harness)
    token = await _mint_pat(harness, project, can_curate=True, user_id=admin)
    headers = {"Authorization": f"Bearer {token}"}
    async with _client(harness, tmp_path) as client:
        feed = await client.get("/api/v1/admin/corrections", headers=headers)
        assert feed.status_code == 200 and len(feed.json()["corrections"]) == 2
        pending = await client.get(
            "/api/v1/admin/corrections?status_filter=pending_confirmation", headers=headers
        )
        assert [c["status"] for c in pending.json()["corrections"]] == ["pending_confirmation"]


async def test_revert_authz_admin_ok_stranger_forbidden(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    correction_id = await _seed_applied_correction(harness, project, "pricing")

    stranger = await _make_user(harness)  # no Person → owns nothing; not a curator
    stranger_token = await _mint_pat(harness, project, can_curate=False, user_id=stranger)
    admin = await _make_user(harness)
    admin_token = await _mint_pat(
        harness, project, can_curate=False, user_id=admin, project_role="project-admin"
    )

    async with _client(harness, tmp_path) as client:
        forbidden = await client.post(
            f"/api/v1/admin/corrections/{correction_id}/revert",
            headers={"Authorization": f"Bearer {stranger_token}"},
        )
        assert forbidden.status_code == 403  # neither admin nor tag owner (AC#5)

        ok = await client.post(
            f"/api/v1/admin/corrections/{correction_id}/revert",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert ok.status_code == 200 and ok.json()["status"] == "reverted"


async def test_disputed_resolutions_and_metrics(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    async with harness.sm() as session:
        winner = models.Claim(
            project_id=uuid.UUID(project), text="Winner", tags=["pricing"], credibility=0.8
        )
        loser = models.Claim(
            project_id=uuid.UUID(project),
            text="Loser",
            tags=["pricing"],
            credibility=0.3,
            valid_to=dt.datetime.now(dt.UTC),
            disputed=True,
        )
        session.add_all([winner, loser])
        await session.flush()
        session.add(
            models.ClaimPairVerdict(
                project_id=uuid.UUID(project),
                claim_a=winner.id,
                claim_b=loser.id,
                judge_version="v1",
                verdict="contradict",
                confidence=0.9,
            )
        )
        await session.commit()
    admin = await _make_user(harness)
    token = await _mint_pat(harness, project, can_curate=True, user_id=admin)
    headers = {"Authorization": f"Bearer {token}"}
    async with _client(harness, tmp_path) as client:
        disputed = await client.get("/api/v1/admin/claims/disputed", headers=headers)
        assert disputed.status_code == 200
        assert any(c["text"] == "Loser" for c in disputed.json()["claims"])

        resolutions = await client.get("/api/v1/admin/contradictions/resolutions", headers=headers)
        res = resolutions.json()["resolutions"]
        assert res and res[0]["winner"]["text"] == "Winner" and res[0]["loser"]["text"] == "Loser"

        metrics = await client.get("/api/v1/admin/corrections/metrics", headers=headers)
        body = metrics.json()
        assert body["correction_wars"] >= 1  # the disputed loser
        assert "ownership_coverage" in body and "revert_rate" in body


async def test_project_isolation(build_harness: Callable[..., Harness], tmp_path: Path) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acme"), TOPICS)
    project_b = await harness.setup_project(unique_slug("beta"), TOPICS)
    await _seed_applied_correction(harness, project_a, "pricing")
    admin_b = await _make_user(harness)
    token_b = await _mint_pat(harness, project_b, can_curate=True, user_id=admin_b)
    async with _client(harness, tmp_path) as client:
        feed = await client.get(
            "/api/v1/admin/corrections", headers={"Authorization": f"Bearer {token_b}"}
        )
    assert feed.status_code == 200 and feed.json()["corrections"] == []  # A's data invisible to B
