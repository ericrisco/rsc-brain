"""Prompt loading + the structured-output schemas the extraction cascade enforces (SPEC-05).

The versioned prompt bodies live in ``src/rsc_brain/prompts/*.v1.md`` (SPEC-02). They are loaded
by id, their YAML frontmatter stripped, and used as the system instruction for each cascade step
and the topicalizer. The gateway's ``complete_structured`` validates the model reply against the
Pydantic schemas below (FR-9.2); anything else is repaired then discarded (FR-1.8).
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"


def _strip_frontmatter(text: str) -> str:
    """Remove a leading ``---`` YAML frontmatter block, returning the instruction body."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            newline = text.find("\n", end + 1)
            return text[newline + 1 :].lstrip("\n") if newline != -1 else ""
    return text


@cache
def load_prompt(prompt_id: str, *, version: str = "v1") -> str:
    """Load a prompt body by id (e.g. ``extractor_entities``), frontmatter removed."""
    path = _PROMPTS_DIR / f"{prompt_id}.{version}.md"
    if not path.is_file():
        raise FileNotFoundError(f"prompt not found: {path.name}")
    return _strip_frontmatter(path.read_text(encoding="utf-8")).strip()


# --------------------------------------------------------------------------- #
# Structured-output schemas (the cascade validates against these — FR-9.2)
# --------------------------------------------------------------------------- #


class EntityOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    type: str
    aliases: list[str] = Field(default_factory=list)


class EntityExtraction(BaseModel):
    """Cascade step 1 output (FR-1.8)."""

    model_config = ConfigDict(extra="forbid")
    entities: list[EntityOut] = Field(default_factory=list)


class RelationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject: str
    predicate: str
    object: str


class RelationExtraction(BaseModel):
    """Cascade step 2 output (FR-1.8)."""

    model_config = ConfigDict(extra="forbid")
    relations: list[RelationOut] = Field(default_factory=list)


class ClaimOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    subject: str | None = None
    predicate: str | None = None
    object: str | None = None


class ClaimExtraction(BaseModel):
    """Cascade step 3 output (FR-1.8)."""

    model_config = ConfigDict(extra="forbid")
    claims: list[ClaimOut] = Field(default_factory=list)


class TopicAssignment(BaseModel):
    """Topicalizer output (FR-1.7): tags chosen from the project taxonomy."""

    model_config = ConfigDict(extra="forbid")
    tags: list[str] = Field(default_factory=list)
