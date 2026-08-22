"""Pydantic schemas for the eval content (SPEC-02, PRD §12.1)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

Verdict = Literal["agree", "contradict", "unrelated"]
# The six required golden families plus the AUDIT-008 injection family.
GoldenFamily = Literal[
    "hit",
    "abstain",
    "denied",
    "cross_project",
    "exact_id",
    "temporal",
    "injection",
    # AUDIT-123: a sibling fact under a different qualifier — same entity, same kind of fact, one
    # word different. AUDIT-122 measured this scoring as high as the passage that answers, so the
    # shape needs cases of its own rather than a note in a prompt.
    "qualifier",
]
DocKind = Literal["prose", "table", "scanned"]
D13Policy = Literal["manual", "source_tags", "llm", "llm_review"]
ArtifactKind = Literal["prompt", "template"]
SemanticReviewKind = Literal["human", "assisted"]
EvalSurface = Literal["recall", "timeline"]


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


class ExpectedValidity(BaseModel):
    """A validity assertion whose explicit null boundaries mean source validity is unknown."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    valid_from: date | None
    valid_to: date | None


class EvidenceExpectation(BaseModel):
    """Assertions that must be satisfied together by one recall fragment or timeline entry."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    must_include: tuple[str, ...] = ()
    document_id: str | None = None
    # ``None`` means no validity assertion; ExpectedValidity(None, None) asserts unknown validity.
    validity: ExpectedValidity | None = None
    expected_is_current: bool | None = None


class GoldenCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    family: GoldenFamily
    question: str
    user: str
    project: str
    must_find: bool
    expected: str | None = None
    must_include: list[str] = Field(default_factory=list)
    must_exclude: list[str] = Field(default_factory=list)
    expected_valid_from: date | None = None
    expected_valid_to: date | None = None
    expected_is_current: bool | None = None
    surface: EvalSurface = "recall"
    expected_evidence: tuple[EvidenceExpectation, ...] = ()


class Golden(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cases: list[GoldenCase]


class RerankCalibrationCase(BaseModel):
    """One case the `tau_rerank` sweep may fit on — and that nothing scores (AUDIT-136).

    Carries no expectation field on purpose. A sweep needs a question, a principal to ask it as, and
    whether an answer exists; anything more invites grading these cases, and a graded calibration case
    is an evaluation case again, which is the overlap this corpus exists to remove.
    """

    model_config = ConfigDict(extra="forbid")
    id: str
    question: str
    user: str
    project: str
    must_find: bool


class RerankCalibration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cases: list[RerankCalibrationCase]


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


InjectionLang = Literal["en", "es", "mixed"]
InjectionDelivery = Literal["prose", "table", "ocr", "metadata", "encoded", "indirect"]


class InjectionRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pattern: str
    tag: str


class _InjectionCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    lang: InjectionLang
    delivery: InjectionDelivery


class TopicalizerInjectionCase(_InjectionCase):
    stage: Literal["topicalizer"]
    content: str
    taxonomy: list[str] = Field(min_length=1)
    floor_tags: list[str] = Field(min_length=1)
    rules: list[InjectionRule] = Field(default_factory=list)
    default_tag: str = "general"
    expected_tags_include: list[str] = Field(min_length=1)
    forbidden_tags: list[str] = Field(default_factory=list)
    expected_review: Literal[True]


class ExtractionInjectionCase(_InjectionCase):
    stage: Literal["extractor"]
    content: str
    expected_terms_include: list[str] = Field(min_length=1)
    forbidden_terms: list[str] = Field(min_length=1)


class JudgeInjectionCase(_InjectionCase):
    stage: Literal["judge"]
    claim_a: str
    claim_b: str
    expected_verdict: Verdict


PromptInjectionCase = Annotated[
    TopicalizerInjectionCase | ExtractionInjectionCase | JudgeInjectionCase,
    Field(discriminator="stage"),
]


class PromptInjectionSuite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cases: list[PromptInjectionCase] = Field(min_length=1)
