"""Ingestion API parity + isolation against the real container (FR-1.1/1.12, §4.10.3).

Auth is a real membership PAT resolved to a scope; a token for project A cannot upload to project
B's slug (denied ≡ 404). Upload → runs mirrors the CLI path over the same stores.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.ingest.pipeline import PipelineConfig
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0), ("hr", 3)]
DOC = b"# Handbook\n\nThe deployment pipeline runs in CI.\n"


async def _mint_pat(harness: Harness, project_id: str, topics: tuple[str, ...]) -> str:
    # An active user (resolve_scope requires status=active), a membership, then a PAT.
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('api-user')}@example.com", status="active")
    )
    identity = IdentityService(harness.sm)
    membership_id = await identity.add_membership(user.user_id, project_id, allowed_topics=topics)
    issued = await identity.issue_pat(membership_id)
    return issued.token


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(
            sessionmaker=harness.sm,
            gateway=harness.gateway,
            data_dir=str(tmp_path),
            config=PipelineConfig(),
        )
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def test_upload_then_list_runs(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
    tmp_path: Path,
) -> None:
    harness = build_harness(
        completion=make_completion(
            entities=[{"name": "Acme", "type": "org", "aliases": []}],
            claims=[
                {"text": "runs in CI", "subject": "pipeline", "predicate": "runs", "object": "CI"}
            ],
            tags=["engineering"],
        )
    )
    slug = unique_slug("acme")
    project_id = await harness.setup_project(slug, TOPICS)
    token = await _mint_pat(harness, project_id, ("general", "engineering"))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        upload = await client.post(
            f"/api/v1/projects/{slug}/documents",
            files={"file": ("hb.md", DOC, "text/markdown")},
            headers=headers,
        )
        assert upload.status_code == 202, upload.text
        document_id = upload.json()["document_id"]

        runs = await client.get("/api/v1/ingest/runs", headers=headers)
        assert runs.status_code == 200
        ids = [r["document_id"] for r in runs.json()["runs"]]
        assert document_id in ids


async def test_missing_project_is_404(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    token = await _mint_pat(harness, project_id, ("general",))
    headers = {"Authorization": f"Bearer {token}"}
    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/projects/{unique_slug('ghost')}/documents",
            files={"file": ("x.md", DOC, "text/markdown")},
            headers=headers,
        )
    assert response.status_code == 404


async def test_cross_project_token_is_404(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acme"), TOPICS)
    slug_b = unique_slug("globex")
    await harness.setup_project(slug_b, TOPICS)
    token_a = await _mint_pat(harness, project_a, ("general",))
    headers = {"Authorization": f"Bearer {token_a}"}
    async with _client(harness, tmp_path) as client:
        # A's token uploading to B's slug: 404 (denied ≡ absent).
        response = await client.post(
            f"/api/v1/projects/{slug_b}/documents",
            files={"file": ("x.md", DOC, "text/markdown")},
            headers=headers,
        )
    assert response.status_code == 404
