"""Production runtime completeness and bounds (AUDIT-044 / R36-R38, R50, R53, T007 RED).

Four separate defects, all in the space between "the code works" and "the deployment works":

**R37.** The queue and the worker exist (``ingest/queue.py``, ``worker.py``) and nothing uses them.
``POST /api/v1/projects/{slug}/documents`` calls ``service.ingest_bytes`` inline, so parsing,
extraction and embedding happen on the request path and *no durable record of accepted work exists
before them*. A request that dies mid-processing leaves a half-ingested document nobody will retry;
the worker container drains an empty queue forever.

**R50.** The container healthcheck runs ``brain verify``, and ``verify`` calls
``gateway.healthcheck()``. So readiness performs live model inference on every probe: with providers
down the container is marked unhealthy and restarted although the process, its configuration and its
stores are fine, and a healthy deployment pays provider tokens on a timer. AUDIT-044's clarification is
explicit — deep dependency health is an authenticated operator diagnostic, never high-frequency
readiness.

**R53.** ``ApiDeps`` assembles the gateway with a usage recorder and an embedding cache; the worker
builds its own dependencies in ``ingest/queue.py``. Nothing compares them, so the same job can run
with different accounting, caching and limits depending on which process picked it up.

**R38.** No public surface declares a byte or cardinality ceiling. The ratified budgets (plan §3
``public_limits.validate``) are: JSON body ≤1 MiB, ontology ≤5 MiB, free text ≤64 KiB, public arrays
≤100, normal pages/top_k 1..100, admin pages ≤200, audit export ≤10,000 rows.

R36 (a reference profile boots with every capability resolved, and fails before traffic when a
required value is missing) is asserted against the shipped example configuration rather than a
hand-built dict, because "our test's config boots" is not the claim.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
import yaml
from sqlalchemy import text

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Ratified public limits (plan §3). A deployment may lower them; none may be absent.
MAX_JSON_BODY_BYTES = 1024 * 1024
MAX_FREE_TEXT_BYTES = 64 * 1024
MAX_PUBLIC_ARRAY = 100
MAX_PAGE = 100
MAX_ADMIN_PAGE = 200


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _project_pat(harness: Harness, project_id: str, *, role: str = "project-admin") -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('u')}@example.com", status="active", role="member")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id, project_id, role=role, allowed_topics=("general",)
    )
    return (await identity.issue_pat(membership)).token


async def _slug_of(harness: Harness, project_id: str) -> str:
    async with harness.sm() as session:
        return str(
            await session.scalar(
                models.Project.__table__.select()
                .with_only_columns(models.Project.slug)
                .where(models.Project.id == uuid.UUID(project_id))
            )
        )


# --------------------------------------------------------------------------- #
# R36 — a reference production profile boots, and an incomplete one fails first
# --------------------------------------------------------------------------- #


def test_the_shipped_example_profile_resolves_every_capability() -> None:
    """The claim is about the configuration we SHIP, so the fixture is that file."""
    from rsc_brain.config.models import AppConfig

    raw = yaml.safe_load((REPO_ROOT / "config.example.yaml").read_text(encoding="utf-8"))
    settings = AppConfig.model_validate(raw)
    for name in ("extractor", "judge", "topicalizer", "embedder", "reranker"):
        capability = getattr(settings.capabilities, name)
        assert capability.provider and capability.model, (
            f"the shipped profile leaves {name} unresolved, so a clean deployment cannot serve it"
        )


def test_a_profile_missing_a_required_value_fails_before_traffic() -> None:
    """Removing one required value must fail configuration, not surface later as a runtime error."""
    from pydantic import ValidationError

    from rsc_brain.config.models import AppConfig

    raw = yaml.safe_load((REPO_ROOT / "config.example.yaml").read_text(encoding="utf-8"))
    del raw["capabilities"]["embedder"]
    with pytest.raises(ValidationError):
        AppConfig.model_validate(raw)


# --------------------------------------------------------------------------- #
# R37 — accepted ingestion is durably queued, and a worker completes it once
# --------------------------------------------------------------------------- #


async def test_an_accepted_upload_leaves_durable_queued_work(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """202 must mean "recorded", not "already done on the request thread".

    The queue table is procrastinate's, created by ``brain migrate``: if accepting a document does not
    put a row there, the worker container has nothing to drain and a request that dies mid-processing
    leaves work nobody retries.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    slug = await _slug_of(harness, project)
    token = await _project_pat(harness, project)

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/projects/{slug}/documents",
            files={
                "file": ("handbook.md", b"# Handbook\n\nThe SLA is 24 hours.\n", "text/markdown")
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 202, response.text
    # Queried as raw SQL: the queue's schema is procrastinate's, applied by `brain migrate` and not
    # part of the mapped models, so asking the metadata would test our imports rather than the queue.
    async with harness.sm() as session:
        table_exists = await session.scalar(
            text("SELECT to_regclass('public.procrastinate_jobs') IS NOT NULL")
        )
        assert table_exists, "the procrastinate queue schema is not deployed at all"
        queued = await session.scalar(text("SELECT count(*) FROM procrastinate_jobs"))
    assert queued, (
        "accepting an upload created no queued job — parsing, extraction and embedding ran inline on "
        "the request path, so nothing durable exists to retry and the worker has nothing to drain"
    )


# --------------------------------------------------------------------------- #
# R50 — readiness performs no live model inference
# --------------------------------------------------------------------------- #


async def test_readiness_does_not_invoke_a_model(
    build_harness: Callable[..., Harness],
) -> None:
    """The container healthcheck runs ``brain verify``, so whatever verify does happens on a timer.

    Counting invocations rather than timing: an implementation that calls the provider and tolerates
    failure still pays tokens on every probe and still restarts a healthy container when the provider
    is slow.
    """
    from rsc_brain.installer.verify import run_verify

    harness = build_harness()
    calls: list[str] = []

    class _CountingGateway:
        async def healthcheck(self) -> dict[str, object]:
            calls.append("healthcheck")
            return {}

        async def complete(self, *args: object, **kwargs: object) -> str:
            calls.append("complete")
            return ""

        async def embed(self, *args: object, **kwargs: object) -> list[list[float]]:
            calls.append("embed")
            return [[0.0]]

    await run_verify(gateway=_CountingGateway(), sessionmaker=harness.sm)  # type: ignore[arg-type]

    assert not calls, (
        f"readiness invoked the model gateway {calls} — with providers down a healthy deployment is "
        "restarted, and a healthy one pays provider tokens on every probe"
    )


async def test_readiness_stays_ready_while_providers_are_unavailable(
    build_harness: Callable[..., Harness],
) -> None:
    """Process, configuration and stores healthy ⇒ ready, whatever the providers are doing."""
    from rsc_brain.gateway.errors import GatewayError
    from rsc_brain.installer.verify import run_verify

    harness = build_harness()

    class _DeadProviderGateway:
        async def healthcheck(self) -> dict[str, object]:
            raise GatewayError("provider_unavailable", "probe-ref")

        async def complete(self, *args: object, **kwargs: object) -> str:
            raise GatewayError("provider_unavailable", "probe-ref")

        async def embed(self, *args: object, **kwargs: object) -> list[list[float]]:
            raise GatewayError("provider_unavailable", "probe-ref")

    report = await run_verify(gateway=_DeadProviderGateway(), sessionmaker=harness.sm)  # type: ignore[arg-type]

    assert report.ok, (
        "readiness failed because the model providers were unreachable, so an outage at the provider "
        f"restarts every container: {[(c.name, c.ok, c.detail) for c in report.checks]}"
    )


# --------------------------------------------------------------------------- #
# R53 — the API's and the worker's runtime dependencies are equivalent
# --------------------------------------------------------------------------- #


async def test_the_api_and_the_worker_configure_the_same_model_collaborators(
    monkeypatch: pytest.MonkeyPatch, build_harness: Callable[..., Harness]
) -> None:
    """The same job must not be accounted for differently depending on which process ran it.

    Compared by capturing what each composition root hands to ``ModelGateway`` — not by importing a
    shared factory that does not exist yet, because asserting against a missing API fails on import
    and proves nothing about the divergence.

    What this catches is concrete: ``ApiDeps`` builds the gateway with a usage recorder and an
    embedding cache; the worker's runner builds ``ModelGateway(settings.capabilities)`` with neither.
    So a document ingested by the worker spends tokens nobody records, ignores the daily budget, and
    re-embeds text the API would have reused from the cache.
    """
    import rsc_brain.gateway.model_gateway as gateway_module

    harness = build_harness()  # provides a real DSN in the environment for both roots
    del harness

    monkeypatch.setenv("RSC_BRAIN_CONFIG", str(REPO_ROOT / "config.example.yaml"))

    captured: dict[str, set[str]] = {}
    real_init = gateway_module.ModelGateway.__init__

    def _capture(role: str) -> None:
        def _init(self: object, capabilities: object, **kwargs: object) -> None:
            captured.setdefault(role, {name for name, value in kwargs.items() if value is not None})
            real_init(self, capabilities, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(gateway_module.ModelGateway, "__init__", _init)

    from rsc_brain.api.app import _deps_from_config

    _capture("api")
    _, api_engine = _deps_from_config()
    await api_engine.dispose()

    # The worker's own assembly, copied from `ingest/queue.py::_default_runner` — which is the point:
    # the two roots are separate code, so nothing keeps them equivalent.
    _capture("worker")
    from rsc_brain.config import load_settings
    from rsc_brain.ingest.pipeline import IngestionPipeline
    from rsc_brain.ontology.ingest import OntologyIngest
    from rsc_brain.stores.age_graph_store import AgeGraphStore
    from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
    from rsc_brain.stores.relational.ingest_repository import IngestRepository

    settings = load_settings()
    worker_engine = make_engine()
    try:
        sessionmaker = make_sessionmaker(worker_engine)
        IngestionPipeline(
            repository=IngestRepository(sessionmaker),
            graph_store=AgeGraphStore(sessionmaker),
            gateway=gateway_module.ModelGateway(settings.capabilities),
            ontology=OntologyIngest(sessionmaker),
        )
    finally:
        await worker_engine.dispose()

    assert captured.get("api") == captured.get("worker"), (
        f"the API configures {sorted(captured.get('api', set()))} and the worker "
        f"{sorted(captured.get('worker', set()))} — the same job is accounted for, budgeted and "
        "cached differently depending on which process picked it up"
    )


# --------------------------------------------------------------------------- #
# R38 — public bytes, fields, lists, queries, pages and expansions are bounded
# --------------------------------------------------------------------------- #


async def test_an_oversized_json_body_is_refused(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A 2 MiB JSON body must be refused, and refused while streaming rather than buffered whole."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _project_pat(harness, project)

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            "/api/v1/admin/topics",
            json={"slug": "x", "name": "x" * (2 * MAX_JSON_BODY_BYTES)},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code in (413, 422), (
        f"a {2 * MAX_JSON_BODY_BYTES}-byte JSON body was accepted: {response.status_code}"
    )


async def test_an_oversized_free_text_field_is_refused(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Free text has its own smaller ceiling (64 KiB): a body under 1 MiB can still be abusive."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _project_pat(harness, project)

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            "/api/v1/admin/hunts/ask",
            json={"question": "q" * (MAX_FREE_TEXT_BYTES + 1), "topics": ["general"]},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code in (413, 422), (
        f"a {MAX_FREE_TEXT_BYTES + 1}-character free-text field was accepted: {response.status_code}"
    )


async def test_an_oversized_public_array_is_refused(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A public array is capped at 100 entries; unbounded lists are unbounded work."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _project_pat(harness, project)

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            "/api/v1/admin/hunts/ask",
            json={"question": "who owns this?", "topics": ["general"] * (MAX_PUBLIC_ARRAY + 1)},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code in (413, 422), (
        f"an array of {MAX_PUBLIC_ARRAY + 1} entries was accepted: {response.status_code}"
    )


@pytest.mark.parametrize(
    "path,ceiling",
    [
        ("/api/v1/admin/audit", MAX_ADMIN_PAGE),
        ("/api/v1/admin/observability/recalls", MAX_ADMIN_PAGE),
    ],
    ids=["audit", "recalls"],
)
async def test_an_oversized_page_is_clamped_or_refused(
    path: str,
    ceiling: int,
    build_harness: Callable[..., Harness],
    tmp_path: Path,
) -> None:
    """An oversized page must be refused or clamped — never honoured.

    More rows are seeded than the ceiling ON PURPOSE. Asking for 100,000 against an almost-empty table
    returns a short list whatever the server does, so the test would pass while the bound did not
    exist — the failure mode this file is otherwise about.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _project_pat(harness, project)
    async with harness.sm() as session:
        session.add_all(
            [
                models.AuditLog(
                    project_id=uuid.UUID(project),
                    principal_type="human",
                    principal_id="seed",
                    action="recall",
                    topics_used=["general"],
                    duration_ms=5,
                    denied=False,
                )
                for _ in range(ceiling + 50)
            ]
        )
        await session.commit()

    async with _client(harness, tmp_path) as client:
        response = await client.get(
            f"{path}?limit=100000", headers={"Authorization": f"Bearer {token}"}
        )

    if response.status_code in (413, 422):
        return  # refused outright is acceptable
    assert response.status_code == 200, response.text
    body = response.json()
    collection = next((value for value in body.values() if isinstance(value, list)), [])
    assert len(collection) > 0, "nothing was returned, so the bound is untested"
    assert len(collection) <= ceiling, (
        f"{path} honoured limit=100000 and returned {len(collection)} rows, so one request is an "
        "unbounded scan"
    )


async def test_an_out_of_range_window_is_refused(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A range parameter with no declared ceiling is unbounded work by another name."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _project_pat(harness, project)

    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/usage?days=100000", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code in (413, 422), (
        f"days=100000 was accepted ({response.status_code}); every public range needs a ceiling"
    )
