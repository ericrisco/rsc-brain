"""Knowledge-mutation authority (AUDIT-036, R05/R06/R15) against the real container.

Exercises the agent/PAT/MCP write, feedback, and correction paths **as production reaches
them** — `do_submit_knowledge`, `do_report_feedback`, `do_correct_knowledge`
(``rsc_brain.mcp.tools``) are the exact functions the MCP server's tools and the REST surface
call once a bearer token has been resolved to a scope.

* R05 (high) — a knowledge write's tags must be intersected with the caller's ``allowed_topics``
  *before* any persistence. Today ``AgentWriteService.submit`` persists whatever tags it is given
  (``knowledge/agent_writes.py:85-93,118-143``) and ``do_submit_knowledge``
  (``mcp/tools.py:446-471``) forwards them unchecked.

* R06 (high) — a claim outside the caller's topic visibility must be neither mutated nor
  inferable by identifier: the response must be indistinguishable from a nonexistent claim, and
  the claim's stored state must be untouched. Today ``KnowledgeStore.get_claim`` filters by
  project only (``knowledge_store.py:272-277``), so ``feedback.py:46-71`` mutates credibility and
  ``corrections.py:202-225`` creates a distinguishable, existence-revealing ``Correction`` row for
  claims the caller cannot see.

* R15 (medium) — correction attribution must derive from a validated identity/delegation, never
  from the client-supplied ``on_behalf_of`` string. Today it crosses raw from
  ``mcp/server.py:211-233`` / ``mcp/tools.py:485-518`` into ``corrections.py:79-106`` with zero
  delegation check, and even a *genuinely* delegated agent's own id is dropped from provenance
  (``author_id=None`` in the agent-suggestion branch).

R32 (concurrent/retried writes converging to one logical effect) is explicitly **out of scope**
here — owned by task T015.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.identity.resolve import resolve_delegated_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.knowledge.corrections import CorrectionService
from rsc_brain.mcp.tools import do_correct_knowledge, do_report_feedback, do_submit_knowledge
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

# Two topics of differing sensitivity, used across every test in this file.
TOPICS = [("general", 0), ("hr", 3)]


# --- local helpers (this file owns no shared fixtures; see brief rule 8) ---


def _agent(project_id: str, topics: tuple[str, ...]) -> ProjectScope:
    return Principal(
        id=str(uuid.uuid4()), type=PrincipalType.AGENT, allowed_topics=frozenset(topics)
    ).scope_for(project_id)


def _human_scope(project_id: str, user_id: str, *, topics: tuple[str, ...] = ()) -> ProjectScope:
    return Principal(
        id=user_id, type=PrincipalType.HUMAN, allowed_topics=frozenset(topics)
    ).scope_for(project_id)


async def _claim_and_chunk_counts(harness: Harness, project_id: str) -> tuple[int, int]:
    async with harness.sm() as session:
        claims = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == uuid.UUID(project_id))
        )
        chunks = await session.scalar(
            select(func.count())
            .select_from(models.Chunk)
            .where(models.Chunk.project_id == uuid.UUID(project_id))
        )
        return int(claims or 0), int(chunks or 0)


async def _insert_claim(
    harness: Harness, project_id: str, *, tags: list[str], credibility: float = 0.5
) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            text="a claim under test",
            subject="s",
            credibility=credibility,
            tags=tags,
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
    return claim_id


async def _raw_claim(harness: Harness, claim_id: str) -> models.Claim | None:
    """Read the claim row directly — bypassing any scope-filtered store — for trustworthy
    before/after snapshot assertions (the store under test is exactly what we don't trust)."""
    async with harness.sm() as session:
        return await session.get(models.Claim, uuid.UUID(claim_id))


async def _correction_count(
    harness: Harness,
    project_id: str,
    *,
    on_behalf_of: str | None = None,
    target_claim: str | None = None,
) -> int:
    async with harness.sm() as session:
        query = (
            select(func.count())
            .select_from(models.Correction)
            .where(models.Correction.project_id == uuid.UUID(project_id))
        )
        if on_behalf_of is not None:
            query = query.where(models.Correction.on_behalf_of == uuid.UUID(on_behalf_of))
        if target_claim is not None:
            query = query.where(models.Correction.target_claim == uuid.UUID(target_claim))
        total = await session.scalar(query)
        return int(total or 0)


async def _make_user(harness: Harness) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('user')}@example.com", status="active")
    )
    return user.user_id


async def _make_person(harness: Harness, project_id: str, user_id: str, topics: list[str]) -> None:
    async with harness.sm() as session:
        session.add(
            models.Person(
                project_id=uuid.UUID(project_id),
                user_id=uuid.UUID(user_id),
                name="Owner",
                topics=topics,
            )
        )
        await session.commit()


async def _member(harness: Harness, project_id: str, topics: tuple[str, ...]) -> str:
    identity = IdentityService(harness.sm)
    inv = await identity.invite_user(f"{unique_slug('deleg')}@example.com", role="member")
    user_id = await identity.accept_invitation(inv.token, "password-abc-123456")
    await identity.add_membership(user_id, project_id, allowed_topics=topics)
    return user_id


def _service(harness: Harness) -> CorrectionService:
    return CorrectionService(
        store=KnowledgeStore(harness.sm), graph=AgeGraphStore(harness.sm), gateway=harness.gateway
    )


# ============================================================================
# R05 — write tags must be intersected with the caller's allowed_topics
# ============================================================================


async def test_agent_write_same_topic_succeeds(build_harness: Callable[..., Harness]) -> None:
    """A→A: an agent authorized only for 'general' writes tags=['general'] and succeeds."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    control_project = await harness.setup_project(unique_slug("control"), TOPICS)
    agent = _agent(project, ("general",))

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text="ok", idempotency_key="k-aa", tags=["general"]
    )
    assert result.ok is True
    assert result.status in {"quarantined", "active"}
    claims, chunks = await _claim_and_chunk_counts(harness, project)
    assert claims == 1 and chunks == 1
    # A second, unrelated project is never touched by any of this.
    other_claims, other_chunks = await _claim_and_chunk_counts(harness, control_project)
    assert other_claims == 0 and other_chunks == 0


async def test_agent_write_outside_allowed_topic_is_refused_without_side_effect(
    build_harness: Callable[..., Harness],
) -> None:
    """A→B: an agent authorized only for 'general' writes tags=['hr'] — must be refused, and
    NOT ONE ROW created (chunk, claim, or otherwise) — not merely an error response."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    agent = _agent(project, ("general",))
    before = await _claim_and_chunk_counts(harness, project)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text="leak", idempotency_key="k-ab", tags=["hr"]
    )
    assert result.ok is False
    assert result.status == "rejected"
    assert result.claim_ids == []
    after = await _claim_and_chunk_counts(harness, project)
    assert after == before  # snapshot unchanged by the refused attempt


async def test_agent_write_unknown_topic_is_refused_without_side_effect(
    build_harness: Callable[..., Harness],
) -> None:
    """A→unknown-topic: writing a tag that isn't even a topic in this project must be refused
    exactly like writing a real-but-forbidden topic — an unregistered label is not a loophole."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    agent = _agent(project, ("general",))
    before = await _claim_and_chunk_counts(harness, project)

    result = await do_submit_knowledge(
        harness.sm,
        harness.gateway,
        agent,
        text="leak",
        idempotency_key="k-ac",
        tags=["nonexistent-topic"],
    )
    assert result.ok is False
    assert result.status == "rejected"
    after = await _claim_and_chunk_counts(harness, project)
    assert after == before


async def test_agent_write_empty_tag_set_is_refused_without_side_effect(
    build_harness: Callable[..., Harness],
) -> None:
    """A→empty-topic-set: a write carrying no tags at all has nothing to intersect against the
    caller's authority and must be refused, not silently persisted untagged."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    agent = _agent(project, ("general",))
    before = await _claim_and_chunk_counts(harness, project)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text="untagged", idempotency_key="k-ad", tags=[]
    )
    assert result.ok is False
    assert result.status == "rejected"
    after = await _claim_and_chunk_counts(harness, project)
    assert after == before


async def test_agent_with_no_topic_authority_cannot_write_anywhere(
    build_harness: Callable[..., Harness],
) -> None:
    """Empty allowed_topics never means 'all topics' (ratified matrix) — an agent with no topic
    authority at all must be refused even for a topic that genuinely exists in the project."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    agent = _agent(project, ())  # no topic authority whatsoever
    before = await _claim_and_chunk_counts(harness, project)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text="leak", idempotency_key="k-ae", tags=["general"]
    )
    assert result.ok is False
    assert result.status == "rejected"
    after = await _claim_and_chunk_counts(harness, project)
    assert after == before


async def test_pat_write_outside_allowed_topic_is_refused_without_side_effect(
    build_harness: Callable[..., Harness],
) -> None:
    """The same defect through the PAT/human surface (not just agents) — a human whose PAT
    membership grants only 'general' cannot write knowledge tagged 'hr'."""
    from rsc_brain.identity.resolve import resolve_scope

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    user = await _make_user(harness)
    identity = IdentityService(harness.sm)
    membership_id = await identity.add_membership(user, project, allowed_topics=("general",))
    token = (await identity.issue_pat(membership_id)).token
    scope = await resolve_scope(harness.sm, token)
    assert scope is not None
    before = await _claim_and_chunk_counts(harness, project)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, scope, text="leak", idempotency_key="k-pat", tags=["hr"]
    )
    assert result.ok is False
    assert result.status == "rejected"
    after = await _claim_and_chunk_counts(harness, project)
    assert after == before


# ============================================================================
# R06 — a hidden-topic claim is neither mutated nor inferable by identifier
# ============================================================================


async def test_feedback_on_hidden_topic_claim_is_indistinguishable_and_unchanged(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    hidden_claim = await _insert_claim(harness, project, tags=["hr"], credibility=0.5)
    caller = await _make_user(harness)
    scope = _human_scope(project, caller, topics=("general",))  # never granted 'hr'
    before = await _raw_claim(harness, hidden_claim)
    assert before is not None

    hidden_result = await do_report_feedback(
        harness.sm, scope, claim_ids=[hidden_claim], signal="wrong"
    )
    absent_result = await do_report_feedback(
        harness.sm, scope, claim_ids=[str(uuid.uuid4())], signal="wrong"
    )
    # No side channel: hidden and nonexistent look identical from outside.
    assert hidden_result.model_dump() == absent_result.model_dump()

    after = await _raw_claim(harness, hidden_claim)
    assert after is not None
    assert after.credibility == before.credibility  # unchanged — the caller could not see it
    assert after.disputed == before.disputed


async def test_correction_on_hidden_topic_claim_is_indistinguishable_and_unchanged(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    hidden_claim = await _insert_claim(harness, project, tags=["hr"], credibility=0.6)
    caller = await _make_user(harness)
    scope = _human_scope(project, caller, topics=("general",))  # never granted 'hr'
    absent_claim = str(uuid.uuid4())

    hidden_outcome = await _service(harness).correct(
        scope, claim_id=hidden_claim, correction="tampered"
    )
    absent_outcome = await _service(harness).correct(
        scope, claim_id=absent_claim, correction="tampered"
    )
    # A hidden claim must produce the SAME status/explanation as a claim that never existed.
    assert hidden_outcome.status == absent_outcome.status
    assert hidden_outcome.explanation == absent_outcome.explanation

    # No side effect: no Correction row was ever created referencing the hidden claim.
    corrections = await _correction_count(harness, project, target_claim=hidden_claim)
    assert corrections == 0
    after = await _raw_claim(harness, hidden_claim)
    assert after is not None and after.valid_to is None and after.credibility == 0.6


# ============================================================================
# R15 — attribution must derive from a validated delegation, never a raw field
# ============================================================================


async def test_correction_spoofed_on_behalf_of_without_delegation_is_refused(
    build_harness: Callable[..., Harness],
) -> None:
    """A real owner corrects legitimately for themself, but spoofs `on_behalf_of` naming some
    unrelated third party who never delegated anything to them. Must be denied before any
    effect, and the durable provenance must never name the spoofed party."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["general"])
    claim = await _insert_claim(harness, project, tags=["general"], credibility=0.6)
    victim = await _make_user(harness)  # exists, but never delegated anything to `owner`
    scope = _human_scope(project, owner, topics=("general",))

    outcome = await _service(harness).correct(
        scope, claim_id=claim, correction="spoofed", on_behalf_of=victim
    )
    assert outcome.status != "applied"
    spoofed_rows = await _correction_count(harness, project, on_behalf_of=victim)
    assert spoofed_rows == 0  # the spoofed identity is never persisted as attribution
    unchanged = await _raw_claim(harness, claim)
    assert unchanged is not None and unchanged.valid_to is None and unchanged.credibility == 0.6


async def test_correction_revoked_delegation_on_behalf_of_is_refused(
    build_harness: Callable[..., Harness],
) -> None:
    """A delegation that was genuinely valid a moment ago (the represented human was an active
    project member) is revoked (disabled) before the correction is attempted. Revocation must
    take effect on the very next operation (FR-4.12) — the correction must be refused."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["general"])
    claim = await _insert_claim(harness, project, tags=["general"], credibility=0.6)

    agent_scope = _agent(project, ("general",))
    represented = await _member(harness, project, ("general",))
    delegation = await resolve_delegated_scope(harness.sm, agent_scope, represented)
    assert delegation is not None  # the delegation is genuinely valid right now...

    await IdentityService(harness.sm).deactivate_user(represented)
    assert (
        await resolve_delegated_scope(harness.sm, agent_scope, represented) is None
    )  # ...and now revoked

    outcome = await _service(harness).correct(
        agent_scope, claim_id=claim, correction="revoked", on_behalf_of=represented
    )
    assert outcome.status not in {"applied", "pending_confirmation", "routed_to_owner"}
    revoked_rows = await _correction_count(harness, project, on_behalf_of=represented)
    assert revoked_rows == 0
    unchanged = await _raw_claim(harness, claim)
    assert unchanged is not None and unchanged.valid_to is None


async def test_correction_delegation_valid_for_different_operation_is_refused(
    build_harness: Callable[..., Harness],
) -> None:
    """A delegation genuinely valid for the read/write knowledge surface (recall / submit_
    knowledge — `resolve_delegated_scope` succeeds right now) is not automatically authority to
    attribute a *correction* to the represented human; correct_knowledge never threads that
    delegation through, so it must refuse rather than accept the bare id."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["general"])
    claim = await _insert_claim(harness, project, tags=["general"], credibility=0.6)

    agent_scope = _agent(project, ("general",))
    represented = await _member(harness, project, ("general",))
    other_operation_delegation = await resolve_delegated_scope(harness.sm, agent_scope, represented)
    assert other_operation_delegation is not None  # valid for recall/submit_knowledge right now

    # The agent uses its OWN (non-delegated) scope for the correction and merely asserts the id.
    outcome = await do_correct_knowledge(
        harness.sm,
        AgeGraphStore(harness.sm),
        harness.gateway,
        agent_scope,
        claim_id=claim,
        topic=None,
        statement=None,
        correction="wrong-operation",
        on_behalf_of=represented,
    )
    assert outcome.status not in {"applied", "pending_confirmation", "routed_to_owner"}
    rows = await _correction_count(harness, project, on_behalf_of=represented)
    assert rows == 0
    unchanged = await _raw_claim(harness, claim)
    assert unchanged is not None and unchanged.valid_to is None


async def test_correction_with_valid_delegation_records_actor_and_represented(
    build_harness: Callable[..., Harness],
) -> None:
    """When a delegation IS valid, the mutation succeeds and provenance retains BOTH the
    authenticated (acting) agent and the represented human — never collapsing to just one."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["general"])
    claim = await _insert_claim(harness, project, tags=["general"], credibility=0.6)

    owner_scope = _human_scope(project, owner, topics=("general",))
    agent_principal = Principal(
        id=str(uuid.uuid4()), type=PrincipalType.AGENT, allowed_topics=frozenset({"general"})
    )
    delegated = owner_scope.delegate_to(agent_principal)
    assert delegated.on_behalf_of == owner
    assert delegated.principal_id == agent_principal.id

    outcome = await _service(harness).correct(
        delegated, claim_id=claim, correction="delegated fix", on_behalf_of=owner
    )
    assert outcome.correction_id is not None
    async with harness.sm() as session:
        row = await session.get(models.Correction, uuid.UUID(outcome.correction_id))
    assert row is not None
    assert row.on_behalf_of == uuid.UUID(owner)  # the represented human is retained
    assert row.author_id == uuid.UUID(agent_principal.id)  # the acting agent is NEVER dropped
