"""The capability matrix as a table (AUDIT-020) — the rules, stated once and readable.

The integration suite proves the matrix through HTTP; this file pins the rules themselves, including
the combinations the data model allows but no route can easily produce: a viewer who also carries
``can_curate`` (independent columns), an agent credential reaching a console capability, a platform
administrator with no membership.
"""

from __future__ import annotations

import pytest

from rsc_brain.authorization import Allow, Capability, Deny, NotFoundEquivalent, decide
from rsc_brain.scope import (
    PROJECT_ROLE_ADMIN,
    PROJECT_ROLE_MEMBER,
    PROJECT_ROLE_VIEWER,
    Principal,
    PrincipalType,
    ProjectScope,
)

PROJECT = "11111111-1111-1111-1111-111111111111"


def _scope(
    *,
    role: str = PROJECT_ROLE_MEMBER,
    platform_role: str = "member",
    can_curate: bool = False,
    topics: frozenset[str] = frozenset({"general"}),
    principal_type: PrincipalType = PrincipalType.HUMAN,
) -> ProjectScope:
    return Principal(
        id="22222222-2222-2222-2222-222222222222",
        type=principal_type,
        allowed_topics=topics,
        can_curate=can_curate,
        role=role,
        platform_role=platform_role,
    ).scope_for(PROJECT)


def _allowed(decision: object) -> bool:
    return isinstance(decision, Allow)


MANAGEMENT = [
    Capability.PROJECT_MANAGE_READ,
    Capability.PROJECT_CONFIG_WRITE,
    Capability.PROJECT_SETTINGS_WRITE,
    Capability.DOCUMENT_DECIDE,
    Capability.GAP_PROMOTE,
    Capability.HUNT_MANAGE,
]


@pytest.mark.parametrize("capability", MANAGEMENT)
def test_management_belongs_to_the_project_administrator(capability: Capability) -> None:
    assert _allowed(decide(_scope(role=PROJECT_ROLE_ADMIN), capability))
    assert not _allowed(decide(_scope(role=PROJECT_ROLE_MEMBER), capability))
    assert not _allowed(decide(_scope(role=PROJECT_ROLE_VIEWER), capability))


@pytest.mark.parametrize("capability", MANAGEMENT)
def test_curation_is_not_administration(capability: Capability) -> None:
    """R03: ``can_curate`` grants no management authority, whatever the route."""
    assert not _allowed(decide(_scope(role=PROJECT_ROLE_MEMBER, can_curate=True), capability))


@pytest.mark.parametrize("capability", MANAGEMENT)
def test_a_platform_administrator_is_not_a_project_administrator(capability: Capability) -> None:
    """R03: platform authority is not project content authority."""
    for platform_role in ("owner", "admin"):
        assert not _allowed(
            decide(_scope(role=PROJECT_ROLE_MEMBER, platform_role=platform_role), capability)
        )


def test_platform_capabilities_need_the_platform_role() -> None:
    assert _allowed(decide(_scope(platform_role="owner"), Capability.PLATFORM_PROJECT_CREATE))
    assert _allowed(decide(_scope(platform_role="admin"), Capability.PLATFORM_USER_INVITE))
    # …and a project administrator does not thereby administer the platform.
    assert not _allowed(decide(_scope(role=PROJECT_ROLE_ADMIN), Capability.PLATFORM_PROJECT_CREATE))


def test_reads_are_open_to_every_membership_including_a_viewer() -> None:
    for role in (PROJECT_ROLE_ADMIN, PROJECT_ROLE_MEMBER, PROJECT_ROLE_VIEWER):
        assert _allowed(decide(_scope(role=role), Capability.KNOWLEDGE_READ))
        assert _allowed(decide(_scope(role=role), Capability.USAGE_READ))


def test_curation_authorizes_only_the_review_decision() -> None:
    curator = _scope(role=PROJECT_ROLE_MEMBER, can_curate=True)
    assert _allowed(decide(curator, Capability.KNOWLEDGE_REVIEW_DECIDE))
    # A member without it does not review; a project administrator does, by role.
    assert not _allowed(decide(_scope(), Capability.KNOWLEDGE_REVIEW_DECIDE))
    assert _allowed(decide(_scope(role=PROJECT_ROLE_ADMIN), Capability.KNOWLEDGE_REVIEW_DECIDE))


def test_a_viewer_never_mutates_even_carrying_curation() -> None:
    """``role`` and ``can_curate`` are independent columns, so this combination is representable."""
    viewer_curator = _scope(role=PROJECT_ROLE_VIEWER, can_curate=True)
    assert not _allowed(decide(viewer_curator, Capability.KNOWLEDGE_REVIEW_DECIDE))
    assert not _allowed(decide(viewer_curator, Capability.CORRECTION_REVERT, object_owner=True))


def test_correction_revert_admits_the_topic_owner_and_the_administrator() -> None:
    owner = _scope(role=PROJECT_ROLE_MEMBER)
    assert _allowed(
        decide(owner, Capability.CORRECTION_REVERT, object_topics=["general"], object_owner=True)
    )
    assert _allowed(
        decide(
            _scope(role=PROJECT_ROLE_ADMIN),
            Capability.CORRECTION_REVERT,
            object_topics=["general"],
        )
    )
    # Neither: a member who owns nothing.
    assert not _allowed(decide(owner, Capability.CORRECTION_REVERT, object_topics=["general"]))


def test_topic_authority_must_cover_every_topic_of_the_object() -> None:
    admin = _scope(role=PROJECT_ROLE_ADMIN, topics=frozenset({"general"}))
    assert _allowed(decide(admin, Capability.DOCUMENT_DECIDE, object_topics=["general"]))
    # Partial authority over a multi-topic object is not authority (subset, not overlap).
    assert not _allowed(
        decide(admin, Capability.DOCUMENT_DECIDE, object_topics=["general", "hidden"])
    )
    # An object with no topic dimension imposes no topic requirement.
    assert _allowed(decide(admin, Capability.DOCUMENT_DECIDE, object_topics=[]))


def test_empty_topic_authority_is_never_all_topics() -> None:
    admin = _scope(role=PROJECT_ROLE_ADMIN, topics=frozenset())
    assert not _allowed(decide(admin, Capability.DOCUMENT_DECIDE, object_topics=["general"]))


def test_the_review_sentinel_is_not_a_topic() -> None:
    """A chunk held back for review carries a sentinel instead of tags; it is not a topic."""
    curator = _scope(role=PROJECT_ROLE_MEMBER, can_curate=True, topics=frozenset({"general"}))
    assert _allowed(
        decide(curator, Capability.KNOWLEDGE_REVIEW_DECIDE, object_topics=["__needs_review__"])
    )


def test_an_agent_credential_never_reaches_the_console_surface() -> None:
    agent = _scope(role=PROJECT_ROLE_ADMIN, principal_type=PrincipalType.AGENT, can_curate=True)
    for capability in Capability:
        assert not _allowed(decide(agent, capability)), capability


def test_the_operator_scrape_has_no_authorized_project_caller() -> None:
    """R10: until the operator credential contract exists (T008), nothing satisfies it."""
    for role in (PROJECT_ROLE_ADMIN, PROJECT_ROLE_MEMBER, PROJECT_ROLE_VIEWER):
        for platform_role in ("owner", "admin", "member"):
            decision = decide(
                _scope(role=role, platform_role=platform_role), Capability.OPERATOR_METRICS_READ
            )
            assert not _allowed(decision)


def test_a_sensitive_refusal_is_shaped_like_absence() -> None:
    denied = decide(_scope(), Capability.PROJECT_MANAGE_READ)
    hidden = decide(_scope(), Capability.PROJECT_MANAGE_READ, sensitive_existence=True)
    assert isinstance(denied, Deny)
    assert isinstance(hidden, NotFoundEquivalent)
