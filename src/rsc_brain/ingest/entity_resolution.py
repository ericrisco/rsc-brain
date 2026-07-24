"""Deterministic entity resolution (FR-1.9, v0.1 part). Id = ``uuid5(type + normalized_name)``.

No LLM: alias-merge assisted by a model is SPEC-09. Dedup is **within a project only** (the
callers pass a :class:`~rsc_brain.scope.ProjectScope`; the DB unique key is
``(project_id, normalized_name, type)``), so the same entity in two projects is two nodes
(FR-12.4).
"""

from __future__ import annotations

import re
import unicodedata
import uuid

# Fixed (deterministic) namespace for rsc-brain entity ids — uuid5 is a pure hash, not random.
ENTITY_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://rsc-brain.dev/entities")

_DECORATIVE = re.compile(r"[^\w\s]", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    """Canonical form for dedup: NFKC → casefold → strip decorative punctuation → collapse
    whitespace. Documented per SPEC-05 §4.8.1 so the id is stable and reproducible."""
    text = unicodedata.normalize("NFKC", name).casefold()
    text = _DECORATIVE.sub(" ", text)
    return _WHITESPACE.sub(" ", text).strip()


def entity_id(entity_type: str, name: str) -> uuid.UUID:
    """Deterministic project-independent id for ``(type, normalized_name)``.

    Project isolation is enforced by the DB unique key and the scoped upsert, not by this id, so
    the id itself may collide across projects — the writes never do (different ``project_id``)."""
    key = f"{entity_type.strip().casefold()}:{normalize_name(name)}"
    return uuid.uuid5(ENTITY_NAMESPACE, key)
