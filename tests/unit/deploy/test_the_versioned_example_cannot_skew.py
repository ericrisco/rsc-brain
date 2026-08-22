"""The versioned install example may not pair this checkout's compose file with a foreign version.

`deploy/docker-compose.version.yml` sets the environment the application expects, and that environment
changes between versions. Measured: `main`'s copy sets `RSC_BRAIN_CAPABILITIES__*__EGRESS__*` (added by
AUDIT-005), and pinning `0.13.1-rc2` — published before that field existed — crash-loops the API with

    capabilities.embedder.egress — Extra inputs are not permitted [type=extra_forbidden]

a pydantic dump that says nothing about the cause being a version mismatch. The coherent pairing does
exist: the copy of the file at tag `v0.13.1-rc2` carries zero EGRESS references. So the failure comes
from mixing a newer checkout with an older pin — and the file's own example used to invite exactly
that, naming `0.13.0` regardless of what you had checked out.

This is the guard, and writing it changed what it had to assert. My first version demanded that the
example name *this checkout's* version — and it immediately failed on the example I had just written,
because no published image corresponds to any released version of this repository: the only images
that exist are for two `rc` tags. So every concrete version this file could name today is either
foreign to the checkout (skew, crash loop) or unpublished (pull failure).

The rule is therefore stricter and more honest: the example stays **parametric** until a release
exists whose image can be pulled. It is deliberately offline — asking a registry what exists would
make the unit gate depend on the network and on someone's publishing history.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
COMPOSE = REPO / "deploy" / "docker-compose.version.yml"


def test_the_example_names_no_concrete_version() -> None:
    named = re.findall(r"RSC_BRAIN_VERSION=([\w.\-+]+)", COMPOSE.read_text())
    assert named, "the file must keep a copy-pasteable example; an absent one teaches nothing"
    for pinned in named:
        assert not re.match(r"^v?\d", pinned), (
            f"the example pins the concrete version {pinned!r}. Today that is either foreign to the "
            "checkout — which crash-loops the API on a config field the older image has never heard "
            "of — or unpublished, which fails at pull. Keep it parametric until a released version "
            "has an image that can actually be pulled, then pin that one and relax this guard."
        )


def test_the_example_shows_the_tag_checkout_step() -> None:
    """Naming the right version is not enough: the operator has to be told where the file comes from."""
    text = COMPOSE.read_text()
    assert "git checkout v" in text, "the example must show that the file comes from the tag"
    assert "COUPLED TO THE VERSION IT PINS" in text


def test_the_coupling_is_actually_real() -> None:
    """The premise, asserted rather than assumed: this copy does set version-specific environment."""
    assert "EGRESS__ALLOW_HTTP" in COMPOSE.read_text(), (
        "if this file stops setting version-specific capability environment, re-examine whether the "
        "coupling still exists before relaxing the guard above"
    )
