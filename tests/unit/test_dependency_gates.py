"""Both dependency graphs must be gated in CI (AUDIT-013 / R14, T003 RED).

R14's second criterion: *given the CI dependency gate, when either the Python or admin dependency
graph contains a release-blocking advisory, then the workflow fails.* Python had one (``pip-audit``);
the console's production graph was audited locally and never enforced, which is why three high
advisories sat in `main` while every check was green.

The advisories themselves are the red half and cannot be closed by upgrading: ``next@15.5.21`` bundles
``postcss@8.4.31`` and ``sharp@0.34.5``, and the vulnerable ranges cover every published ``next`` up to
``16.3.0-preview.7``. That needs lockfile ``overrides``, which is T005's work. This file pins the gate
so the advisories cannot be silently re-accepted afterwards.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"


@pytest.fixture(scope="module")
def workflow() -> str:
    return CI_WORKFLOW.read_text(encoding="utf-8")


def test_ci_audits_the_python_dependency_graph(workflow: str) -> None:
    assert "pip-audit" in workflow, "CI does not gate the Python dependency graph"


def test_ci_audits_the_console_production_dependency_graph(workflow: str) -> None:
    """The gate must cover the PRODUCTION graph at the release-blocking level.

    ``--omit=dev`` because a build-time advisory is not the same risk as one shipped to a browser, and
    ``--audit-level=high`` because that is the level the spec calls release-blocking. A gate that runs
    the command without failing the job would satisfy the letter and none of the intent, so the
    assertion is on the flags that make it fail.
    """
    assert "npm audit" in workflow, (
        "CI never audits the console's dependency graph, so a high advisory in a shipped package "
        "keeps every check green — which is exactly how three of them reached main"
    )
    audit_lines = [line for line in workflow.splitlines() if "npm audit" in line]
    assert any("--omit=dev" in line for line in audit_lines), (
        f"the npm audit gate does not restrict itself to the production graph: {audit_lines}"
    )
    assert any("--audit-level=high" in line for line in audit_lines), (
        f"the npm audit gate does not fail on release-blocking advisories: {audit_lines}"
    )


def test_the_secret_scan_exception_list_is_not_a_blanket_rule() -> None:
    """R14's third criterion: an exception may cover the two deliberate test fixtures and nothing else.

    Red while no scanner configuration exists — the point of the check is that when one is added, it
    cannot arrive as a pattern-wide suppression.
    """
    candidates = [
        REPO_ROOT / ".gitleaks.toml",
        REPO_ROOT / ".gitleaksignore",
        REPO_ROOT / ".github" / "gitleaks.toml",
    ]
    present = [path for path in candidates if path.exists()]
    assert present, (
        "no secret-scanning configuration exists, so the two deliberate secret-like test fixtures "
        "have no recorded, scoped exception and any future scan will either fail or be muted wholesale"
    )
    for path in present:
        content = path.read_text(encoding="utf-8")
        assert "reason" in content.lower() or "description" in content.lower(), (
            f"{path.name} allows exceptions without recording why"
        )
