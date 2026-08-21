"""Pydantic schemas for the eval content (SPEC-02, PRD §12.1)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Verdict = Literal["agree", "contradict", "unrelated"]
# The six required golden families plus the AUDIT-008 injection family.
GoldenFamily = Literal[
    "hit", "abstain", "denied", "cross_project", "exact_id", "temporal", "injection"
]
DocKind = Literal["prose", "table", "scanned"]
D13Policy = Literal["manual", "source_tags", "llm", "llm_review"]
ArtifactKind = Literal["prompt", "template"]
SemanticReviewKind = Literal["human", "assisted"]


class Topic(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str
    name_en: str
    name_es: str
    sensitivity: int = Field(ge=0)


class ProjectTaxonomy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    topics: list[Topic]


class Taxonomy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projects: dict[str, ProjectTaxonomy]


class Document(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    project: str
    source: str
    policy: D13Policy
    tags: list[str]
    kind: DocKind
    lang: Literal["en", "es"]
    body: str
    retained: bool = False  # true if it must stay non-recallable until approved (D13)
    valid_from: str | None = None  # ISO date for temporal (FR-16.9) fact-with-history cases


class Corpus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    documents: list[Document]


class GoldenCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    family: GoldenFamily
    question: str
    user: str
    project: str
    must_find: bool
    expected: str | None = None


class Golden(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cases: list[GoldenCase]


class ContradictionPair(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    a: str
    b: str
    verdict: Verdict
    lang_a: Literal["en", "es"]
    lang_b: Literal["en", "es"]


class Contradictions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pairs: list[ContradictionPair]


class FoundationalArtifact(BaseModel):
    """One versioned prompt or hunting template at its sole canonical path."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    path: str
    id: str
    version: str
    kind: ArtifactKind
    role: str
    language: Literal["en", "es"] | None = None
    foundational: bool
    owner: str


class FoundationalManifest(BaseModel):
    """Complete prompt/template inventory, including later non-foundational additions."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal[1]
    artifacts: tuple[FoundationalArtifact, ...]


class FoundationalQualityCase(BaseModel):
    """Explicit semantic expectations for one live-model corpus sample."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    document_id: str
    required_tags: tuple[str, ...]
    required_graph_terms: tuple[str, ...]
    forbidden_graph_terms: tuple[str, ...] = ()


class FoundationalQuality(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal[1]
    cases: tuple[FoundationalQualityCase, ...]


class FoundationalCaseResult(BaseModel):
    """Auditable output and expectation deltas for one sampled document."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    case_id: str
    document_id: str
    extraction_attempted: bool
    discarded: bool
    discard_stage: str | None = None
    tags: tuple[str, ...]
    graph_terms: tuple[str, ...]
    missing_tags: tuple[str, ...]
    missing_graph_terms: tuple[str, ...]
    forbidden_graph_terms_present: tuple[str, ...]
    passed: bool


class FoundationalEvidence(BaseModel):
    """Fingerprint-bound evidence for SPEC-02's live model quality gate."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal[1]
    run_at: datetime
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    model_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    content_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt_versions: dict[str, str]
    sample_size: int = Field(ge=1)
    extraction_attempts: int = Field(ge=1)
    extraction_discards: int = Field(ge=0)
    discard_rate: float = Field(ge=0.0, le=1.0)
    quality_cases_passed: int = Field(ge=0)
    quality_cases_total: int = Field(ge=1)
    semantic_review: SemanticReviewKind
    semantic_reviewed: bool
    results: tuple[FoundationalCaseResult, ...]


class FoundationalStatus(BaseModel):
    """Keep a structural green distinct from an overall SPEC-02 completion."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    structure_passed: bool
    live_evidence_passed: bool
    overall_complete: bool
    structure_errors: tuple[str, ...]
    live_evidence_errors: tuple[str, ...]
    summary: str
