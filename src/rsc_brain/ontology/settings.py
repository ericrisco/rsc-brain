"""Per-project ontology settings (SPEC-24, FR-17.1). Lives in ``projects.settings['ontology']``.

``enabled=false`` is the default and the load-bearing guarantee: when it is off, every seam in
this layer (ingest anchoring, assisted merge, relation validation, recall expansion) short-circuits
before doing any work, so behaviour is bit-for-bit identical to an install that never had the layer.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models

AnchorStrategy = Literal["exact", "fuzzy", "embedding"]
RelationCheck = Literal["warn", "drop", "allow"]


class OntologySettings(BaseModel):
    """Validated view of ``projects.settings['ontology']`` (all keys optional, safe defaults)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    enabled: bool = Field(default=False, description="Master switch (D17); default OFF.")
    strategy: AnchorStrategy = Field(default="exact", description="Anchoring strategy (FR-17.2).")
    threshold: float = Field(default=0.85, ge=0.0, le=1.0, description="fuzzy/embedding cutoff.")
    relation_check: RelationCheck = Field(
        default="warn", description="domain/range policy (FR-17.4)."
    )
    inference_depth: int = Field(
        default=1, ge=0, le=5, description="Recall expansion depth (FR-17.5)."
    )


async def load_ontology_settings(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> OntologySettings:
    async with sessionmaker() as session:
        raw = await session.scalar(
            select(models.Project.settings).where(models.Project.id == uuid.UUID(scope.project_id))
        )
    section = (raw or {}).get("ontology", {})
    if not isinstance(section, dict):
        section = {}
    return OntologySettings.model_validate(section)
