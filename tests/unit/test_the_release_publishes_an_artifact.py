"""SPEC release-identity, tranche B: a release must produce something an operator can install.

Measured before this existed: fifteen version tags (`v0.2.0`…`v0.13.0`), **zero published
releases**, and a release workflow that produced an SBOM and a CVE scan — evidence *about* a
release, not a release. Every operator therefore compiled a 9.5 GB image from source, roughly
twenty-five minutes measured on a cx43, and rolling back meant rebuilding at the moment when time
matters most.

These tests assert the **shape** of the publication, because nothing in this repository can prove
that an artifact actually installs from a registry. That is stated plainly in the plan (R4) and
answered by publishing a pre-release tag against a throwaway host — not by a test that pretends.

What shape can prove, and what these assert:

- both components a working install needs are published, not just the application;
- the release record is written **last**, so a partial publication is not a published version;
- the publish job holds exactly the one extra permission it needs and no more;
- third-party actions stay pinned to full commit SHAs.

The console is not a nicety: the access token ingestion requires can only be issued from it, which
was measured on a real host during the second e2e run. Publishing the application alone would leave
an operator building from source to use the product at all.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "release.yml"


def _workflow() -> dict[str, Any]:
    loaded = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _jobs() -> dict[str, Any]:
    jobs = _workflow()["jobs"]
    assert isinstance(jobs, dict)
    return jobs


def _publish_job() -> tuple[str, dict[str, Any]]:
    for name, job in _jobs().items():
        steps = job.get("steps") or []
        rendered = yaml.safe_dump(steps)
        if "push" in rendered and ("registry" in rendered or "ghcr" in rendered):
            return name, job
    raise AssertionError(
        "no job in the release workflow pushes an artifact to a registry — the release still "
        "produces evidence about a release rather than a release"
    )


def test_a_release_publishes_the_application() -> None:
    _, job = _publish_job()
    rendered = yaml.safe_dump(job)
    assert re.search(r"app|application", rendered, re.I), (
        "the publish job does not build the application image"
    )


def test_a_release_publishes_the_console_too() -> None:
    """Measured on a real host: the PAT that ingestion requires is issued only from the console.
    An application published without it leaves the operator building from source anyway."""
    _, job = _publish_job()
    assert "console" in yaml.safe_dump(job).lower(), (
        "the console is not published, so an operator who installs by version still has to build "
        "the component that issues the token ingestion requires"
    )


def test_the_artifacts_are_named_by_the_version_and_not_by_latest() -> None:
    """`latest` is what made two different deployments indistinguishable in the first place."""
    _, job = _publish_job()
    rendered = yaml.safe_dump(job)
    assert re.search(r"github\.ref_name|\bversion\b|\btag\b", rendered, re.I), (
        "the published artifacts are not named by the version tag"
    )


def test_the_publish_job_holds_only_the_permission_it_needs() -> None:
    """Constitution §8 and AUDIT-006: default `{}`, and each job grants exactly what it uses."""
    workflow = _workflow()
    assert workflow.get("permissions") == {}, "the workflow no longer defaults to no permissions"
    _, job = _publish_job()
    permissions = job.get("permissions") or {}
    assert permissions.get("packages") == "write", (
        "the publish job cannot write packages, so publication fails — grant it explicitly rather "
        "than widening the workflow default"
    )
    assert set(permissions) <= {"contents", "packages", "id-token", "attestations"}, (
        f"the publish job holds more than it needs: {sorted(permissions)}"
    )
    assert permissions.get("contents") in (None, "read", "write")


def test_every_third_party_action_is_pinned_to_a_full_sha() -> None:
    """Already true of this workflow; asserted so a new step cannot quietly relax it."""
    text = WORKFLOW.read_text(encoding="utf-8")
    for reference in re.findall(r"uses:\s*(\S+)", text):
        if reference.startswith("./"):
            continue
        assert "@" in reference, f"unpinned action: {reference}"
        pinned = reference.split("@", 1)[1]
        assert re.fullmatch(r"[0-9a-f]{40}", pinned), (
            f"action {reference} is not pinned to a full commit SHA"
        )


def test_the_release_record_is_written_last() -> None:
    """Atomicity, as the spec defines it: a version is published only when everything is.

    Written as a dependency assertion rather than a comment, because "we put it at the end" is the
    kind of ordering that survives exactly until someone adds a step.
    """
    jobs = _jobs()
    declaring = [
        name
        for name, job in jobs.items()
        if "gh release" in yaml.safe_dump(job) or "create-release" in yaml.safe_dump(job)
    ]
    assert declaring, (
        "no job declares the version published, so nothing marks the point at which every artifact "
        "and every piece of evidence exists"
    )

    publish_name, _ = _publish_job()
    for name in declaring:
        needs = jobs[name].get("needs") or []
        needs = [needs] if isinstance(needs, str) else needs
        assert publish_name in needs, (
            f"the job that declares the version published ({name}) does not depend on the job that "
            f"pushes the artifacts ({publish_name}), so a failed push still yields a release"
        )


def test_the_evidence_jobs_survive() -> None:
    """The SBOM and CVE scan predate this change and are a constitution §8 requirement."""
    rendered = yaml.safe_dump(_jobs()).lower()
    assert "syft" in rendered or "sbom" in rendered, "the SBOM job disappeared"
    assert "grype" in rendered or "scan-action" in rendered, "the CVE scan disappeared"
