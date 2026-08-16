"""What build am I? (SPEC release-identity)

`brain --version` used to print `__version__` — the version in the source tree — which on a checkout
forty-nine commits past `v0.13.0` still read `0.13.0`. An operator running `main` and an operator
running the actual release got the same string, and the image was always tagged `latest`, so nothing
downstream disagreed either. Support cannot ask "which version"; a rollback cannot name one; an
advisory cannot say who it applies to.

The identity has **two forms**, and they are one fact at two levels of detail:

- **full** — tells every build apart: a published version, a descendant of one, a modified tree.
  It is what the command line prints, what an artifact is named by, and what a release records.
- **public** — a truthful *reduction*: which published version this is, or that it is not one. It
  carries no source revision, and it is what an unauthenticated caller receives.

A reduction may lose detail. It may never gain a claim: the public form never names a published
version that the full form does not.

This module reads **nothing** — no database, no configuration, no network, no credentials. That is
not incidental. The spec requires the version endpoint to answer while the instance's dependencies
are degraded, and the only way to guarantee that is to depend on none of them.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Final

from rsc_brain import __version__

#: The environment variable the image build writes the stamp into. It is read at import and is NOT
#: an operator control: see `resolve`.
STAMP_ENV_VAR: Final = "RSC_BRAIN_BUILD_IDENTITY"

#: What a build with no stamp calls itself. It must not be mistakable for a published version —
#: reporting the bare package version here is precisely the defect this module exists to close.
UNKNOWN_SUFFIX: Final = "+unknown"

#: What a build that is not a published version calls itself in the PUBLIC form. Coarse on purpose:
#: two different development builds share it, and only the full form separates them.
DEVELOPMENT_SUFFIX: Final = "+dev"

# `git describe --tags --always --dirty` shapes: v0.13.0 · v0.13.0-49-gb440e6e · …-dirty
#
# The `-dirty` marker is stripped BEFORE matching rather than being an optional group, because the
# version part legitimately accepts a prerelease suffix (`0.13.0-rc1`) — so a single pattern reads
# `v0.13.0-dirty` as the version "0.13.0-dirty" with a clean tree, and a modified working tree ends
# up reported as a published release. Caught by the test for exactly that stamp.
_DIRTY_MARKER: Final = "-dirty"
_DESCRIBE = re.compile(
    r"^v?(?P<version>\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)"
    r"(?:-(?P<distance>\d+)-g(?P<commit>[0-9a-f]+))?$"
)

_MAX_STAMP = 200


class _Unset:
    """Distinguishes "no argument given" (read the build stamp) from an explicit ``None`` (there
    is no stamp) — the second is a real case the tests exercise, so it cannot be the default."""


_UNSET: Final = _Unset()


@dataclass(frozen=True, slots=True)
class Identity:
    """One build's identity. A value, never a service."""

    #: The version line this build is or descends from, e.g. ``0.13.0``.
    version: str
    #: True only when this build IS that published version: at the tag, with a clean tree.
    is_published: bool
    #: The complete identity string. Distinct for every distinct build.
    full: str


def _fallback(reason: str) -> Identity:
    """An identity for a build we cannot pin down.

    It still names the version line — useless is not the same as honest — but it is never mistakable
    for the published release. AUDIT-090 was the absence of a value reported as a definite answer;
    this is the same trap one layer earlier, and it is avoided by making "I don't know" a value the
    caller can see.
    """
    return Identity(version=__version__, is_published=False, full=f"{__version__}{reason}")


def resolve(stamp: str | _Unset | None = _UNSET) -> Identity:
    """The identity of this build, from the stamp written at image build time.

    Passing ``stamp`` explicitly is for tests. In a running process the value comes from the build,
    never from the deployment: an operator who could set it could declare a version the code is not,
    which is the defect wearing better ergonomics. The variable is read here and nowhere else, and
    the reference documentation states it is not an override.
    """
    raw = os.environ.get(STAMP_ENV_VAR) if isinstance(stamp, _Unset) else stamp
    if raw is None or not raw.strip():
        return _fallback(UNKNOWN_SUFFIX)

    text = raw.strip()[:_MAX_STAMP]
    described, dirty = (
        (text[: -len(_DIRTY_MARKER)], True) if text.endswith(_DIRTY_MARKER) else (text, False)
    )
    match = _DESCRIBE.match(described)
    if match is None:
        # A stamp we cannot parse is not a reason to crash every surface that reads it, and it is
        # certainly not a reason to claim a release. Carry it verbatim so it is diagnosable.
        return Identity(version=__version__, is_published=False, full=f"{__version__}+{text}")

    at_tag = match.group("distance") is None
    return Identity(version=match.group("version"), is_published=at_tag and not dirty, full=text)


def public_of(identity: Identity) -> str:
    """The public form: a truthful reduction of ``identity``.

    Published builds answer with the bare version. Everything else answers with the version it
    descends from plus a marker that says it is not that release — so the answer is coarse without
    ever being wrong.
    """
    if identity.is_published:
        return identity.version
    return f"{identity.version}{DEVELOPMENT_SUFFIX}"


def public() -> str:
    """The public form of this build's identity."""
    return public_of(resolve())


def full() -> str:
    """The full form of this build's identity."""
    return resolve().full
