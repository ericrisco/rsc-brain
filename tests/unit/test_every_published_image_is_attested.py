"""AUDIT-094: provenance was recorded as "assumed yes" and was in fact no.

The release-identity spec left one point deferred with the words **"Assumed yes unless objected"**,
and the release workflow already produced an SBOM and a CVE scan, which made the assumption feel
covered. Asked directly against the first published digest:

    gh attestation verify oci://ghcr.io/ericrisco/rsc-brain/app:0.13.1-rc2 --repo ericrisco/rsc-brain
    Error: HTTP 404: Not Found

An SBOM says what is *inside* an artifact and a CVE scan says what is wrong with it. Neither says
the artifact came from this repository's CI at this commit. An operator pulling by version had no
way to distinguish a real publication from an image pushed by someone else to a name that resembles
ours — which is precisely the question a self-hosted, install-from-registry product has to answer.

This is the campaign's recurring shape once more: a declaration that points at nothing. It survived
because nobody asked the registry, exactly as AUDIT-093 survived because nobody tried to install.

The test closes the class rather than the instance: **every image the release pushes must also be
attested.** A fourth component added later cannot ship unsigned.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "release.yml"

#: The action that produces the statement `gh attestation verify` later reads.
ATTEST_ACTION = "actions/attest-build-provenance"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _steps() -> list[dict]:
    return [step for job in _workflow()["jobs"].values() for step in (job.get("steps") or [])]


def _without_tag(reference: str) -> str:
    """Strip the tag, which may be a `${{ … }}` interpolation containing colons."""
    return re.sub(r":\$?\{?[^/]*$", "", reference).rstrip(":")


def _pushed_images() -> set[str]:
    pushed = set()
    for step in _steps():
        options = step.get("with") or {}
        if not options.get("push"):
            continue
        for tag in str(options.get("tags", "")).splitlines():
            if tag.strip():
                pushed.add(_without_tag(tag.strip()))
    return pushed


def _attested_images() -> set[str]:
    return {
        str((step.get("with") or {}).get("subject-name", "")).strip()
        for step in _steps()
        if ATTEST_ACTION in str(step.get("uses", ""))
    } - {""}


def test_the_release_pushes_images_at_all() -> None:
    """Precondition. Without it the comparison below passes on an empty set — the failure shape
    this project has now met six times, and the reason AUDIT-086 let a docs gate go green over
    zero commands."""
    assert _pushed_images(), "the release workflow pushes no image; the comparison below is vacuous"


def test_every_published_image_is_attested() -> None:
    """The regression. HTTP 404 from `gh attestation verify` is what this prevents."""
    unsigned = _pushed_images() - _attested_images()
    assert not unsigned, (
        f"the release publishes {sorted(unsigned)} with no provenance statement, so an operator "
        "cannot tell those artifacts from an image someone else pushed under a similar name"
    )


def test_no_attestation_names_an_image_the_release_never_pushes() -> None:
    """The other direction. An attestation step whose subject is a typo signs nothing and reports
    success, which is worse than not signing at all: the workflow turns green and the operator's
    verification still fails."""
    orphans = _attested_images() - _pushed_images()
    assert not orphans, (
        f"{sorted(orphans)} are attested but never pushed — the statement has no subject, and the "
        "release still reports success"
    )


def test_the_signing_scopes_are_granted_only_to_the_publishing_job() -> None:
    """Constitution §8 / AUDIT-006: least privilege per job. The ability to sign on behalf of this
    repository is strictly more dangerous than the ability to read it, so the evidence jobs — which
    only read source — must not hold it."""
    jobs = _workflow()["jobs"]
    signing = {"id-token", "attestations"}
    for name, job in jobs.items():
        held = signing & set((job.get("permissions") or {}).keys())
        attests = any(ATTEST_ACTION in str(s.get("uses", "")) for s in (job.get("steps") or []))
        if held and not attests:
            raise AssertionError(
                f"job {name!r} holds {sorted(held)} without signing anything; the scope that lets a "
                "workflow speak for this repository belongs only to the job that publishes"
            )
        if attests:
            missing = signing - set((job.get("permissions") or {}).keys())
            assert not missing, f"job {name!r} attests but lacks {sorted(missing)}"
