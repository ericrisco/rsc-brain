"""Project scope — the indivisible authority binding an identity to one project.

This is the load-bearing security primitive frozen in SPEC-01 to satisfy AUDIT-003.

The invariant: an authenticated identity and the project it is authorized for are a
**single, indivisible authority** (:class:`ProjectScope`). Every store, recall, and
ingest boundary accepts a ``ProjectScope`` and **never** a bare ``project_id`` supplied
independently. A caller therefore cannot combine a principal resolved for project A with
project B — the type system makes the unsafe state unrepresentable at the boundary, and
project-owned objects are checked with :meth:`ProjectScope.require` before any side effect.

Denied/mismatched paths raise :class:`CrossProjectScopeError`, whose message is constant
and reveals nothing about whether the other project or object exists (indistinguishability,
FR-4.3).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Protocol


class PrincipalType(StrEnum):
    """Kind of authenticated caller (FR-14.1)."""

    HUMAN = "human"
    AGENT = "agent"


# Project roles (``project_memberships.role``) and platform roles (``users.role``) are DISTINCT
# authorities (AUDIT-020/R03): a platform administrator performs platform and project-lifecycle
# operations, a project role governs that project's content. Neither implies the other, and
# ``can_curate`` is neither — it authorizes only assigned knowledge-review decisions.
PROJECT_ROLE_ADMIN = "project-admin"
PROJECT_ROLE_MEMBER = "member"
PROJECT_ROLE_VIEWER = "viewer"
#: The role carried by a non-human principal: it is never a project membership role, so no
#: console/management capability can be satisfied by an agent credential.
PROJECT_ROLE_AGENT = "agent"
PLATFORM_ROLE_MEMBER = "member"

#: Sentinel values that occupy a topic column without being topics. A chunk held back for review
#: carries ``__needs_review__`` *instead of* its tags (it has not been topicalized yet), so a row
#: carrying only sentinels has no topic dimension: it is neither authorized by nor withheld from
#: any topic. Every authorization and visibility decision strips these before comparing.
#: ``__rejected__`` joins it for the same reason (R26): a refused chunk carries the marker as a
#: record of the decision, and a record is not a topic anyone can be authorized against.
NON_TOPIC_TAGS: frozenset[str] = frozenset({"__needs_review__", "__rejected__"})


class ScopeError(Exception):
    """Base class for scope/authorization failures."""


class CrossProjectScopeError(ScopeError):
    """Raised when an identity or object is used outside its authorized project.

    The message is intentionally constant: it must not reveal whether the target
    project or object exists (FR-4.3 indistinguishability).
    """

    _MESSAGE = "not found"

    def __init__(self) -> None:
        super().__init__(self._MESSAGE)


@dataclass(frozen=True, slots=True)
class Principal:
    """An authenticated identity, independent of any single project.

    Resolving a principal against a project it is a member of yields a
    :class:`ProjectScope`; that is the only supported way to obtain scope, so scope
    is always already bound to the authenticated identity.
    """

    id: str
    type: PrincipalType
    allowed_topics: frozenset[str] = frozenset()
    can_curate: bool = False
    #: Membership role in the project this principal is bound to (AUDIT-020). The default is the
    #: LEAST project authority, so a scope built without an explicit role can never satisfy a
    #: management capability by omission.
    role: str = PROJECT_ROLE_MEMBER
    #: Global ``users.role`` — platform authority only, never project content authority.
    platform_role: str = PLATFORM_ROLE_MEMBER

    def scope_for(self, project_id: str) -> ProjectScope:
        """Bind this identity to ``project_id``, producing an indivisible scope."""
        return ProjectScope(
            principal_id=self.id,
            principal_type=self.type,
            project_id=project_id,
            allowed_topics=self.allowed_topics,
            can_curate=self.can_curate,
            role=self.role,
            platform_role=self.platform_role,
        )

    def platform_scope(self) -> PlatformIdentityScope:
        """Return identity-only authority for a platform operation.

        This deliberately carries neither a project nor membership-derived state.  A platform
        decision made from it can therefore never be passed to a project-owned store.
        """
        return PlatformIdentityScope(
            principal_id=self.id,
            principal_type=self.type,
            platform_role=self.platform_role,
        )


@dataclass(frozen=True, slots=True)
class PlatformIdentityScope:
    """An authenticated identity for platform operations, never project content.

    Unlike :class:`ProjectScope`, this type has no project identifier, membership role, topic
    grant, or curation flag.  It is consequently not accepted by any project data boundary.
    """

    principal_id: str
    principal_type: PrincipalType
    platform_role: str = PLATFORM_ROLE_MEMBER


@dataclass(frozen=True, slots=True)
class ProjectScope:
    """An authenticated identity bound to exactly one project (AUDIT-003).

    Carries the principal's identity and the single project it is authorized for.
    Because downstream interfaces accept this object rather than a separate
    ``project_id``, the authority cannot be rebound to a different project by a
    later caller.
    """

    principal_id: str
    principal_type: PrincipalType
    project_id: str
    allowed_topics: frozenset[str] = frozenset()
    can_curate: bool = False
    on_behalf_of: str | None = None  # set when an agent acts for a human (SPEC-11)
    role: str = PROJECT_ROLE_MEMBER  # project membership role (AUDIT-020)
    platform_role: str = PLATFORM_ROLE_MEMBER  # global users.role — platform authority only

    def authorizes(self, project_id: str) -> bool:
        """True iff this scope is authorized for ``project_id``."""
        return self.project_id == project_id

    def require(self, project_id: str) -> None:
        """Fail closed unless this scope is authorized for ``project_id``.

        Call this at every stage boundary that consumes a project-owned object,
        **before** any query, model call, write, or sensitive log occurs.
        """
        if project_id != self.project_id:
            raise CrossProjectScopeError

    def require_object(self, owned: HasProjectId) -> None:
        """Fail closed unless ``owned.project_id`` matches this scope."""
        self.require(owned.project_id)

    def delegate_to(self, agent: Principal) -> ProjectScope:
        """Delegate to an agent within the SAME project (SPEC-11 on_behalf_of).

        Effective permissions are the **intersection** of the agent's and this
        scope's authority; the project is never changed or broadened.
        """
        if agent.type is not PrincipalType.AGENT:
            raise ScopeError("delegation target must be an agent principal")
        return replace(
            self,
            principal_id=agent.id,
            principal_type=PrincipalType.AGENT,
            allowed_topics=self.allowed_topics & agent.allowed_topics,
            can_curate=self.can_curate and agent.can_curate,
            on_behalf_of=self.principal_id,
            # Delegation is an intersection, never an elevation: the acting agent holds no
            # membership role and no platform role, so neither can be inherited (AUDIT-020/R15).
            role=PROJECT_ROLE_AGENT,
            platform_role=PLATFORM_ROLE_MEMBER,
        )


class HasProjectId(Protocol):
    """Structural type: any project-owned object exposes ``project_id``.

    Concrete owned objects (e.g. ingest ``RawSource``) declare ``project_id: str``
    and are accepted wherever :meth:`ProjectScope.require_object` is called, without
    needing to inherit anything.
    """

    @property
    def project_id(self) -> str: ...
