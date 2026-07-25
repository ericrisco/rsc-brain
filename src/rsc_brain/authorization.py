"""Named capability decisions — the one server-side authority the console surface consults.

AUDIT-020 (R01-R04), AUDIT-030 (R10) and AUDIT-036 (R05/R06/R15) all failed the same way: each
route invented its own gate, so "is this caller an admin?" meant something different on every
path. This module is the single decision point. A route names the *operation*, never a role, and
never re-derives authority from ``can_curate`` or a platform role.

The ratified matrix (AUDIT-020 clarifications, 2026-07-24):

* a **platform** role (``users.role`` owner/admin) carries platform and project-lifecycle
  authority — creating projects, inviting users — and **no** project content authority. Content
  access always requires an explicit membership in that project;
* a **project role** (``project_memberships.role``) governs that project only. ``project-admin``
  manages it, ``member`` participates, ``viewer`` never mutates;
* ``can_curate`` authorizes **only** assigned knowledge-review decisions within the principal's
  own project and topics. It grants no project, ontology, logging, gap, export,
  document-lifecycle or platform authority;
* empty topic authority never means "all topics";
* the decision is taken per operation, from freshly resolved state, so a revocation takes effect
  on the very next call (nothing is cached here).

Deny-by-default: :func:`decide` returns :class:`Allow` only for a rule that names the capability
explicitly. Where the existence of the object is itself sensitive, callers map
:class:`NotFoundEquivalent` to the same 404 an absent object produces (FR-4.3).
"""

from __future__ import annotations

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from enum import StrEnum

from rsc_brain.scope import (
    NON_TOPIC_TAGS,
    PROJECT_ROLE_ADMIN,
    PROJECT_ROLE_MEMBER,
    PrincipalType,
    ProjectScope,
)

#: Platform roles that carry platform (never project-content) authority.
PLATFORM_ADMIN_ROLES = frozenset({"owner", "admin"})
#: Project roles that may participate in a read at all (a viewer reads, never mutates).
_READ_ROLES = frozenset({PROJECT_ROLE_ADMIN, PROJECT_ROLE_MEMBER, "viewer"})


class Capability(StrEnum):
    """Every named operation the console/management surface can decide.

    One member per *operation*, not per route: two routes that perform the same operation share a
    capability, and a route never checks a role directly.
    """

    # --- platform lifecycle (platform role; no project content) ---------------
    PLATFORM_PROJECT_CREATE = "platform.project.create"
    PLATFORM_USER_INVITE = "platform.user.invite"
    PLATFORM_PROJECT_LIST_ALL = "platform.project.list_all"
    PLATFORM_CREDENTIAL_REVOKE = "platform.credential.revoke"
    # --- project management (project-admin) ----------------------------------
    PROJECT_MANAGE_READ = "project.manage.read"
    PROJECT_CONFIG_WRITE = "project.config.write"
    PROJECT_SETTINGS_WRITE = "project.settings.write"
    DOCUMENT_DECIDE = "document.decide"
    GAP_PROMOTE = "gap.promote"
    HUNT_MANAGE = "hunt.manage"
    # --- project participation (any membership; always topic-filtered) -------
    KNOWLEDGE_READ = "knowledge.read"
    USAGE_READ = "usage.read"
    # --- curation (the ONLY capability can_curate grants) --------------------
    KNOWLEDGE_REVIEW_DECIDE = "knowledge.review.decide"
    # --- corrections (project-admin OR the owner of the target claim's tags) -
    CORRECTION_REVERT = "correction.revert"
    # --- operations (a dedicated operator credential; not a project role) ----
    OPERATOR_METRICS_READ = "operator.metrics.read"


#: Capabilities whose decision is a function of the platform role.
_PLATFORM_CAPABILITIES = frozenset(
    {
        Capability.PLATFORM_PROJECT_CREATE,
        Capability.PLATFORM_USER_INVITE,
        Capability.PLATFORM_PROJECT_LIST_ALL,
        Capability.PLATFORM_CREDENTIAL_REVOKE,
    }
)
#: Capabilities that require the ``project-admin`` membership role.
_PROJECT_ADMIN_CAPABILITIES = frozenset(
    {
        Capability.PROJECT_MANAGE_READ,
        Capability.PROJECT_CONFIG_WRITE,
        Capability.PROJECT_SETTINGS_WRITE,
        Capability.DOCUMENT_DECIDE,
        Capability.GAP_PROMOTE,
        Capability.HUNT_MANAGE,
    }
)
#: Capabilities any member of the project holds (the read is still topic-filtered downstream).
_MEMBER_CAPABILITIES = frozenset({Capability.KNOWLEDGE_READ, Capability.USAGE_READ})


@dataclass(frozen=True, slots=True)
class Allow:
    """An authorized decision, with the topics it is authorized over.

    ``decision_id`` identifies this decision in the audit trail; ``effective_topics`` is the topic
    authority every downstream read/write must be filtered by — never the caller's request.
    """

    capability: Capability
    decision_id: str
    effective_topics: frozenset[str]


@dataclass(frozen=True, slots=True)
class Deny:
    """The caller is authenticated and the object's existence is not sensitive → 403."""

    capability: Capability
    reason: str


@dataclass(frozen=True, slots=True)
class NotFoundEquivalent:
    """Denied where existence is sensitive → the caller sees exactly what absence looks like."""

    capability: Capability
    reason: str = "not found"


Decision = Allow | Deny | NotFoundEquivalent


def _allow(scope: ProjectScope, capability: Capability, topics: frozenset[str]) -> Allow:
    return Allow(capability=capability, decision_id=str(uuid.uuid4()), effective_topics=topics)


def _topics_authorized(
    scope: ProjectScope, object_topics: Collection[str] | None
) -> tuple[bool, str]:
    """Whether the caller's topic authority covers EVERY topic of the object.

    Subset, not overlap: a decision over an object discloses or publishes all of that object's
    topics, so partial authority is not authority. An object with no topic dimension imposes no
    topic requirement; a caller with no topic authority never gains one by omission.
    """
    if object_topics is None:
        return True, ""
    required = {t for t in object_topics if t} - NON_TOPIC_TAGS
    if not required:
        return True, ""
    if not scope.allowed_topics:
        return False, "no topic authority"
    missing = required - set(scope.allowed_topics)
    if missing:
        return False, "topic outside the caller's authority"
    return True, ""


def decide(
    scope: ProjectScope,
    capability: Capability,
    *,
    object_topics: Collection[str] | None = None,
    object_owner: bool = False,
    sensitive_existence: bool = False,
) -> Decision:
    """Decide ``capability`` for ``scope``, deny by default.

    ``object_topics`` are the topics of the object being acted on (document tags, gap topics, the
    tags a decision would apply). ``object_owner`` is the caller-specific ownership fact a few
    capabilities admit in addition to a role (the tag owner of a correction, FR-15.8).
    ``sensitive_existence`` makes a refusal indistinguishable from absence (FR-4.3).
    """
    denial: type[Deny] | type[NotFoundEquivalent] = (
        NotFoundEquivalent if sensitive_existence else Deny
    )

    def refuse(reason: str) -> Decision:
        return denial(capability=capability, reason=reason)

    # Every capability in this module belongs to the console/management surface, which is a human
    # surface: an agent credential reaches knowledge tools, never project administration.
    if scope.principal_type is not PrincipalType.HUMAN:
        return refuse("not a human principal")

    if capability in _PLATFORM_CAPABILITIES:
        if scope.platform_role in PLATFORM_ADMIN_ROLES:
            return _allow(scope, capability, frozenset(scope.allowed_topics))
        return refuse("platform administration required")

    if capability is Capability.OPERATOR_METRICS_READ:
        # The operator credential contract does not exist yet (task T008). Until it does, the
        # operational scrape has NO authorized caller — which is the safe state, not a stub allow.
        return refuse("operator credential required")

    topics_ok, topic_reason = _topics_authorized(scope, object_topics)

    if capability in _PROJECT_ADMIN_CAPABILITIES:
        if scope.role != PROJECT_ROLE_ADMIN:
            return refuse("project administration required")
        if not topics_ok:
            return refuse(topic_reason)
        return _allow(scope, capability, frozenset(scope.allowed_topics))

    if capability in _MEMBER_CAPABILITIES:
        if scope.role not in _READ_ROLES:
            return refuse("project membership required")
        if not topics_ok:
            return refuse(topic_reason)
        return _allow(scope, capability, frozenset(scope.allowed_topics))

    if capability is Capability.KNOWLEDGE_REVIEW_DECIDE:
        if not (scope.can_curate or scope.role == PROJECT_ROLE_ADMIN):
            return refuse("curation capability required")
        if not topics_ok:
            return refuse(topic_reason)
        return _allow(scope, capability, frozenset(scope.allowed_topics))

    if capability is Capability.CORRECTION_REVERT:
        if scope.role != PROJECT_ROLE_ADMIN and not object_owner:
            return refuse("project administration or topic ownership required")
        if scope.role != PROJECT_ROLE_ADMIN and not topics_ok:
            return refuse(topic_reason)
        return _allow(scope, capability, frozenset(scope.allowed_topics))

    return refuse("unknown capability")  # pragma: no cover - exhaustive above
