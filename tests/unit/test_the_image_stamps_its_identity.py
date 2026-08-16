"""SPEC release-identity: the artifact carries the identity it will report.

The identity is fixed when the artifact is built, because the artifact *is* the thing being
identified. Two alternatives were rejected in the plan: deriving it at runtime from the repository
is impossible in an image that contains none, and reading it from the deployment environment lets
the deployment declare a version the code is not — the original defect with better ergonomics.

What this file guards is the failure mode of *that* design: a stamp that silently does not arrive.
An unstamped image is not a crash; it is an instance quietly reporting that it is not a published
release when it is one. That is recoverable but wrong, and it would be discovered by an operator
rather than by the build.

So the build asserts. This is the AUDIT-083 rule — assert the property where it is created, not
months later on someone's host — and the same shape as AUDIT-087's build-time check that the OCR
models it needs are actually on disk.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO / "Dockerfile"

#: The variable the runtime reads. Named here so a rename that breaks the pairing fails a test
#: rather than producing an image whose stamp nothing looks at.
STAMP_VAR = "RSC_BRAIN_BUILD_IDENTITY"


def _instructions() -> str:
    """The Dockerfile with comment lines removed.

    A substring search over the whole file matches the comments that *explain* the stamp, so it
    would pass on a Dockerfile that documents the mechanism and never performs it. This repository
    has been bitten by that exact confusion more than once.
    """
    return "\n".join(
        line
        for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
        if not line.strip().startswith("#")
    )


def test_the_build_accepts_an_identity() -> None:
    instructions = _instructions()
    assert re.search(rf"ARG\s+{STAMP_VAR}", instructions), (
        "the build takes no identity argument, so every image is unstamped and every instance "
        "reports that it is not a published release"
    )


def test_the_identity_reaches_the_runtime_stage() -> None:
    """A multi-stage build drops build arguments between stages unless they are re-declared; an
    identity that exists only in the build stage is an identity the running process cannot read."""
    instructions = _instructions()
    runtime = instructions[instructions.rindex("FROM ") :]
    assert re.search(rf"ENV\s+.*{STAMP_VAR}=|{STAMP_VAR}=\$\{{?{STAMP_VAR}", runtime), (
        "the identity is declared but never set in the runtime stage, so the process reads nothing"
    )


def test_the_build_fails_when_the_identity_is_missing() -> None:
    """The property that makes the stamp trustworthy rather than hopeful."""
    instructions = _instructions()
    assert re.search(rf'test\s+-n\s+"?\$\{{?{STAMP_VAR}', instructions), (
        "nothing fails the build on an empty identity, so an unstamped image ships silently and "
        "is discovered by an operator instead of by CI"
    )


def test_the_runtime_variable_matches_what_the_code_reads() -> None:
    """The pairing is the whole mechanism: a rename on one side is a silent disconnection."""
    from rsc_brain.identity_release import STAMP_ENV_VAR

    assert STAMP_ENV_VAR == STAMP_VAR
    assert STAMP_VAR in _instructions()


def test_the_stamp_is_not_documented_as_configuration() -> None:
    """R7: the obvious wrong thing to try is setting it in a deployment. The reference has to say
    plainly that it is not an override, or an operator will assume it is one."""
    configuration = (REPO / "docs" / "reference" / "configuration.md").read_text(encoding="utf-8")
    assert STAMP_VAR in configuration
    section = configuration[configuration.index(STAMP_VAR) :][:900].lower()
    assert "not an override" in section or "not configuration" in section, (
        "the reference mentions the variable without saying it cannot be set by the deployment"
    )
