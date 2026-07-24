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
    ForeignKey,
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


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _pk()
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(Text)
    password_hash: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)  # invited|active|disabled
    role: Mapped[str] = mapped_column(Text, nullable=False)  # owner|admin|member


class ProjectMembership(Base):
    __tablename__ = "project_memberships"
    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    project_id: Mapped[uuid.UUID] = _project_fk()
    role: Mapped[str] = mapped_column(Text, nullable=False)  # project-admin|member|viewer
    allowed_topics: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    can_curate: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
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


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


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
    __table_args__ = (Index("ix_sources_project_id_id", "project_id", "id"),)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sources.id", ondelete="SET NULL")
    )
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
        UniqueConstraint("project_id", "checksum"),
        Index("ix_documents_project_id_id", "project_id", "id"),
    )


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
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
    __table_args__ = (Index("ix_chunks_project_id_document_id", "project_id", "document_id"),)


class Claim(Base):
    __tablename__ = "claims"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    chunk_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("chunks.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[str | None] = mapped_column(Text)
    predicate: Mapped[str | None] = mapped_column(Text)
    object: Mapped[str | None] = mapped_column(Text)
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
    __table_args__ = (Index("ix_claims_project_id_chunk_id", "project_id", "chunk_id"),)


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
    merged_into: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("entities.id", ondelete="SET NULL")
    )
    __table_args__ = (
        UniqueConstraint("project_id", "normalized_name", "type"),
        Index("ix_entities_project_id_id", "project_id", "id"),
    )


class EntityAlias(Base):
    __tablename__ = "entity_aliases"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    entity_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"))
    alias: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    approved: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (Index("ix_entity_aliases_project_id_entity_id", "project_id", "entity_id"),)


class Topic(Base):
    __tablename__ = "topics"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sensitivity: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
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
    __table_args__ = (Index("ix_persons_project_id_id", "project_id", "id"),)


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
    __table_args__ = (UniqueConstraint("project_id", "query_hash"),)


class Hunt(Base):
    __tablename__ = "hunts"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    gap_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("gaps.id", ondelete="SET NULL"))
    person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("persons.id", ondelete="SET NULL")
    )
    channel: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    question: Mapped[str | None] = mapped_column(Text)
    answer: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (Index("ix_hunts_project_id_state", "project_id", "state"),)


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
    owner_person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("persons.id", ondelete="SET NULL")
    )
    version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "slug"),
        Index("ix_skills_project_id_id", "project_id", "id"),
    )


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    project_id: Mapped[uuid.UUID] = _project_fk()
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
    topics_used: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    result_count: Mapped[int | None] = mapped_column(Integer)
    denied: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    __table_args__ = (Index("ix_audit_log_project_id_ts", "project_id", "ts"),)


class IngestError(Base):
    __tablename__ = "ingest_errors"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE")
    )
    chunk_ref: Mapped[str | None] = mapped_column(Text)
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        Index("ix_ingest_errors_project_id_document_id", "project_id", "document_id"),
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
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    phase: Mapped[str] = mapped_column(Text, nullable=False)  # mirrors documents.status
    completed_stages: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default="{}", nullable=False
    )
    chunks_created: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    claims_generated: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    tables_converted: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    tables_needs_review: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    discarded_chunks: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint("document_id"),
        Index("ix_ingest_runs_project_id_id", "project_id", "id"),
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
    claim_a: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("claims.id", ondelete="CASCADE"), nullable=False
    )
    claim_b: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("claims.id", ondelete="CASCADE"), nullable=False
    )
    judge_version: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)  # agree|contradict|unrelated
    confidence: Mapped[float] = mapped_column(Numeric, server_default="0.5", nullable=False)
    created_at: Mapped[dt.datetime] = _created_at()
    __table_args__ = (
        UniqueConstraint("project_id", "claim_a", "claim_b", "judge_version"),
        Index("ix_claim_pair_verdicts_project_id_id", "project_id", "id"),
    )


class Correction(Base):
    """A Learning-Layer correction (FR-15.7, DDL §3.8). Auditable + reversible."""

    __tablename__ = "corrections"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    target_claim: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("claims.id", ondelete="CASCADE"), nullable=False
    )
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
    __table_args__ = (Index("ix_corrections_project_id_id", "project_id", "id"),)


class FeedbackDailyImpact(Base):
    """Consumed feedback budget per (principal, claim, day) — the cap that stops agent spam
    from moving a claim more than the daily limit (FR-5.4/14.5)."""

    __tablename__ = "feedback_daily_impact"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    principal_id: Mapped[str] = mapped_column(Text, nullable=False)
    claim_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("claims.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[dt.date] = mapped_column(Date, nullable=False)
    impact: Mapped[float] = mapped_column(Numeric, server_default="0", nullable=False)
    __table_args__ = (
        UniqueConstraint("project_id", "principal_id", "claim_id", "day"),
        Index("ix_feedback_daily_impact_project_id_id", "project_id", "id"),
    )


class EntityMergeProposal(Base):
    """A proposed alias-merge of a duplicate entity into a canonical one (SPEC-09, FR-1.9 P1).

    High-confidence proposals are ``auto_applied``; low-confidence ones wait as ``needs_review``
    for an owner to ``confirm`` (→ ``applied``) or ``reject``. Never crosses project (FR-12.4)."""

    __tablename__ = "entity_merge_proposals"
    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = _project_fk()
    canonical_entity_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    duplicate_entity_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    confidence: Mapped[float] = mapped_column(Numeric, server_default="0.5", nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)  # deterministic|llm
    status: Mapped[str] = mapped_column(Text, nullable=False)  # needs_review|auto_applied|...
    reason: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("project_id", "canonical_entity_id", "duplicate_entity_id"),
        Index("ix_entity_merge_proposals_project_id_id", "project_id", "id"),
        Index("ix_entity_merge_proposals_project_id_status", "project_id", "status"),
    )
