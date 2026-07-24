"""Export the API's OpenAPI schema to ``apps/admin/openapi.json`` (SPEC-07 golden rule).

The console's typed client is generated from this file; CI regenerates it and fails the build on
drift, so the console can never drift from the API contract (D10). Building the schema needs no
database — a lazily-created engine + a dummy gateway are enough for FastAPI to render the routes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

_OUTPUT = Path("apps/admin/openapi.json")


def _dummy_capabilities() -> CapabilitiesConfig:
    cap = CapabilityConfig(provider="none", model="none")
    return CapabilitiesConfig(
        extractor=cap, judge=cap, topicalizer=cap, embedder=cap, reranker=cap
    )


def build_openapi() -> dict[str, object]:
    engine = make_engine("postgresql+asyncpg://export:export@localhost:5432/export")
    app = create_app(
        deps=ApiDeps(
            sessionmaker=make_sessionmaker(engine),
            gateway=ModelGateway(_dummy_capabilities()),
        )
    )
    schema: dict[str, object] = app.openapi()
    return schema


def main() -> int:
    schema = build_openapi()
    _OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    _OUTPUT.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    paths = schema.get("paths", {})
    count = len(paths) if isinstance(paths, dict) else 0
    print(f"wrote {_OUTPUT} ({count} paths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
