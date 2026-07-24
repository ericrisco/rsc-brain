"""API auth boundary (unit): a request without a bearer token is rejected before any DB access."""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker


@pytest.fixture
def app_no_db(gateway_factory: Callable[..., ModelGateway]) -> object:
    # A lazily-created engine (never connected) — the missing-token path returns 401 before it is
    # ever used, so no database is required for this test.
    async def _completion(**_: object) -> object:  # pragma: no cover - never invoked
        raise AssertionError

    engine = make_engine("postgresql+asyncpg://u:p@localhost:5432/none")
    deps = ApiDeps(
        sessionmaker=make_sessionmaker(engine),
        gateway=gateway_factory(completion=_completion),
    )
    return create_app(deps=deps)


async def test_missing_token_is_401(app_no_db: object) -> None:
    transport = httpx.ASGITransport(app=app_no_db)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/ingest/runs")
    assert response.status_code == 401
