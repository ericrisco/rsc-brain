"""Skill frontmatter — Open Knowledge Format v0.1 boundary (SPEC-20 / AUDIT-015).

A skill is markdown: a YAML frontmatter block + a body (the instructions). The frontmatter is
``type`` is the sole property required by the pinned upstream specification. Producer-defined
properties are valid and are preserved for round-tripping. Rsc-brain's own properties remain under
the ``rsc_brain_`` namespace; the historical ``okf_version``/``kind`` envelope is emitted for
backward compatibility but is not mistaken for a normative requirement.
"""

from __future__ import annotations

import math

import yaml
from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator

OKF_VERSION = "0.1"
OKF_KIND = "skill"
_NS = "rsc_brain_"
_OWNED_KEYS = frozenset(
    {
        "type",
        "okf_version",
        "kind",
        "title",
        "description",
        "tags",
        f"{_NS}slug",
        f"{_NS}when_to_use",
        f"{_NS}when_not",
        f"{_NS}tags",
        f"{_NS}owner",
        f"{_NS}depends_on",
        f"{_NS}state",
        f"{_NS}version",
    }
)


class _StringTimestampSafeLoader(yaml.SafeLoader):
    """YAML safe loader that leaves timestamp-looking scalars as authored strings."""


_StringTimestampSafeLoader.yaml_implicit_resolvers = {
    first: [(tag, pattern) for tag, pattern in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class SkillFrontmatterError(ValueError):
    """Raised when a skill's frontmatter is malformed or not OKF-compatible."""


class SkillFrontmatter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concept_type: str = "Skill"
    slug: str
    title: str
    description: str | None = None
    when_to_use: str | None = None
    when_not: str | None = None
    tags: list[str] = Field(default_factory=list)
    owner: str | None = None  # owner person (name/id) — validated against the directory on write
    depends_on: list[str] = Field(default_factory=list)
    state: str = "active"  # proposed | active | archived
    version: int = 1
    extensions: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("concept_type")
    @classmethod
    def _concept_type_is_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("concept_type must be a non-empty string")
        return value

    @field_validator("extensions")
    @classmethod
    def _extensions_do_not_shadow_owned_fields(
        cls, value: dict[str, JsonValue]
    ) -> dict[str, JsonValue]:
        collisions = sorted(_OWNED_KEYS.intersection(value))
        if collisions:
            raise ValueError(f"extensions cannot shadow owned properties: {collisions!r}")
        _validate_json_value(value, path="extensions")
        return value

    def to_okf(self) -> dict[str, object]:
        """The OKF-compatible frontmatter mapping (own fields under ``rsc_brain_``)."""
        document: dict[str, object] = {
            **self.extensions,
            "type": self.concept_type,
            "okf_version": OKF_VERSION,
            "kind": OKF_KIND,
            "title": self.title,
            "tags": list(self.tags),
            f"{_NS}slug": self.slug,
            f"{_NS}when_to_use": self.when_to_use,
            f"{_NS}when_not": self.when_not,
            f"{_NS}tags": list(self.tags),
            f"{_NS}owner": self.owner,
            f"{_NS}depends_on": list(self.depends_on),
            f"{_NS}state": self.state,
            f"{_NS}version": self.version,
        }
        if self.description is not None:
            document["description"] = self.description
        return document

    @classmethod
    def from_okf(cls, data: dict[str, object]) -> SkillFrontmatter:
        validate_okf(data)
        try:
            return cls(
                concept_type=str(data["type"]),
                slug=str(data[f"{_NS}slug"]),
                title=str(data["title"]),
                description=_opt_str(data.get("description")),
                when_to_use=_opt_str(data.get(f"{_NS}when_to_use")),
                when_not=_opt_str(data.get(f"{_NS}when_not")),
                tags=[str(t) for t in _seq(data.get(f"{_NS}tags", data.get("tags")))],
                owner=_opt_str(data.get(f"{_NS}owner")),
                depends_on=[str(d) for d in _seq(data.get(f"{_NS}depends_on"))],
                state=str(data.get(f"{_NS}state", "active")),
                version=_as_int(data.get(f"{_NS}version", 1)),
                extensions={key: value for key, value in data.items() if key not in _OWNED_KEYS},
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
    """Validate the pinned OKF v0.1 concept contract, without rejecting extensions."""
    concept_type = doc.get("type")
    if not isinstance(concept_type, str) or not concept_type.strip():
        raise SkillFrontmatterError("type must be a non-empty string (OKF v0.1 §4.1)")
    for key in ("title", "description", "resource", "timestamp"):
        if key in doc and not isinstance(doc[key], str):
            raise SkillFrontmatterError(f"{key} must be a string when present (OKF v0.1 §4.1)")
    if "tags" in doc and (
        not isinstance(doc["tags"], list) or any(not isinstance(tag, str) for tag in doc["tags"])
    ):
        raise SkillFrontmatterError("tags must be a list of strings (OKF v0.1 §4.1)")
    _validate_json_value(doc, path="frontmatter")


def _validate_json_value(value: object, *, path: str) -> None:
    if value is None or isinstance(value, str | int | bool):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SkillFrontmatterError(f"{path} contains a non-JSON-compatible number")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, path=f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise SkillFrontmatterError(f"{path} keys must be strings")
            _validate_json_value(item, path=f"{path}.{key}")
        return
    raise SkillFrontmatterError(f"{path} contains a non-JSON-compatible value")


def parse_skill(text: str) -> tuple[SkillFrontmatter, str]:
    """Split ``---\\nyaml\\n---\\nbody`` into a validated frontmatter + the markdown body."""
    if not text.lstrip().startswith("---"):
        raise SkillFrontmatterError("a skill must begin with a '---' frontmatter block")
    stripped = text.lstrip()
    parts = stripped.split("---", 2)
    if len(parts) < 3:
        raise SkillFrontmatterError("unterminated frontmatter block")
    data = yaml.load(parts[1], Loader=_StringTimestampSafeLoader) or {}  # noqa: S506
    if not isinstance(data, dict):
        raise SkillFrontmatterError("frontmatter must be a mapping")
    validate_okf(data)
    return SkillFrontmatter.from_okf(data), parts[2].lstrip("\n")


def serialize_skill(frontmatter: SkillFrontmatter, body: str) -> str:
    """Render a skill back to ``---\\nyaml\\n---\\nbody`` (round-trips :func:`parse_skill`)."""
    yaml_block = yaml.safe_dump(frontmatter.to_okf(), sort_keys=True, allow_unicode=True)
    return f"---\n{yaml_block}---\n{body}"
