"""AUDIT-077: an operator must configure a model route the product never calls.

Found while explaining why G4 measured 0/8. The abstention gate could not separate relevant from
irrelevant knowledge by embedding similarity alone — measured on the host, the populations overlap:

    worst genuine hit  0.542
    best  should-abstain 0.574        margin -0.032, not separable by any threshold

The component designed for exactly that problem is a reranker, and the product declares one. So
before concluding anything about the product I checked whether I had simply disabled it.

I had not. It is not called anywhere:

    config/models.py:31   RERANKER in the capability enum
    config/models.py:90   `reranker: CapabilityConfig`  — REQUIRED, no default
    docs/reference/configuration.md    "required"
    docs/how-to/troubleshooting.md     "All five routes are required"
    gateway/model_gateway.py:5         named in a docstring
    (no call site anywhere in src/)

FR-3.6 makes the reranker **optional and P2**, and `RerankerConfig.enabled` is `False` by default, so
the feature being unimplemented is declared scope, not a defect. What is a defect is that its
**route** is mandatory: an operator must choose a provider and a model name for a capability that is
off by default, unimplemented and never invoked — and `brain verify` then reports "every capability
is configured", a green check on a route that leads nowhere.

Against G1 (install in under 30 minutes) that is one of five mandatory decisions being dead weight.
My own AUDIT-059 fix propagated it into the compose and Helm defaults, which made the burden more
visible while it was still useless.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from rsc_brain.config.models import AppConfig, CapabilitiesConfig

FOUR = {
    name: {"provider": "ollama", "model": "x"}
    for name in ("extractor", "judge", "topicalizer", "embedder")
}


def test_a_disabled_capability_does_not_demand_a_model_route() -> None:
    """The four routes the product actually calls are enough to configure it."""
    capabilities = CapabilitiesConfig(**FOUR)
    assert capabilities.reranker is None, "an unconfigured route should be absent, not invented"


def test_enabling_the_reranker_demands_its_route() -> None:
    """Optional is not the same as ignorable: if an operator turns it on, the route must exist, and
    the refusal must say so rather than failing later at the first call."""
    with pytest.raises(ValidationError, match="reranker"):
        AppConfig(capabilities=CapabilitiesConfig(**FOUR), reranker={"enabled": True})


def test_enabling_the_reranker_with_its_route_is_accepted() -> None:
    config = AppConfig(
        capabilities=CapabilitiesConfig(**FOUR, reranker={"provider": "ollama", "model": "r"}),
        reranker={"enabled": True},
    )
    assert config.capabilities.reranker is not None


def test_asking_for_an_unconfigured_capability_fails_loudly() -> None:
    """`get()` used to be a plain getattr. Returning None to a caller that expects a route is how a
    missing configuration turns into an AttributeError three frames away."""
    from rsc_brain.config.models import Capability

    capabilities = CapabilitiesConfig(**FOUR)
    with pytest.raises(ValueError, match="reranker"):
        capabilities.get(Capability.RERANKER)
    assert capabilities.get(Capability.EMBEDDER).model == "x"


def test_the_documentation_no_longer_requires_five_routes() -> None:
    """The docs told operators to configure a route the product never calls."""
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    troubleshooting = (repo / "docs" / "how-to" / "troubleshooting.md").read_text(encoding="utf-8")
    assert "All five routes are required" not in troubleshooting, (
        "the docs still demand a route for a capability that is off by default and never invoked"
    )
