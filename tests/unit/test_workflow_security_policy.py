"""Repository-wide security contract for GitHub Actions and release rehearsal."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"
CI = WORKFLOWS / "ci.yml"
RELEASE = WORKFLOWS / "release.yml"
PRODUCTION_ONLY = "github.event_name != 'workflow_dispatch'"


def _load(path: Path) -> dict[str, Any]:
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    # PyYAML follows YAML 1.1 and parses the unquoted key `on` as True.
    if "on" not in loaded and True in loaded:
        loaded["on"] = loaded.pop(True)
    return {str(key): value for key, value in loaded.items()}


def _events(workflow: dict[str, Any]) -> dict[str, Any]:
    events = workflow.get("on")
    assert isinstance(events, dict)
    return events


def _jobs(path: Path) -> dict[str, dict[str, Any]]:
    jobs = _load(path).get("jobs")
    assert isinstance(jobs, dict)
    return jobs


def _needs(job: dict[str, Any]) -> set[str]:
    needs = job.get("needs") or []
    if isinstance(needs, str):
        return {needs}
    assert isinstance(needs, list)
    return {str(item) for item in needs}


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps") or []
    assert isinstance(steps, list)
    return [step for step in steps if isinstance(step, dict)]


def _build_signatures(job: dict[str, Any]) -> set[tuple[str, str]]:
    signatures: set[tuple[str, str]] = set()
    for step in _steps(job):
        if "docker/build-push-action" not in str(step.get("uses", "")):
            continue
        options = step.get("with") or {}
        signatures.add((str(options.get("context", ".")), str(options.get("file", "Dockerfile"))))
    return signatures


def test_every_external_action_in_every_workflow_has_an_immutable_reviewable_identity() -> None:
    reference_pattern = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(.+))?$", re.MULTILINE)
    files = sorted(WORKFLOWS.glob("*.y*ml"))
    assert files, "the repository has no workflow files; the policy check would be vacuous"

    checked: list[str] = []
    for path in files:
        for reference, comment in reference_pattern.findall(path.read_text(encoding="utf-8")):
            if reference.startswith("./"):
                continue
            checked.append(f"{path.name}:{reference}")
            assert "@" in reference, f"{path.name}: unpinned action {reference}"
            action, revision = reference.rsplit("@", 1)
            assert action and re.fullmatch(r"[0-9a-f]{40}", revision), (
                f"{path.name}: {reference} is not pinned to a full lowercase commit SHA"
            )
            assert re.match(r"v\d", comment), (
                f"{path.name}: {reference} needs an adjacent upstream version comment"
            )

    assert checked, "no external Actions were inspected; the immutable-reference check is vacuous"


def test_ci_is_reusable_without_weakening_its_direct_pr_and_push_gates() -> None:
    workflow = _load(CI)
    events = _events(workflow)
    assert {"push", "pull_request", "workflow_call"} <= set(events)
    assert workflow.get("permissions") == {"contents": "read"}
    assert "pull_request_target" not in events


def test_release_manual_event_is_dry_run_only_and_calls_the_real_ci() -> None:
    workflow = _load(RELEASE)
    events = _events(workflow)
    assert "workflow_dispatch" in events, "release has no manual non-production rehearsal"
    assert workflow.get("permissions") == {}

    jobs = _jobs(RELEASE)
    quality = jobs.get("quality")
    assert isinstance(quality, dict)
    assert quality.get("uses") == "./.github/workflows/ci.yml"
    assert quality.get("permissions") == {"contents": "read"}

    for name, job in jobs.items():
        permissions = job.get("permissions") or {}
        rendered = yaml.safe_dump(job)
        can_write = "write" in permissions.values()
        can_publish = any(
            marker in rendered
            for marker in (
                "push: true",
                "docker/login-action",
                "actions/attest-build-provenance",
                "gh release ",
            )
        )
        if can_write or can_publish:
            assert PRODUCTION_ONLY in str(job.get("if", "")), (
                f"manual dry run can reach write/publish job {name!r}"
            )


def test_dry_run_builds_every_production_image_without_push_or_write_scope() -> None:
    jobs = _jobs(RELEASE)
    publish = jobs["publish"]
    dry_build = jobs.get("dry-build")
    assert isinstance(dry_build, dict), "manual release rehearsal does not build the images"
    assert str(dry_build.get("if", "")).strip() == "github.event_name == 'workflow_dispatch'"
    assert dry_build.get("permissions") == {"contents": "read"}
    assert _build_signatures(dry_build) == _build_signatures(publish)
    assert len(_build_signatures(dry_build)) >= 3

    for step in _steps(dry_build):
        if "docker/build-push-action" in str(step.get("uses", "")):
            assert (step.get("with") or {}).get("push") is False
        assert "docker/login-action" not in str(step.get("uses", ""))
        assert "attest-build-provenance" not in str(step.get("uses", ""))


def test_release_evidence_and_publication_have_explicit_graph_dependencies() -> None:
    jobs = _jobs(RELEASE)
    required_evidence = {"quality", "sbom", "vuln-scan"}
    assert required_evidence <= set(jobs)
    assert required_evidence <= _needs(jobs["dry-build"])
    assert required_evidence <= _needs(jobs["publish"])
    assert required_evidence | {"publish"} <= _needs(jobs["release"])


def test_release_job_permissions_are_exact_and_evidence_jobs_are_read_only() -> None:
    jobs = _jobs(RELEASE)
    expected = {
        "quality": {"contents": "read"},
        "sbom": {"contents": "read"},
        "vuln-scan": {"contents": "read"},
        "dry-build": {"contents": "read"},
        "publish": {
            "contents": "read",
            "packages": "write",
            "id-token": "write",
            "attestations": "write",
        },
        "release": {"contents": "write"},
    }
    assert set(jobs) == set(expected), "new release jobs need an explicit permission review"
    for name, permissions in expected.items():
        assert jobs[name].get("permissions") == permissions


def test_dependabot_reviews_action_identity_updates() -> None:
    dependabot = _load(REPO / ".github" / "dependabot.yml")
    updates = dependabot.get("updates") or []
    github_actions = [
        update
        for update in updates
        if isinstance(update, dict) and update.get("package-ecosystem") == "github-actions"
    ]
    assert len(github_actions) == 1
    assert github_actions[0].get("directory") == "/"
    assert (github_actions[0].get("schedule") or {}).get("interval") in {"daily", "weekly"}


def test_no_job_calls_a_third_party_reusable_workflow() -> None:
    """A called workflow's own permission demands are invisible to this file.

    `osv-scanner-reusable.yml` declares `security-events: write` on its job even when SARIF upload
    is switched off, and a called workflow may not request more than its caller was granted — so
    GitHub refused to start the entire workflow (`startup_failure`) while every local gate here
    stayed green. Nothing in this repository could see that, because the demand lived in another
    repository's file. Calling the action instead keeps the permission surface reviewable here.

    A local call (`./.github/workflows/ci.yml`, the release rehearsal) is fine: its permissions are
    asserted a few tests above this one.
    """
    for path in (CI, RELEASE):
        for name, job in _jobs(path).items():
            called = job.get("uses")
            if called is None:
                continue
            assert str(called).startswith("./"), (
                f"{path.name}:{name} calls the third-party reusable workflow {called!r}; its "
                "permission demands cannot be reviewed here and cap-fail at workflow startup. "
                "Call the action inside a job instead."
            )
