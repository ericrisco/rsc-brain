"""Domain value objects for the ingestion pipeline (SPEC-05).

These are pure, frozen dataclasses passed between stages — independent of the DB models and of
any particular parser backend. The parser boundary (:class:`ParsedDocument`) is the seam that
lets the production Docling parser and the deterministic Markdown/eval parser feed the exact
same pipeline (plan §decision 1).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class DocStatus(StrEnum):
    """Document lifecycle (FR-1.14). Nothing publishes to graph/vector before ``APPROVED``."""

    RECEIVED = "received"
    PARSED = "parsed"
    PENDING_APPROVAL = "pending_approval"
    AUTO_APPROVED = "auto_approved"
    APPROVED = "approved"
    PROCESSED = "processed"
    REJECTED = "rejected"


class SourcePolicy(StrEnum):
    """Categorization policy of a source (FR-1.13, D13 — a security decision, not organization)."""

    MANUAL = "manual"
    SOURCE_TAGS = "source_tags"
    LLM = "llm"
    LLM_REVIEW = "llm_review"


class SourceType(StrEnum):
    """Source transport. v0.1 implements ``folder`` and ``api``; connectors are v2."""

    FOLDER = "folder"
    API = "api"
    CONNECTOR = "connector"


class ChunkKind(StrEnum):
    PROSE = "prose"
    TABLE_ROW = "table_row"


class PipelineStage(StrEnum):
    """Checkpointed stages (FR-1.10, §4.1.2). Recorded in ``ingest_runs.completed_stages``.

    PARSE→TABLES→CHUNK→TOPICALIZE compose the *parse phase* (always run, up to a tag proposal);
    EXTRACT→RESOLVE→PERSIST compose the *publish phase* (only after ``APPROVED``)."""

    PARSE = "parse"
    TABLES = "tables"
    CHUNK = "chunk"
    TOPICALIZE = "topicalize"
    EXTRACT = "extract"
    RESOLVE = "resolve"
    PERSIST = "persist"


PARSE_PHASE_STAGES: tuple[PipelineStage, ...] = (
    PipelineStage.PARSE,
    PipelineStage.TABLES,
    PipelineStage.CHUNK,
    PipelineStage.TOPICALIZE,
)
PUBLISH_PHASE_STAGES: tuple[PipelineStage, ...] = (
    PipelineStage.EXTRACT,
    PipelineStage.RESOLVE,
    PipelineStage.PERSIST,
)


@dataclass(frozen=True, slots=True)
class ProseBlock:
    """A prose passage with provenance. ``extraction_confidence`` < 1.0 marks OCR'd text."""

    text: str
    page: int | None = None
    bbox: dict[str, float] | None = None
    heading: str | None = None
    extraction_confidence: float | None = None


@dataclass(frozen=True, slots=True)
class TableBlock:
    """A detected table. An empty ``header`` means no clear header → ``needs_review`` (FR-1.5)."""

    header: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]
    page: int | None = None
    bbox: dict[str, float] | None = None
    caption: str | None = None
    extraction_confidence: float | None = None

    @property
    def has_clear_header(self) -> bool:
        """A header is 'clear' iff it has ≥2 distinct, non-empty column labels (col 0 = subject,
        the rest = predicates) and every row matches its width (documented heuristic, FR-1.5).
        Anything else → ``needs_review`` and never enters the active graph/vector index."""
        if len(self.header) < 2 or any(not h.strip() for h in self.header):
            return False
        if len(set(self.header)) != len(self.header):
            return False
        return bool(self.rows) and all(len(row) == len(self.header) for row in self.rows)


@dataclass(frozen=True, slots=True)
class ParsedDocument:
    """The parser boundary: everything the pipeline needs, backend-independent."""

    title: str | None = None
    lang: str | None = None
    pages: int | None = None
    scanned: bool = False
    prose_blocks: tuple[ProseBlock, ...] = ()
    tables: tuple[TableBlock, ...] = ()


@dataclass(frozen=True, slots=True)
class ProposedChunk:
    """A chunk after parse+chunk+tables, carrying its proposed tags (pre-approval)."""

    kind: ChunkKind
    text: str
    page: int | None = None
    bbox: dict[str, float] | None = None
    cut_type: str | None = None
    extraction_confidence: float | None = None
    tags: tuple[str, ...] = ()
    needs_review: bool = False
    # For table_row chunks: the deterministic claim triples derived from the row (FR-1.5).
    claims: tuple[ClaimTriple, ...] = ()


@dataclass(frozen=True, slots=True)
class ClaimTriple:
    """An atomic claim: natural-language text plus a subject/predicate/object triple."""

    text: str
    subject: str | None = None
    predicate: str | None = None
    object: str | None = None


@dataclass(frozen=True, slots=True)
class ExtractedGraph:
    """The cascade's output for one prose chunk (entities → relations → claims)."""

    entities: tuple[ExtractedEntity, ...] = ()
    relations: tuple[ExtractedRelation, ...] = ()
    claims: tuple[ClaimTriple, ...] = ()


@dataclass(frozen=True, slots=True)
class ExtractedEntity:
    name: str
    type: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ExtractedRelation:
    subject: str
    predicate: str
    object: str


@dataclass(frozen=True, slots=True)
class TopicRule:
    """An admin regex rule that wins over the LLM topicalizer (FR-1.7)."""

    pattern: str
    tag: str


@dataclass(frozen=True, slots=True)
class RunStatus:
    """A queryable snapshot of a document's ingestion run (FR-1.12)."""

    document_id: str
    project_id: str
    phase: str
    completed_stages: tuple[str, ...] = field(default_factory=tuple)
    chunks_created: int = 0
    claims_generated: int = 0
    tables_converted: int = 0
    tables_needs_review: int = 0
    discarded_chunks: int = 0
    error: str | None = None
