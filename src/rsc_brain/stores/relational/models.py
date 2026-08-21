"""SQLAlchemy 2.0 models mirroring the PRD §5.2 DDL.

Multiproject (D9): every knowledge/operation table carries ``project_id NOT NULL`` with a
composite index beginning at ``project_id``. Identity (D11): one ``users`` identity for MCP
and console; ``project_memberships`` is the source of permissions. The graph (AGE) replicates
knowledge nodes/edges; Postgres is the source of truth for operational data.

Per-phase schema deltas (plan §decisions): ``corrections`` (D15→SPEC-08), the bitemporal index
(D16→SPEC-13/17), and ontology columns (D17→SPEC-24) are NOT here — each lands in its own SPEC's
migration.
"""

from __future__ import annotations

import datetime as dt
import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Integer,
    MetaData,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

EMBEDDING_DIM = 1024

_NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=_NAMING_CONVENTION)


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, primary_key=True, server_default=func.gen_random_uuid())


def _project_fk() -> Mapped[uuid.UUID]:
    return mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)


def _tenant_fk(
    column: str, parent: str, *, ondelete: str = "CASCADE", name: str | None = None
) -> ForeignKeyConstraint:
    """A project-qualified reference: ``(project_id, column) -> parent (project_id, id)`` (R17).

    An ID-only foreign key lets a write that bypasses the service layer attach one project's child
    to another project's parent, and the resulting row passes every scope check that only compares
    the row's own ``project_id``. Composing the tenant into the key makes that row unwritable.

    ``SET NULL`` is column-restricted (PG15+): a composite ``ON DELETE SET NULL`` would try to null
    ``project_id``, which is the tenant and NOT NULL. Only the reference is cleared.
    """
    action = f"SET NULL ({column})" if ondelete == "SET NULL" else ondelete
    # Normally unnamed: the metadata naming convention derives
    # `fk_<child>_project_id_<column>_<parent>`, which is the name the migration creates. Pass
    # ``name`` where that would exceed Postgres's 63-character identifier limit — the server
    # truncates silently, so an over-length name means the model and the database disagree about it
    # and a rollback that drops it by name fails.
    return ForeignKeyConstraint(
        ["project_id", column],
        [f"{parent}.project_id", f"{parent}.id"],
        ondelete=action,
        name=name,
    )


def _created_at() -> Mapped[dt.datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# --------------------------------------------------------------------------- #
# Global identity & auth (users is global; membership is the permission source)
# --------------------------------------------------------------------------- #


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = _pk()
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    settings: Mapped[dict[str, object]] = mapped_column(JSONB, server_default="{}", nullable=False)
    status: Mapped[str] = mapped_column(Text, server_default="active", nullable=False)
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _pk()
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(Text)
    password_hash: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)  # invited|active|disabled
    role: Mapped[str] = mapped_column(Text, nullable=False)  # owner|admin|member
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)


class ProjectMembership(Base):
    __tablename__ = "project_memberships"
    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    project_id: Mapped[uuid.UUID] = _project_fk()
    role: Mapped[str] = mapped_column(Text, nullable=False)  # project-admin|member|viewer
    allowed_topics: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    can_curate: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    status: Mapped[str] = mapped_column(Text, server_default="active", nullable=False)
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    __table_args__ = (UniqueConstraint("user_id", "project_id"),)


class PersonalAccessToken(Base):
    __tablename__ = "personal_access_tokens"
    id: Mapped[uuid.UUID] = _pk()
    # Exactly one principal: a human membership OR a service agent (SPEC-04).
    membership_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("project_memberships.id", ondelete="CASCADE")
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, server_default="active", nullable=False)
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    __table_args__ = (
        CheckConstraint(
            "(membership_id IS NOT NULL) <> (agent_id IS NOT NULL)",
            name="exactly_one_principal",
        ),
    )


class OAuthClient(Base):
    __tablename__ = "oauth_clients"
    id: Mapped[uuid.UUID] = _pk()
    client_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    client_metadata: Mapped[dict[str, object]] = mapped_column(JSONB, server_default="{}")
    created_at: Mapped[dt.datetime] = _created_at()


class OAuthToken(Base):
    __tablename__ = "oauth_tokens"
    id: Mapped[uuid.UUID] = _pk()
    membership_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("project_memberships.id", ondelete="CASCADE")
    )
    client_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("oauth_clients.id", ondelete="CASCADE"))
    access_token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    refresh_token_hash: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class OAuthAuthorizationCode(Base):
    """A short-lived OAuth 2.1 authorization code (SPEC-10). Issued at the consent screen, bound to
    a client + membership (the chosen user+project) + PKCE challenge, single-use at the token
    endpoint. The code itself is only stored hashed."""

    __tablename__ = "oauth_authorization_codes"
    id: Mapped[uuid.UUID] = _pk()
    code_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    client_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("oauth_clients.id", ondelete="CASCADE"))
    membership_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("project_memberships.id", ondelete="CASCADE")
    )
    redirect_uri: Mapped[str | None] = mapped_column(Text)
    scope: Mapped[str | None] = mapped_column(Text)
    code_challenge: Mapped[str | None] = mapped_column(Text)
    code_challenge_method: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    kind: Mapped[str] = mapped_column(Text, server_default="invitation", nullable=False)


class ConsoleSession(Base):
    """A console login session on the single D11 identity (SPEC-07). Resolved on every request
    like a PAT, so a disabled user or a logout stops resolving in <5s (FR-4.12). User-scoped
    (spans the user's projects), unlike a project-scoped PAT."""

    __tablename__ = "console_sessions"
    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class Agent(Base):
    """A service account (FR-14.1): a non-human principal owned by a user, scoped to one
    project, authenticating with its own service PAT."""

    __tablename__ = "agents"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    allowed_topics: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    status: Mapped[str] = mapped_column(Text, server_default="active", nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (Index("ix_agents_project_id_id", "project_id", "id"),)


# --------------------------------------------------------------------------- #
# Knowledge & operation (all project-scoped: project_id NOT NULL + composite index)
# --------------------------------------------------------------------------- #


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)  # folder|api|connector
    default_tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    policy: Mapped[str] = mapped_column(Text, nullable=False)  # manual|source_tags|llm|llm_review
    review_if_sensitive: Mapped[bool] = mapped_column(Boolean, server_default="true")
    curators: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), server_default="{}")
    __table_args__ = (
        UniqueConstraint("project_id", "id"),
        Index("ix_sources_project_id_id", "project_id", "id"),
    )


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    logical_id: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    checksum: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    path: Mapped[str | None] = mapped_column(Text)
    pages: Mapped[int | None] = mapped_column(Integer)
    lang: Mapped[str | None] = mapped_column(Text)
    ingested_at: Mapped[dt.datetime] = _created_at()
    status: Mapped[str] = mapped_column(Text, nullable=False)  # received|parsed|...|rejected
    doc_tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    reject_reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("project_id", "checksum", name="uq_documents_project_id_checksum"),
        # R30: version was allocated with `max+1` read outside the insert, so two revisions of one
        # logical document both claimed the same number. The constraint turns that into a conflict the
        # admitting statement retries, instead of a silent duplicate that stops ordering anything.
        UniqueConstraint(
            "project_id", "logical_id", "version", name="uq_documents_project_logical_version"
        ),
        UniqueConstraint("project_id", "id"),  # referenced by every child, project-qualified (R17)
        Index("ix_documents_project_id_id", "project_id", "id"),
        _tenant_fk("source_id", "sources", ondelete="SET NULL"),
    )


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # Stable position inside one document version. UUID order cannot align repeated chunk text
    # across revisions; the ordinal preserves order and multiplicity (AUDIT-014).
    ordinal: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    page: Mapped[int | None] = mapped_column(Integer)
    bbox: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    kind: Mapped[str] = mapped_column(Text, nullable=False)  # prose|table_row
    cut_type: Mapped[str | None] = mapped_column(
        Text
    )  # heading|paragraph|sentence|table_row (SPEC-05)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))
    extraction_confidence: Mapped[float | None] = mapped_column(Numeric)
    # A table with no clear header is retained (auditable) but never embedded/extracted, so it
    # can never surface in vector or graph results (FR-1.5, SPEC-05).
    needs_review: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "id"),
        UniqueConstraint(
            "project_id", "document_id", "ordinal", name="uq_chunks_project_document_ordinal"
        ),
        Index("ix_chunks_project_id_document_id", "project_id", "document_id"),
        _tenant_fk("document_id", "documents"),
    )


class Claim(Base):
    __tablename__ = "claims"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    chunk_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[str | None] = mapped_column(Text)
    predicate: Mapped[str | None] = mapped_column(Text)
    object: Mapped[str | None] = mapped_column(Text)
    # The DETERMINISTIC identity of each endpoint — `entity_id(type, name)`, the same value the
    # graph node carries (AUDIT-035 / R16). A name alone is not an identity: two entities can share
    # a normalized name and differ by type, and a claim about one must never authorize the other.
    # NULL when the endpoint could not be resolved to a typed entity.
    subject_entity_key: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    object_entity_key: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    credibility: Mapped[float] = mapped_column(Numeric, server_default="0.5", nullable=False)
    valid_from: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    valid_to: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    importance: Mapped[float | None] = mapped_column(Numeric)
    extraction_confidence: Mapped[float | None] = mapped_column(Numeric)
    source_document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))
    # Living-graph state (SPEC-08). A superseded claim keeps valid_to set (not deleted);
    # disputed = an unresolved contradiction; pending_confirmation = awaiting a second owner
    # (sensitive correction) and invisible to recall; hunting_candidate = flagged for SPEC-15.
    disputed: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    pending_confirmation: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    hunting_candidate: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "id"),
        Index("ix_claims_project_id_chunk_id", "project_id", "chunk_id"),
        Index("ix_claims_project_id_subject_entity_key", "project_id", "subject_entity_key"),
        Index("ix_claims_project_id_object_entity_key", "project_id", "object_entity_key"),
        _tenant_fk("chunk_id", "chunks"),
    )


class ClaimOccurrence(Base):
    """A claim's concrete provenance in a document-version chunk (AUDIT-014).

    Claim identity is canonical and can survive a revision. Occurrences are version-specific and
    preserve every place that identity was asserted, including repeated chunk text.
    """

    __tablename__ = "claim_occurrences"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    claim_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    chunk_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "claim_id",
            "document_id",
            "chunk_id",
            name="uq_claim_occurrence_claim_doc_chunk",
        ),
        Index("ix_claim_occurrences_project_document", "project_id", "document_id"),
        Index("ix_claim_occurrences_project_claim", "project_id", "claim_id"),
        _tenant_fk("claim_id", "claims"),
        _tenant_fk("document_id", "documents"),
        _tenant_fk("chunk_id", "chunks"),
    )


class ClaimSupersession(Base):
    """Unambiguous version lineage, always directed previous claim → replacement."""

    __tablename__ = "claim_supersessions"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    previous_claim_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    replacement_claim_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        CheckConstraint("previous_claim_id <> replacement_claim_id", name="distinct_claims"),
        UniqueConstraint("project_id", "previous_claim_id", name="uq_claim_supersession_previous"),
        Index("ix_claim_supersessions_project_replacement", "project_id", "replacement_claim_id"),
        _tenant_fk(
            "previous_claim_id",
            "claims",
            name="fk_claim_supersessions_project_previous_claim",
        ),
        _tenant_fk(
            "replacement_claim_id",
            "claims",
            name="fk_claim_supersessions_project_replacement_claim",
        ),
    )


class Entity(Base):
    __tablename__ = "entities"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # Alias-merge (SPEC-09): a merged duplicate points at its canonical entity instead of being
    # deleted (reversible, FR-5.5 spirit). NULL = a live/canonical entity.
    merged_into: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Optional ontology anchor (SPEC-24, off by default; open-world — NULL = local/unanchored).
    ontology_uri: Mapped[str | None] = mapped_column(Text)
    ontology_valid: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "normalized_name", "type"),
        UniqueConstraint("project_id", "id"),
        UniqueConstraint(
            "project_id",
            "type",
            "id",
            name="uq_entities_project_type_id",
        ),
        CheckConstraint(
            "merged_into IS NULL OR merged_into <> id",
            name="merged_into_not_self",
        ),
        Index("ix_entities_project_id_id", "project_id", "id"),
        ForeignKeyConstraint(
            ["project_id", "type", "merged_into"],
            ["entities.project_id", "entities.type", "entities.id"],
            name="fk_entities_project_type_merged_into_entities",
            ondelete="SET NULL (merged_into)",
        ),
    )


class Ontology(Base):
    """A versioned OWL/RDF/SKOS file anchored to a project (SPEC-24, FR-17.1)."""

    __tablename__ = "ontologies"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    format: Mapped[str] = mapped_column(Text, nullable=False)  # owl|rdf|skos|turtle
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    uri_base: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, server_default="true", nullable=False)
    uploaded_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (Index("ix_ontologies_project_id_id", "project_id", "id"),)


class EntityAlias(Base):
    __tablename__ = "entity_aliases"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    alias: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    approved: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (
        Index("ix_entity_aliases_project_id_entity_id", "project_id", "entity_id"),
        _tenant_fk("entity_id", "entities"),
    )


class Topic(Base):
    __tablename__ = "topics"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sensitivity: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    # Per-topic hard horizon (SPEC-13, FR-16.3): in `current` mode, claims older than this many
    # days are hidden by default; NULL = no window (the D16 default).
    hard_window_days: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, server_default="active", nullable=False)
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "slug"),
        Index("ix_topics_project_id_id", "project_id", "id"),
    )


class Person(Base):
    __tablename__ = "persons"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    channels: Mapped[dict[str, object]] = mapped_column(JSONB, server_default="{}")
    topics: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    # Hunting directory (SPEC-15, FR-6.1): quiet_hours {tz, start, end} + preferred language.
    quiet_hours: Mapped[dict[str, object]] = mapped_column(JSONB, server_default="{}")
    language: Mapped[str | None] = mapped_column(Text)
    # Optimistic-concurrency token for console edits/deletes.  A server-owned integer keeps the
    # contract stable across processes and avoids exposing PostgreSQL's transaction-local ``xmin``.
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "id"),
        Index("ix_persons_project_id_id", "project_id", "id"),
    )


class Gap(Base):
    __tablename__ = "gaps"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    query_hash: Mapped[str] = mapped_column(Text, nullable=False)
    query_text: Mapped[str | None] = mapped_column(Text)
    topics: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    count: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    last_seen_at: Mapped[dt.datetime] = _created_at()
    # Unique per (project, query_hash) so gap registration is an atomic upsert (SPEC-06, FR-3.3).
    __table_args__ = (
        UniqueConstraint("project_id", "query_hash"),
        UniqueConstraint("project_id", "id"),
    )


class Hunt(Base):
    __tablename__ = "hunts"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    gap_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    person_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    channel: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    question: Mapped[str | None] = mapped_column(Text)
    # Immutable authorization snapshot.  Manual hunts do not have a Gap from which their topic
    # boundary can be recovered, so persisting it is what prevents a later directory edit from
    # widening the hunt to the whole project.  Legacy rows migrate to the restrictive empty set.
    topics: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}", nullable=False)
    answer: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # Lifecycle (SPEC-15): type, the one-time magic-link token hash, retry count, per-transition
    # timestamps, the escalation deadline, the reviewed correction, and the resulting claim.
    hunt_type: Mapped[str] = mapped_column(Text, server_default="GAP", nullable=False)
    magic_token_hash: Mapped[str | None] = mapped_column(Text)
    retries: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    correction_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    consent_requested_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    asked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    answered_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    claim_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    __table_args__ = (
        Index("ix_hunts_project_id_state", "project_id", "state"),
        _tenant_fk("gap_id", "gaps", ondelete="SET NULL"),
        _tenant_fk("person_id", "persons", ondelete="SET NULL"),
    )


class Skill(Base):
    __tablename__ = "skills"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    when_to_use: Mapped[str | None] = mapped_column(Text)
    when_not: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    state: Mapped[str] = mapped_column(Text, nullable=False)  # proposed|active|archived
    owner_person_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    # SPEC-20: the markdown instructions, the entity/topic ids the skill's context is built from
    # (graph-sync key), and the stale marker set when that subgraph changes (FR-7.1/7.2).
    body: Mapped[str | None] = mapped_column(Text)
    depends_on: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), server_default="{}")
    stale: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    stale_reason: Mapped[str | None] = mapped_column(Text)
    stale_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("project_id", "slug"),
        Index("ix_skills_project_id_id", "project_id", "id"),
        _tenant_fk("owner_person_id", "persons", ondelete="SET NULL"),
    )


class TokenUsage(Base):
    """Per-project, per-capability, per-day token + call counters (SPEC-22 FR-9.5, AUDIT-021 R12).

    ``project_id`` is what makes an attempt attributable and a budget independent. It is nullable
    only because rows written before the counter was project-bound cannot be attributed after the
    fact: those legacy rows appear in no project's report and are never reassigned.
    """

    __tablename__ = "token_usage"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    capability: Mapped[str] = mapped_column(Text, nullable=False)
    day: Mapped[dt.date] = mapped_column(Date, nullable=False)
    tokens: Mapped[int] = mapped_column(BigInteger, server_default="0", nullable=False)
    calls: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    __table_args__ = (
        # NULLS NOT DISTINCT: an unattributed row is still ONE counter per capability/day. With the
        # default, two unattributed attempts would insert two rows, the upsert would never fire, and
        # the counter would silently under-report.
        UniqueConstraint("project_id", "capability", "day", postgresql_nulls_not_distinct=True),
        Index("ix_token_usage_project_id_day", "project_id", "day"),
    )


class EmbeddingCache(Base):
    """Cached embedding, private to one project (SPEC-22 FR-9.6 + AUDIT-022).

    The project dimension is the whole point. Keyed by text digest alone, this table was a cross-tenant
    confirmation oracle — and not through timing but through the asking tenant's own usage counter: a
    string another project had embedded cost nothing, a new one cost a provider call, so a project could
    confirm another's exact content by reading its own bill. It also made erasure undecidable, because no
    entry was attributable to anyone: keeping them retained derived private data, deleting by digest
    removed another tenant's live data.

    Reuse — what FR-9.6 asked for — still happens within a project, which is where text actually repeats:
    re-ingests, document versions, one corpus's boilerplate.
    """

    __tablename__ = "embedding_cache"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    text_hash: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    dimension: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "text_hash",
            "model",
            "dimension",
            name="uq_embedding_cache_project_text_model_dim",
        ),
    )


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # Audit evidence deliberately survives a hard project delete. The UUID remains mandatory and
    # indexed, but is historical attribution rather than a live parent reference.
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    ts: Mapped[dt.datetime] = _created_at()
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Agent principals (FR-14.3), consumed by SPEC-04 from v0.1.
    principal_type: Mapped[str | None] = mapped_column(Text)  # human|agent
    principal_id: Mapped[str | None] = mapped_column(Text)
    on_behalf_of: Mapped[str | None] = mapped_column(Text)
    trace_id: Mapped[str | None] = mapped_column(Text)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    tool: Mapped[str | None] = mapped_column(Text)
    query_hash: Mapped[str | None] = mapped_column(Text)
    # The raw query text, stored ONLY when the project's query_text_logging is ON (FR-13.9); NULL
    # otherwise. duration_ms feeds the p95 latency dashboard (FR-13.2).
    query_text: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    topics_used: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    result_count: Mapped[int | None] = mapped_column(Integer)
    denied: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (Index("ix_audit_log_project_id_ts", "project_id", "ts"),)


class IngestError(Base):
    __tablename__ = "ingest_errors"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    chunk_ref: Mapped[str | None] = mapped_column(Text)
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        Index("ix_ingest_errors_project_id_document_id", "project_id", "document_id"),
        _tenant_fk("document_id", "documents"),
    )


class IngestRun(Base):
    """Per-document ingestion run with stage checkpoints (FR-1.10, SPEC-05).

    ``completed_stages`` is appended to *in the same transaction* as each stage's writes, so a
    worker that crashes mid-run resumes from the last checkpoint without re-doing completed work
    or leaving the stores inconsistent (NFR-4). One run per document (re-ingest of the same
    checksum is a registered no-op; a new version gets a new run in SPEC-09)."""

    __tablename__ = "ingest_runs"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    phase: Mapped[str] = mapped_column(Text, nullable=False)  # mirrors documents.status
    completed_stages: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default="{}", nullable=False
    )
    chunks_created: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    claims_generated: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    tables_converted: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    tables_needs_review: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    discarded_chunks: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    # Durable, retry-stable publication material. Cleared only by the transaction that checkpoints
    # PERSIST, so a crash never requires another model call or another UUID allocation.
    publish_draft: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint("document_id"),
        Index("ix_ingest_runs_project_id_id", "project_id", "id"),
        _tenant_fk("document_id", "documents"),
    )


# --------------------------------------------------------------------------- #
# Living graph (SPEC-08): credibility, contradictions, corrections
# --------------------------------------------------------------------------- #


class ClaimPairVerdict(Base):
    """Cached contradiction verdict for an ordered claim pair (FR-5.2). Keyed by
    (project_id, claim_a, claim_b, judge_version) so a judge change invalidates the cache."""

    __tablename__ = "claim_pair_verdicts"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    claim_a: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    claim_b: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    judge_version: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)  # agree|contradict|unrelated
    confidence: Mapped[float] = mapped_column(Numeric, server_default="0.5", nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint("project_id", "claim_a", "claim_b", "judge_version"),
        Index("ix_claim_pair_verdicts_project_id_id", "project_id", "id"),
        _tenant_fk("claim_a", "claims"),
        _tenant_fk("claim_b", "claims"),
    )


class Correction(Base):
    """A Learning-Layer correction (FR-15.7, DDL §3.8). Auditable + reversible."""

    __tablename__ = "corrections"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    target_claim: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    new_claim: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    on_behalf_of: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    role_applied: Mapped[str | None] = mapped_column(Text)  # owner_direct|second_owner|reverted
    status: Mapped[str] = mapped_column(Text, nullable=False)  # applied|pending_confirmation|...
    before_text: Mapped[str | None] = mapped_column(Text)
    after_text: Mapped[str | None] = mapped_column(Text)
    hunt_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        Index("ix_corrections_project_id_id", "project_id", "id"),
        _tenant_fk("target_claim", "claims"),
    )


class ErasureTombstone(Base):
    """A name this project has erased (AUDIT-023 / R43).

    Erasure never auto-revives: without this row the next document naming the same person recreates the
    entity as if nothing had happened, with no decision and no audit. ``retired_at`` records the
    explicit owner authorization that allows the name back, so the history of both decisions survives.
    """

    __tablename__ = "erasure_tombstones"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    normalized_name: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str | None] = mapped_column(Text)
    erased_at: Mapped[dt.datetime] = _created_at()
    erased_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    retired_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        Index("ix_erasure_tombstones_project_id_normalized_name", "project_id", "normalized_name"),
    )


class FeedbackDailyImpact(Base):
    """Consumed feedback budget per (principal, claim, day) — the cap that stops agent spam
    from moving a claim more than the daily limit (FR-5.4/14.5)."""

    __tablename__ = "feedback_daily_impact"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    principal_id: Mapped[str] = mapped_column(Text, nullable=False)
    claim_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    day: Mapped[dt.date] = mapped_column(Date, nullable=False)
    impact: Mapped[float] = mapped_column(Numeric, server_default="0", nullable=False)
    # R33: the value `impact` held before the statement that last changed it. `RETURNING` reports the
    # NEW row only, so this is how a single upsert can tell the caller how much of its request was
    # actually granted — computing that from a separate SELECT is the race the cap exists to prevent.
    prev_impact: Mapped[float] = mapped_column(Numeric, server_default="0", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "principal_id", "claim_id", "day"),
        Index("ix_feedback_daily_impact_project_id_id", "project_id", "id"),
        _tenant_fk("claim_id", "claims"),
    )


class EntityMergeProposal(Base):
    """A proposed alias-merge of a duplicate entity into a canonical one (SPEC-09, FR-1.9 P1).

    High-confidence proposals are ``auto_applied``; low-confidence ones wait as ``needs_review``
    for an owner to ``confirm`` (→ ``applied``) or ``reject``. Never crosses project (FR-12.4)."""

    __tablename__ = "entity_merge_proposals"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    canonical_entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    duplicate_entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    confidence: Mapped[float] = mapped_column(Numeric, server_default="0.5", nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)  # deterministic|llm
    # needs_review|applied|auto_applied|rejected — the vocabulary lives in `rsc_brain.review.states`
    # and is enforced by the CHECK below (R25: three spellings of this had drifted apart).
    status: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint(
            "status IN ('needs_review', 'applied', 'auto_applied', 'rejected')",
            name="ck_entity_merge_proposals_status",
        ),
        CheckConstraint(
            "canonical_entity_id <> duplicate_entity_id",
            name="distinct_entities",
        ),
        UniqueConstraint("project_id", "id"),
        UniqueConstraint(
            "project_id",
            "canonical_entity_id",
            "duplicate_entity_id",
            # Explicit: the generated name would be 76 characters, over Postgres's 63-char limit,
            # and would be truncated silently — drifting from the name the migration deployed.
            name="uq_entity_merge_proposals_project_canonical_duplicate",
        ),
        Index("ix_entity_merge_proposals_project_id_id", "project_id", "id"),
        Index("ix_entity_merge_proposals_project_id_status", "project_id", "status"),
        _tenant_fk(
            "canonical_entity_id",
            "entities",
            name="fk_entity_merge_proposals_project_canonical_entities",
        ),
        _tenant_fk(
            "duplicate_entity_id",
            "entities",
            name="fk_entity_merge_proposals_project_duplicate_entities",
        ),
    )


class EntityMergeSnapshot(Base):
    """Exact reversible state for one applied merge cycle (AUDIT-012).

    A proposal may be applied again after reversal, so history is append-only and only the active
    (not-yet-reversed) cycle is unique. JSONB captures data-shaped AGE properties without coupling
    the relational schema to every graph predicate/property added by later specs.
    """

    __tablename__ = "entity_merge_snapshots"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    proposal_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    canonical_entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    duplicate_entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    canonical_graph_node_id: Mapped[str] = mapped_column(Text, nullable=False)
    duplicate_graph_node_id: Mapped[str] = mapped_column(Text, nullable=False)
    previous_proposal_status: Mapped[str] = mapped_column(Text, nullable=False)
    aliases_before: Mapped[list[dict[str, object]]] = mapped_column(JSONB, nullable=False)
    aliases_after: Mapped[list[dict[str, object]]] = mapped_column(JSONB, nullable=False)
    graph_before: Mapped[list[dict[str, object]]] = mapped_column(JSONB, nullable=False)
    graph_after: Mapped[list[dict[str, object]]] = mapped_column(JSONB, nullable=False)
    duplicate_node_before: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    duplicate_node_after: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    snapshot_version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    applied_at: Mapped[dt.datetime] = _created_at()
    reversed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint(
            "canonical_entity_id <> duplicate_entity_id",
            name="distinct_entities",
        ),
        CheckConstraint(
            "previous_proposal_status = 'needs_review'",
            name="previous_status",
        ),
        CheckConstraint(
            "snapshot_version = 1",
            name="version",
        ),
        CheckConstraint(
            "(reversed_at IS NULL AND reversed_by IS NULL) OR "
            "(reversed_at IS NOT NULL AND reversed_by IS NOT NULL)",
            name="reversal_pair",
        ),
        Index("ix_entity_merge_snapshots_project_id_id", "project_id", "id"),
        Index(
            "uq_entity_merge_snapshots_active_proposal",
            "project_id",
            "proposal_id",
            unique=True,
            postgresql_where=sql_text("reversed_at IS NULL"),
        ),
        _tenant_fk(
            "proposal_id",
            "entity_merge_proposals",
            name="fk_merge_snapshots_project_proposal",
        ),
        _tenant_fk(
            "canonical_entity_id",
            "entities",
            name="fk_merge_snapshots_project_canonical",
        ),
        _tenant_fk(
            "duplicate_entity_id",
            "entities",
            name="fk_merge_snapshots_project_duplicate",
        ),
    )


class AgentWriteIdempotency(Base):
    """Idempotency ledger for ``submit_knowledge`` (SPEC-11, FR-14.4): a retry with the same
    ``(project, principal, idempotency_key)`` returns the original claim ids, never duplicates."""

    __tablename__ = "agent_write_idempotency"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    principal_id: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    claim_ids: Mapped[list[str]] = mapped_column(JSONB, server_default="[]", nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)  # quarantined|active|rejected
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "principal_id",
            "idempotency_key",
            name="uq_agent_write_idempotency_project_principal_key",  # generated name is 66 chars
        ),
    )


class ManagementCommand(Base):
    """Durable, secret-free result of one console management command.

    The ledger is deliberately not tenant-FK constrained: project deletion must retain both the
    command result and its audit correlation. ``project_id`` is still mandatory and indexed so
    every replay remains attributable to the scope in which it happened.
    """

    __tablename__ = "management_commands"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    principal_id: Mapped[str] = mapped_column(Text, nullable=False)
    operation: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    audit_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, server_default="completed", nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint(
            "principal_id",
            "operation",
            "idempotency_key",
            name="uq_management_commands_principal_operation_key",
        ),
        Index("ix_management_commands_project_id_created", "project_id", "created_at"),
    )


class PrincipalDailyUsage(Base):
    """Per-principal daily recall/write counters (SPEC-11, FR-14.7) — the daily budget ledger +
    the data FR-13.7 surfaces later (SPEC-26)."""

    __tablename__ = "principal_daily_usage"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    principal_id: Mapped[str] = mapped_column(Text, nullable=False)
    day: Mapped[dt.date] = mapped_column(Date, nullable=False)
    recalls: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    writes: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    __table_args__ = (UniqueConstraint("project_id", "principal_id", "day"),)


class LoginAttemptWindow(Base):
    """Failed-login budget per source network and per account, shared across replicas (R09).

    Not per process: the deployment runs several API replicas behind one proxy, so an in-memory limit
    is silently divided by however many replicas an attacker's requests land on. Postgres is the shared
    state every replica already has.

    ``budget_key`` carries its dimension as a prefix (``network:``/``account:``) so one atomic
    statement can charge either budget.
    """

    __tablename__ = "login_attempt_window"
    id: Mapped[uuid.UUID] = _pk()
    budget_key: Mapped[str] = mapped_column(Text, nullable=False)
    window_start: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    __table_args__ = (
        UniqueConstraint("budget_key", "window_start", name="uq_login_attempt_window_key_start"),
        Index("ix_login_attempt_window_window_start", "window_start"),
    )


class PrincipalRateWindow(Base):
    """Sliding per-minute request counter per principal (SPEC-11, FR-14.7), shared across workers
    via Postgres — no Redis. One row per (principal, minute-truncated window)."""

    __tablename__ = "principal_rate_window"
    id: Mapped[uuid.UUID] = _pk()
    principal_id: Mapped[str] = mapped_column(Text, nullable=False)
    window_start: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    __table_args__ = (UniqueConstraint("principal_id", "window_start"),)
