"""AUDIT-097: AUDIT-085 changed both defaults and left the documentation teaching the old value.

AUDIT-085 established that `bge-reranker-v2-m3` cannot serve this product's reranker: it is a
**cross-encoder**, and the only implementation calls `complete_structured`, which needs a chat model.
An install pointed at it gets `reranker.enabled = True`, every call failing, and abstention silently
back on the blended threshold — the one measured incapable of meeting G4.

Both *defaults* were changed. `deploy/helm/PARITY.md` records it and adds:

    whether the route can serve the implementation must not [differ], and a unit test pins exactly
    that rather than the string.

The test pinned `deploy/docker-compose.prod.yml`. Two documents kept teaching the removed value:

    deploy/README.md                    RSC_BRAIN_CAPABILITIES__RERANKER__MODEL: bge-reranker-v2-m3
    deploy/helm/rsc-brain/README.md     value: bge-reranker-v2-m3

**Documentation that undoes the fix, not documentation that lags it.** Both snippets are the
copy-paste path an operator follows, and both land in a place that *overrides* the corrected default:
the compose one is the untracked `compose.models.yml` overlay, and the Helm one is `extraEnv`, which
is rendered into the container over `capabilities.reranker.model`. The chart's own default is right
and its README talks the operator out of it.

This is the second time today the same shape appeared: a fix applied to the loud copy of a sentence
and not the quiet one — the parity guard's error message was corrected while its header comment kept
teaching the command that disarms the guard. There the quiet copy was a comment; here it is the one
operators actually run.

The test closes the class rather than the two instances: **no shipped file may name a reranker route
that differs from the shipped default.** Docs and default cannot drift apart again.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "deploy" / "docker-compose.prod.yml"

#: Where an operator is told what to set. Every one of these is copy-paste input.
DOCUMENTS = (
    REPO / "deploy" / "README.md",
    REPO / "deploy" / "helm" / "rsc-brain" / "README.md",
    REPO / "deploy" / "helm" / "rsc-brain" / "values.yaml",
    REPO / "docs" / "reference" / "configuration.md",
)

#: Models that serve a rerank API rather than a chat completion. `complete_structured` cannot use
#: any of them, so naming one anywhere is naming a route that fails every call.
CROSS_ENCODERS = ("bge-reranker", "jina-reranker", "mxbai-rerank", "cohere-rerank")

_ROUTE = re.compile(
    r"RSC_BRAIN_CAPABILITIES__RERANKER__MODEL\s*[:=]\s*(?:\$\{[^:]*:-)?([^\s'\"}#]+)"
)


def _shipped_default() -> str:
    """The reranker model an operator gets without configuring anything."""
    match = _ROUTE.search(COMPOSE.read_text(encoding="utf-8"))
    assert match, (
        "no reranker route found in the production compose file; without it the comparisons below "
        "have no reference and would pass vacuously"
    )
    return match.group(1)


def test_the_shipped_default_is_not_a_cross_encoder() -> None:
    """The precondition. If this ever regresses, everything below is measuring the wrong thing."""
    default = _shipped_default()
    for family in CROSS_ENCODERS:
        assert family not in default, (
            f"the shipped reranker default is {default!r}, a {family} model: it serves a rerank API "
            "and the implementation calls complete_structured, so every call fails and abstention "
            "silently reverts to the blended threshold"
        )


def test_no_document_teaches_a_reranker_route_that_cannot_work() -> None:
    """The regression. Two documents taught `bge-reranker-v2-m3` after both defaults moved off it."""
    offenders = []
    for path in DOCUMENTS:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if "RERANKER" not in line.upper() and "reranker" not in line:
                continue
            # A line that NAMES a cross-encoder in order to warn against it is the opposite of the
            # defect, so only flag it where it appears as a value being assigned.
            # Case-insensitive on purpose: the two real instances were spelled differently —
            # `value: bge-…` in the chart README and `..._RERANKER__MODEL: bge-…` in the compose one.
            # The first version of this check was lower-case only, caught one of the two, and passed
            # while the other stood. A guard that finds half its own motivating cases is the defect
            # it is guarding against.
            if not re.search(r"(?:value|model)\s*[:=]\s*\S", line, re.IGNORECASE):
                continue
            for family in CROSS_ENCODERS:
                if family in line:
                    offenders.append(f"{path.relative_to(REPO)}:{line_no}: {line.strip()}")
    assert not offenders, (
        "these documents tell an operator to configure a reranker route that fails every call, and "
        "each lands where it OVERRIDES the corrected default:\n  " + "\n  ".join(offenders)
    )


def test_every_documented_reranker_route_matches_the_shipped_default() -> None:
    """Stronger than the deny-list, and the reason this closes the class: a future cross-encoder
    nobody thought to list still fails here, because anything other than the shipped default does."""
    default = _shipped_default()
    drift = []
    for path in DOCUMENTS:
        if not path.exists():
            continue
        for value in _ROUTE.findall(path.read_text(encoding="utf-8")):
            if value != default:
                drift.append(f"{path.relative_to(REPO)} teaches {value!r}")
    assert not drift, (
        f"the shipped default is {default!r} and the documentation disagrees:\n  "
        + "\n  ".join(drift)
        + "\nA document that contradicts the default is followed, not the default."
    )
