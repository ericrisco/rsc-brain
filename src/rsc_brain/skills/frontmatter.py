"""Skill frontmatter — OKF-compatible (SPEC-20, FR-7.4 / D14).

A skill is markdown: a YAML frontmatter block + a body (the instructions). The frontmatter is
**OKF-compatible** (Open Knowledge Format v0.1) — OKF-native fields (``okf_version``, ``kind``,
``title``, ``description``) sit at the top level, and every rsc-brain-specific field lives under the
``rsc_brain_`` namespace (FR-7.4 literal), so an exported skill is a valid OKF entry any agent can
read. The core never depends on OKF: this is a boundary format only.

The exact OKF v0.1 field set is captured here as the repo's versioned reference; validating a live
document against the published OKF JSON-Schema is a network-bound step (blocked-by-resource in CI),
so :func:`validate_okf` enforces the structural contract (envelope + namespacing) deterministically.
"""

from __future__ import annotations

import yaml
from pydantic import BaseModel, ConfigDict

OKF_VERSION = "0.1"
OKF_KIND = "skill"
_NS = "rsc_brain_"
# OKF-native top-level keys a skill document may carry unprefixed.
_OKF_NATIVE = frozenset({"okf_version", "kind", "title", "description"})


class SkillFrontmatterError(ValueError):
    """Raised when a skill's frontmatter is malformed or not OKF-compatible."""


class SkillFrontmatter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str
    title: str
    description: str | None = None
    when_to_use: str | None = None
    when_not: str | None = None
    tags: list[str] = []
    owner: str | None = None  # owner person (name/id) — validated against the directory on write
    depends_on: list[str] = []  # entity/topic ids the context is built from (graph-sync key)
    state: str = "active"  # proposed | active | archived
    version: int = 1

    def to_okf(self) -> dict[str, object]:
        """The OKF-compatible frontmatter mapping (own fields under ``rsc_brain_``)."""
        return {
            "okf_version": OKF_VERSION,
            "kind": OKF_KIND,
            "title": self.title,
            "description": self.description,
            f"{_NS}slug": self.slug,
            f"{_NS}when_to_use": self.when_to_use,
            f"{_NS}when_not": self.when_not,
            f"{_NS}tags": list(self.tags),
            f"{_NS}owner": self.owner,
            f"{_NS}depends_on": list(self.depends_on),
            f"{_NS}state": self.state,
            f"{_NS}version": self.version,
        }

    @classmethod
    def from_okf(cls, data: dict[str, object]) -> SkillFrontmatter:
        try:
            return cls(
                slug=str(data[f"{_NS}slug"]),
                title=str(data["title"]),
                description=_opt_str(data.get("description")),
                when_to_use=_opt_str(data.get(f"{_NS}when_to_use")),
                when_not=_opt_str(data.get(f"{_NS}when_not")),
                tags=[str(t) for t in _seq(data.get(f"{_NS}tags"))],
                owner=_opt_str(data.get(f"{_NS}owner")),
                depends_on=[str(d) for d in _seq(data.get(f"{_NS}depends_on"))],
                state=str(data.get(f"{_NS}state", "active")),
                version=_as_int(data.get(f"{_NS}version", 1)),
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise SkillFrontmatterError(f"invalid skill frontmatter: {exc}") from exc


def _opt_str(value: object) -> str | None:
    return None if value is None else str(value)


def _seq(value: object) -> list[object]:
    return list(value) if isinstance(value, list) else []


def _as_int(value: object) -> int:
    return int(value) if isinstance(value, int | str) else 1


def validate_okf(doc: dict[str, object]) -> None:
    """Enforce OKF v0.1 structural compatibility: the envelope is present and correct, and every
    non-native key is namespaced under ``rsc_brain_`` (FR-7.4). Raises on any violation."""
    if doc.get("okf_version") != OKF_VERSION:
        raise SkillFrontmatterError(f"okf_version must be {OKF_VERSION!r}")
    if doc.get("kind") != OKF_KIND:
        raise SkillFrontmatterError(f"kind must be {OKF_KIND!r}")
    if not isinstance(doc.get("title"), str) or not doc["title"]:
        raise SkillFrontmatterError("title is required")
    for key in doc:
        if key not in _OKF_NATIVE and not key.startswith(_NS):
            raise SkillFrontmatterError(
                f"non-OKF field {key!r} must be under the {_NS!r} namespace"
            )


def parse_skill(text: str) -> tuple[SkillFrontmatter, str]:
    """Split ``---\\nyaml\\n---\\nbody`` into a validated frontmatter + the markdown body."""
    if not text.lstrip().startswith("---"):
        raise SkillFrontmatterError("a skill must begin with a '---' frontmatter block")
    stripped = text.lstrip()
    parts = stripped.split("---", 2)
    if len(parts) < 3:
        raise SkillFrontmatterError("unterminated frontmatter block")
    data = yaml.safe_load(parts[1]) or {}
    if not isinstance(data, dict):
        raise SkillFrontmatterError("frontmatter must be a mapping")
    validate_okf(data)
    return SkillFrontmatter.from_okf(data), parts[2].lstrip("\n")


def serialize_skill(frontmatter: SkillFrontmatter, body: str) -> str:
    """Render a skill back to ``---\\nyaml\\n---\\nbody`` (round-trips :func:`parse_skill`)."""
    yaml_block = yaml.safe_dump(frontmatter.to_okf(), sort_keys=True, allow_unicode=True)
    return f"---\n{yaml_block}---\n{body}"
