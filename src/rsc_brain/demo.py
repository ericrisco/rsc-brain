"""`brain demo` (SPEC-22, FR-10.7): seed a fictional company end-to-end so the product can be tried
in minutes without real data; ``brain demo --reset`` removes it completely (0 rows left).

The seed is deliberately small but real — a project, a sensitive taxonomy, a hunting owner, and a
processed document with an embedded chunk + claim — so `recall` and the console have something to
show. A live end-to-end query in <5 minutes needs a model backend (blocked-by-resource); the seed
itself is deterministic and tested.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.identity.service import IdentityService
from rsc_brain.knowledge.gdpr import hard_delete_project
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

DEMO_SLUG = "demo"
_DEMO_TOPICS = [("general", 0), ("hr", 3), ("pricing", 0)]


def _scope(project_id: str) -> ProjectScope:
    return Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(project_id)


async def _existing_demo(sessionmaker: async_sessionmaker[AsyncSession]) -> str | None:
    async with sessionmaker() as session:
        pid = await session.scalar(
            select(models.Project.id).where(models.Project.slug == DEMO_SLUG)
        )
    return str(pid) if pid else None


async def seed_demo(sessionmaker: async_sessionmaker[AsyncSession]) -> dict[str, object]:
    """Seed the demo company. Idempotent-safe: refuses if a demo project already exists (run
    ``--reset`` first)."""
    if await _existing_demo(sessionmaker) is not None:
        return {"status": "exists", "slug": DEMO_SLUG}

    identity = IdentityService(sessionmaker)
    project_id = await identity.create_project(DEMO_SLUG, "Demo Co")
    for slug, sensitivity in _DEMO_TOPICS:
        await identity.create_topic(project_id, slug, slug.title(), sensitivity=sensitivity)
    scope = _scope(project_id)
    await PersonDirectory(sessionmaker).add(
        scope, name="Dana Ops", channels={"email": "dana@demo.local"}, topics=["hr"]
    )
    async with session_scope(sessionmaker) as session:
        doc = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id="demo-handbook",
            checksum=f"demo-{uuid.uuid4().hex}",
            title="Employee handbook",
            status="processed",
        )
        session.add(doc)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project_id),
            document_id=doc.id,
            kind="prose",
            text="The standard support SLA is 12 hours.",
            tags=["general"],
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        session.add(
            models.Claim(
                project_id=uuid.UUID(project_id),
                chunk_id=chunk.id,
                text="The standard support SLA is 12 hours.",
                tags=["general"],
                credibility=0.6,
            )
        )
    return {"status": "seeded", "slug": DEMO_SLUG, "project_id": project_id}


async def reset_demo(sessionmaker: async_sessionmaker[AsyncSession]) -> dict[str, object]:
    """Remove the demo company completely (FR-10.7)."""
    project_id = await _existing_demo(sessionmaker)
    if project_id is None:
        return {"status": "absent", "slug": DEMO_SLUG}
    await hard_delete_project(sessionmaker, _scope(project_id))
    return {"status": "removed", "slug": DEMO_SLUG}
