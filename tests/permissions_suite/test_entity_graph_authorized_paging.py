"""Real-Postgres+AGE proof that entity-graph views are permission-first and bounded
(AUDIT-035, R16): the reported total, every page, and every continuation must describe ONLY the
caller's authorized neighbour set.

Today `AgeGraphStore.neighborhood` (age_graph_store.py:196-234) counts and paginates the RAW
physical neighbourhood before any topic filter is applied, and `entity_graph.entity_neighborhood`
(entity_graph.py:108-139) post-filters the already-paginated page in Python. The result: totals
leak the existence of hidden neighbours, pages shrink or empty out depending on where hidden
neighbours happen to sort, revoking a topic does not change the reported total, and a same-named
entity of a different, otherwise-invisible type can piggyback on another entity's visible claim.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass

import pytest

from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.knowledge.entity_graph import entity_neighborhood
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

VISIBLE = "general"
HIDDEN = "classified"


@dataclass(frozen=True, slots=True)
class _Ent:
    name: str
    type: str


async def _insert_entity(harness: Harness, project: str, name: str, etype: str) -> _Ent:
    async with harness.sm() as session:
        session.add(
            models.Entity(
                project_id=uuid.UUID(project),
                name=name,
                normalized_name=normalize_name(name),
                type=etype,
            )
        )
        await session.commit()
    return _Ent(name=name, type=etype)


async def _insert_claim(
    harness: Harness,
    project: str,
    *,
    subject: str,
    obj: str,
    tags: list[str],
    object_type: str | None = None,
) -> None:
    """A claim about two endpoints.

    ``object_type`` records the object's deterministic entity identity, which is what production
    writes (the extractor knows each endpoint's type) and what makes a claim speak for ONE identity
    rather than for every entity that happens to share a name. Omitted, the claim is the keyless
    shape older rows have.
    """
    async with harness.sm() as session:
        session.add(
            models.Claim(
                project_id=uuid.UUID(project),
                text=f"{subject} relates_to {obj}",
                subject=subject,
                predicate="relates_to",
                object=obj,
                object_entity_key=entity_id(object_type, obj) if object_type else None,
                tags=tags,
            )
        )
        await session.commit()


async def _seed_star(
    graph: AgeGraphStore, scope: ProjectScope, center: _Ent, neighbours: list[_Ent]
) -> None:
    """Physically wire ``center`` to every neighbour in the real AGE graph, one hop out."""
    await graph.create_graph(scope)
    center_id = str(entity_id(center.type, center.name))
    nodes = [
        GraphNode(
            id=center_id,
            labels=frozenset({"Entity"}),
            properties={"name": center.name, "type": center.type},
        )
    ]
    edges: list[GraphEdge] = []
    for n in neighbours:
        nid = str(entity_id(n.type, n.name))
        nodes.append(
            GraphNode(
                id=nid, labels=frozenset({"Entity"}), properties={"name": n.name, "type": n.type}
            )
        )
        edges.append(GraphEdge(source_id=center_id, target_id=nid, type="RELATED"))
    await graph.upsert_nodes(scope, nodes)
    await graph.upsert_edges(scope, edges)


def _make_neighbours(
    prefix: str, etype: str, *, n_visible: int, n_hidden: int
) -> tuple[list[_Ent], list[_Ent]]:
    """Build ``n_visible + n_hidden`` candidate neighbours, sort them by the SAME id the graph
    store sorts by (``entity_id(type, name)``), then alternate hidden/visible labels over that
    sorted order. This guarantees hidden neighbours interleave before, within, and after visible
    ones regardless of naming luck — the exact shape the AUDIT-035 acceptance criteria require
    pagination to survive."""
    total = n_visible + n_hidden
    candidates = [f"{prefix}-{i}" for i in range(total)]
    candidates.sort(key=lambda nm: str(entity_id(etype, nm)))
    visible: list[_Ent] = []
    hidden: list[_Ent] = []
    for i, name in enumerate(candidates):
        want_hidden_first = i % 2 == 0
        if want_hidden_first and len(hidden) < n_hidden:
            hidden.append(_Ent(name=name, type=etype))
        elif len(visible) < n_visible:
            visible.append(_Ent(name=name, type=etype))
        else:
            hidden.append(_Ent(name=name, type=etype))
    return visible, hidden


async def _seed_topic_claims(
    harness: Harness, project: str, center: _Ent, visible: list[_Ent], hidden: list[_Ent]
) -> None:
    for n in visible:
        await _insert_claim(harness, project, subject=center.name, obj=n.name, tags=[VISIBLE])
    for n in hidden:
        await _insert_claim(harness, project, subject=center.name, obj=n.name, tags=[HIDDEN])


async def test_mixed_topic_total_and_pagination_describe_only_authorized_neighbours(
    build_harness: Callable[..., Harness],
) -> None:
    """Scenario 1: a high-degree entity with neighbours in an authorized topic AND a hidden one —
    the reported total must equal the authorized count, and walking every page must yield every
    authorized neighbour exactly once, with hidden neighbours interleaved before/within/after."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("graph"), [(VISIBLE, 0), (HIDDEN, 0)])
    scope = harness.scope(project, allowed_topics=[VISIBLE])
    graph = AgeGraphStore(harness.sm)

    center = await _insert_entity(harness, project, "Hub", "org")
    visible, hidden = _make_neighbours("Neighbour", "org", n_visible=9, n_hidden=6)
    await _seed_topic_claims(harness, project, center, visible, hidden)
    await _seed_star(graph, scope, center, visible + hidden)

    page_size = 4
    totals: set[int] = set()
    page_lengths: list[int] = []
    collected: dict[str, str] = {}
    offset = 0
    for _ in range(10):  # generous ceiling; the authorized set fits in 3 pages of 4/4/1
        view = await entity_neighborhood(
            harness.sm, graph, scope, name=center.name, limit=page_size, offset=offset
        )
        assert view is not None
        totals.add(view.total)
        if not view.neighbors:
            break
        page_lengths.append(len(view.neighbors))
        for nb in view.neighbors:
            assert nb.name.startswith("Neighbour-") and nb.name not in {h.name for h in hidden}, (
                f"a hidden neighbour leaked into an authorized page: {nb.name!r}"
            )
            collected[nb.id] = nb.name
        offset += page_size

    assert totals == {9}, (
        f"total must be the authorized neighbour count (9) on every page, got {totals}"
    )
    assert len(collected) == 9, (
        f"walking every page must yield exactly the 9 authorized neighbours exactly once, "
        f"got {len(collected)}: {sorted(collected.values())}"
    )
    assert page_lengths[:-1] == [page_size] * (len(page_lengths) - 1), (
        f"every non-final page must be the full authorized page size ({page_size}); "
        f"post-filtering after pagination produced short/empty pages: {page_lengths}"
    )


async def test_page_size_is_honoured_when_authorized_neighbours_remain(
    build_harness: Callable[..., Harness],
) -> None:
    """Scenario 2: asking for N neighbours returns N while N authorized neighbours remain, even
    though the physical neighbourhood also contains hidden entries interleaved with them."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("graph"), [(VISIBLE, 0), (HIDDEN, 0)])
    scope = harness.scope(project, allowed_topics=[VISIBLE])
    graph = AgeGraphStore(harness.sm)

    center = await _insert_entity(harness, project, "Nexus", "org")
    visible, hidden = _make_neighbours("Ally", "org", n_visible=10, n_hidden=10)
    await _seed_topic_claims(harness, project, center, visible, hidden)
    await _seed_star(graph, scope, center, visible + hidden)

    view = await entity_neighborhood(harness.sm, graph, scope, name=center.name, limit=3, offset=0)
    assert view is not None
    assert len(view.neighbors) == 3, (
        f"requesting page size 3 with 10 authorized neighbours remaining must return exactly 3, "
        f"got {len(view.neighbors)}: {[n.name for n in view.neighbors]}"
    )
    assert all(n.name.startswith("Ally-") for n in view.neighbors)


async def test_revocation_reduces_total_and_stops_returning_neighbours(
    build_harness: Callable[..., Harness],
) -> None:
    """Scenario 3: after a topic's authority is revoked, the total and later pages must reflect
    the reduced authorized set — no cursor may keep returning now-unauthorized neighbours."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("graph"), [("always", 0), ("eng", 0)])
    graph = AgeGraphStore(harness.sm)

    center = await _insert_entity(harness, project, "Program", "org")
    keepalive = await _insert_entity(harness, project, "Sponsor", "org")
    eng_neighbours = [
        await _insert_entity(harness, project, f"Engineer-{i}", "org") for i in range(5)
    ]

    await _insert_claim(harness, project, subject=center.name, obj=keepalive.name, tags=["always"])
    for n in eng_neighbours:
        await _insert_claim(harness, project, subject=center.name, obj=n.name, tags=["eng"])

    scope_before = harness.scope(project, allowed_topics=["always", "eng"])
    await _seed_star(graph, scope_before, center, [keepalive, *eng_neighbours])

    view_before = await entity_neighborhood(
        harness.sm, graph, scope_before, name=center.name, limit=10, offset=0
    )
    assert view_before is not None
    assert {n.name for n in view_before.neighbors} == {
        keepalive.name,
        *(n.name for n in eng_neighbours),
    }

    # Revoke "eng": a caller who now only carries "always" must see only the keepalive neighbour.
    scope_after = harness.scope(project, allowed_topics=["always"])
    view_after = await entity_neighborhood(
        harness.sm, graph, scope_after, name=center.name, limit=10, offset=0
    )
    assert view_after is not None
    assert view_after.total == 1, (
        f"after revoking 'eng', the total must reflect only the still-authorized keepalive "
        f"neighbour (1), got {view_after.total}"
    )
    assert {n.name for n in view_after.neighbors} == {keepalive.name}

    # A later page requested with the reduced authority must not resurrect revoked neighbours.
    later_page = await entity_neighborhood(
        harness.sm, graph, scope_after, name=center.name, limit=10, offset=1
    )
    assert later_page is not None
    assert later_page.neighbors == [], (
        "a page requested past the reduced authorized total must be empty, not reveal a "
        "now-unauthorized 'eng' neighbour through the cursor"
    )
    assert later_page.total == 1


async def test_name_type_collision_does_not_leak_across_entities(
    build_harness: Callable[..., Harness],
) -> None:
    """Scenario 4: two entities share a normalized name but differ by type. A visible claim about
    one identity must never authorize, select, or reveal the other — even when both are physical
    graph neighbours of the same visible center."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("graph"), [(VISIBLE, 0)])
    scope = harness.scope(project, allowed_topics=[VISIBLE])
    graph = AgeGraphStore(harness.sm)

    center = await _insert_entity(harness, project, "Hub", "org")
    visible_person = await _insert_entity(harness, project, "Jessie", "person")
    unrelated_codename = await _insert_entity(harness, project, "Jessie", "codename")

    # Only the person identity has ANY claim tying it to the center — the codename identity has
    # zero claims of its own and must be indistinguishable from absent.
    #
    # The claim names the identity it is about, exactly as the ingest pipeline does. T001 wrote it
    # with the bare name, which cannot express this scenario at all: with two entities sharing the
    # normalized name, a name-only claim is evidence about both or about neither, so no
    # implementation could have returned exactly the person. The fixture is what was
    # underdetermined; the assertion below — a visible claim for one identity never reveals the
    # other — is unchanged, and now actually tests identity-keyed authorization.
    await _insert_claim(
        harness,
        project,
        subject=center.name,
        obj=visible_person.name,
        tags=[VISIBLE],
        object_type=visible_person.type,
    )

    await _seed_star(graph, scope, center, [visible_person, unrelated_codename])

    view = await entity_neighborhood(harness.sm, graph, scope, name=center.name, limit=10, offset=0)
    assert view is not None
    assert len(view.neighbors) == 1, (
        f"only the person-typed 'Jessie' has a visible claim; the codename-typed 'Jessie' with "
        f"zero claims must not leak through the name collision, got: "
        f"{[(n.name, n.type) for n in view.neighbors]}"
    )
    assert view.neighbors[0].type == "person"
    assert not any(n.type == unrelated_codename.type for n in view.neighbors)


async def test_oversized_limit_request_is_clamped_and_total_stays_authorized(
    build_harness: Callable[..., Harness],
) -> None:
    """Scenario 5: an unbounded traversal/expansion request is clamped rather than materializing
    the whole neighbourhood, and the reported total still describes only the authorized set even
    when the caller asks for far more than it needs."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("graph"), [(VISIBLE, 0), (HIDDEN, 0)])
    scope = harness.scope(project, allowed_topics=[VISIBLE])
    graph = AgeGraphStore(harness.sm)

    center = await _insert_entity(harness, project, "Core", "org")
    visible, hidden = _make_neighbours("Node", "org", n_visible=12, n_hidden=8)
    await _seed_topic_claims(harness, project, center, visible, hidden)
    await _seed_star(graph, scope, center, visible + hidden)

    view = await entity_neighborhood(
        harness.sm, graph, scope, name=center.name, limit=999_999, offset=0
    )
    assert view is not None
    assert view.limit <= 200, f"an unbounded limit request must be clamped, got {view.limit}"
    assert view.total == 12, (
        f"an oversized limit must not materialize the whole neighbourhood nor leak the hidden "
        f"count into the total; expected the authorized count 12, got {view.total}"
    )
    hidden_names = {n.name for n in hidden}
    assert not any(n.name in hidden_names for n in view.neighbors), (
        "a hidden neighbour leaked into the response for an oversized limit request"
    )
    assert len(view.neighbors) == 12
