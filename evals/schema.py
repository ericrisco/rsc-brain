"""Pydantic schemas for the eval content (SPEC-02, PRD §12.1)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Verdict = Literal["agree", "contradict", "unrelated"]
# The six required golden families plus the AUDIT-008 injection family.
GoldenFamily = Literal[
    "hit", "abstain", "denied", "cross_project", "exact_id", "temporal", "injection"
]
DocKind = Literal["prose", "table", "scanned"]
D13Policy = Literal["manual", "source_tags", "llm", "llm_review"]


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
