"""Defects found by the adversarial whole-diff review (T021).

Three, all introduced by this remediation program itself, which is the point of reviewing your own
diff rather than trusting it:

* the hunt reply page interpolates the question AND the URL token into HTML unescaped — a stored and a
  reflected XSS on the one route in the product that is deliberately unauthenticated;
* ``_remove_blob`` only checks that a recorded path is inside the data directory when it is TOLD what
  the data directory is, so the default call unlinks whatever path a row happens to hold;
* entity erasure matches claim text with ``ILIKE '%name%'``, so erasing a short name deletes every
  claim that merely contains those letters.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select

from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]


# --------------------------------------------------------------------------- #
# 1. XSS on the unauthenticated hunt reply page
# --------------------------------------------------------------------------- #


async def _hunt_client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    from rsc_brain.api.app import ApiDeps, create_app
    from rsc_brain.hunting.channels import NullChannel
    from rsc_brain.hunting.service import HuntService

    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    app.state.hunts = HuntService(harness.sm, channel=NullChannel(), base_url="http://test")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_the_reply_page_does_not_execute_a_question_as_markup(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The question is interpolated into the page unescaped.

    A question reaches this page from a curator, from an agent's gap, or from a document's text — none of
    which is trusted markup — and the page is served on the product's only deliberately
    unauthenticated route, to the person the product is asking for help. Script in a question runs in
    their browser, on the install's own origin.
    """
    from rsc_brain.hunting.channels import NullChannel
    from rsc_brain.hunting.directory import PersonDirectory
    from rsc_brain.hunting.service import HuntService

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await PersonDirectory(harness.sm).add(
        scope, name="Ana", channels={"email": "ana@example.test"}, topics=["hr"]
    )
    service = HuntService(harness.sm, channel=NullChannel(), base_url="http://test")
    outcome = await service.create_manual(
        scope, question='<script>alert("xss")</script>', topics=["hr"]
    )
    assert outcome.magic_token

    app_state_service = service
    from rsc_brain.api.app import ApiDeps, create_app

    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    app.state.hunts = app_state_service
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        page = await client.get(f"/hunt/{outcome.magic_token}")

    assert page.status_code == 200, page.text[:200]
    assert "<script>alert(" not in page.text, (
        "the question is rendered as markup, so a question is a script injection into the browser of "
        "the person the product is asking for help"
    )
    assert "&lt;script&gt;" in page.text, "the question should be visible, escaped, not removed"


async def test_the_reply_page_does_not_execute_the_url_token_as_markup(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The token from the URL is interpolated into the form's action attribute unescaped.

    Anyone can choose that token — it is a path segment — so a crafted link injects markup into a page
    on the install's origin without needing a valid hunt at all.
    """
    harness = build_harness()
    async with await _hunt_client(harness, tmp_path) as client:
        page = await client.get('/hunt/x" onload="alert(1)')

    assert 'onload="alert(1)' not in page.text, (
        "the URL token escapes its attribute, so a crafted link injects markup into a page served from "
        "the install's own origin"
    )


# --------------------------------------------------------------------------- #
# 2. Blob deletion outside the data directory
# --------------------------------------------------------------------------- #


async def test_forgetting_a_document_refuses_a_path_outside_the_data_directory(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The containment check only happens when the caller says what the data directory is.

    ``data_dir`` defaults to ``None``, and with it the recorded path is unlinked as-is. A row's ``path``
    is data: a restored backup, a manual repair or an earlier bug can put anything there, and deletion
    is the one operation where trusting it destroys something outside the install.
    """
    from rsc_brain.knowledge.gdpr import forget_document

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    outsider = tmp_path / "not-ours.txt"
    outsider.write_text("a file the install does not own")
    async with harness.sm() as session:
        document = models.Document(
            project_id=uuid.UUID(project),
            logical_id=unique_slug("doc"),
            checksum=unique_slug("sum"),
            status="processed",
            path=str(outsider),
        )
        session.add(document)
        await session.flush()
        document_id = str(document.id)
        await session.commit()

    # No `data_dir`: the caller has not said which directory it owns, so nothing may be unlinked.
    await forget_document(harness.sm, scope, document_id)

    assert outsider.exists(), (
        f"a document row pointed at {outsider} and forgetting it deleted that file, with nothing "
        "checking that the path belongs to the install"
    )


# --------------------------------------------------------------------------- #
# 3. Erasure over-matching
# --------------------------------------------------------------------------- #


async def test_erasing_a_short_name_does_not_delete_unrelated_claims(
    build_harness: Callable[..., Harness],
) -> None:
    """Claims are matched with ``ILIKE '%name%'``.

    Erasing "Ana" therefore deletes "bananas", "Anatolia" and "analysis" — an erasure request from one
    person silently destroying unrelated company knowledge. The ratified policy is to delete claims that
    contain the erased entity, not claims that contain those letters.
    """
    from rsc_brain.knowledge.gdpr import forget_entity

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    async with harness.sm() as session:
        session.add(
            models.Entity(
                project_id=uuid.UUID(project),
                name="Ana",
                normalized_name="ana",
                type="person",
            )
        )
        for text in ("Ana owns payroll.", "The banana import quota is 4 tonnes."):
            session.add(
                models.Claim(
                    project_id=uuid.UUID(project),
                    text=text,
                    tags=["hr"],
                    credibility=0.9,
                )
            )
        await session.commit()

    await forget_entity(harness.sm, scope, name="Ana")

    async with harness.sm() as session:
        survivors = list(
            await session.scalars(
                select(models.Claim.text).where(models.Claim.project_id == uuid.UUID(project))
            )
        )
        total = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == uuid.UUID(project))
        )
    assert total == 1, f"erasing 'Ana' removed unrelated knowledge; survivors={survivors}"
    assert survivors == ["The banana import quota is 4 tonnes."], survivors
