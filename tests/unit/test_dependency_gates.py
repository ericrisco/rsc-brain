"""Truthful multi-ecosystem dependency and secret gates (AUDIT-013 / R14)."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Any

import yaml
from packaging.version import Version

REPO_ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
DEPENDABOT = REPO_ROOT / ".github" / "dependabot.yml"
GITLEAKS_CONFIG = REPO_ROOT / ".gitleaks.toml"
GITLEAKS_IGNORE = REPO_ROOT / ".gitleaksignore"
ADMIN_LOCK = REPO_ROOT / "apps" / "admin" / "package-lock.json"
DOCTOR_TEST = REPO_ROOT / "tests" / "unit" / "test_doctor.py"
HUNTING_TEST = REPO_ROOT / "tests" / "integration" / "test_console_hunting_skills.py"

OSV_ACTION = (
    "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml"
    "@8deb546fdb875b9996d27d4950be7312dac076a1"  # v2.5.0
)
EXPECTED_HISTORICAL_FIXTURES = {
    "4fd836add73645c85131b14704242ee4fad52f92:"
    "tests/integration/test_console_hunting_skills.py:generic-api-key:124",
    "c7ae55a849855f9037f359f9cedd8d713cb0b970:"
    "tests/integration/test_console_hunting_skills.py:generic-api-key:124",
    "9cc99438b0211551ce27005822cccacd2c081560:tests/unit/test_doctor.py:generic-api-key:13",
    "9cc99438b0211551ce27005822cccacd2c081560:tests/unit/test_doctor.py:generic-api-key:30",
}


def _yaml(path: Path) -> dict[str, Any]:
    parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    return parsed


def test_ci_audits_both_native_dependency_graphs_without_hiding_dev_tools() -> None:
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")
    assert "pip-audit" in workflow, "CI does not gate the Python dependency graph"
    audit_lines = [line.strip() for line in workflow.splitlines() if "npm audit" in line]
    assert audit_lines, "CI does not gate the committed admin dependency graph"
    assert any("--audit-level=high" in line for line in audit_lines)
    assert all("--omit=dev" not in line for line in audit_lines), (
        f"a production-only audit hides vulnerable build and code-generation tools: {audit_lines}"
    )


def test_ci_runs_pinned_fail_closed_osv_over_both_lockfiles() -> None:
    jobs = _yaml(CI_WORKFLOW).get("jobs", {})
    assert isinstance(jobs, dict)
    osv = jobs.get("osv")
    assert isinstance(osv, dict), "CI has no primary multi-ecosystem OSV gate"
    assert osv.get("uses") == OSV_ACTION
    assert osv.get("continue-on-error") is not True

    inputs = osv.get("with", {})
    assert isinstance(inputs, dict)
    assert inputs.get("fail-on-vuln") is True
    assert inputs.get("upload-sarif") is False
    args = inputs.get("scan-args", "")
    assert isinstance(args, str)
    assert "--lockfile=./uv.lock" in args
    assert "--lockfile=./apps/admin/package-lock.json" in args
    assert "--allow-no-lockfiles" not in args


def test_admin_lock_contains_no_known_release_blocking_versions() -> None:
    packages = json.loads(ADMIN_LOCK.read_text(encoding="utf-8"))["packages"]
    vulnerable: list[str] = []
    for path, metadata in packages.items():
        if not path or not isinstance(metadata, dict) or "version" not in metadata:
            continue
        name = path.rsplit("node_modules/", maxsplit=1)[-1]
        if name not in {"@redocly/openapi-core", "js-yaml", "brace-expansion"}:
            continue
        version = Version(metadata["version"])
        blocked = (
            (name == "@redocly/openapi-core" and Version("1.34.8") <= version < Version("1.34.18"))
            or (name == "js-yaml" and Version("4.0.0") <= version < Version("4.3.1"))
            or (name == "brace-expansion" and version < Version("1.1.18"))
            or (name == "brace-expansion" and Version("2.0.0") <= version < Version("2.1.4"))
            or (name == "brace-expansion" and Version("4.0.0") <= version < Version("5.0.9"))
        )
        if blocked:
            vulnerable.append(f"{path}@{version}")
    assert vulnerable == [], f"known high dependency versions remain locked: {vulnerable}"


def test_dependabot_covers_every_ecosystem_with_a_three_day_cooldown() -> None:
    updates = _yaml(DEPENDABOT).get("updates", [])
    assert isinstance(updates, list)
    configured = {
        (entry.get("package-ecosystem"), entry.get("directory")): entry
        for entry in updates
        if isinstance(entry, dict)
    }
    required = {
        ("github-actions", "/"),
        ("uv", "/"),
        ("docker", "/docker"),
        ("npm", "/apps/admin"),
    }
    assert required <= configured.keys()
    for key in required:
        cooldown = configured[key].get("cooldown", {})
        assert cooldown.get("default-days") == 3, f"{key} lacks the ratified 72-hour cooldown"


def test_secret_exceptions_are_line_or_fingerprint_local_not_global() -> None:
    config = tomllib.loads(GITLEAKS_CONFIG.read_text(encoding="utf-8"))
    assert "allowlist" not in config
    assert "allowlists" not in config

    ignore_text = GITLEAKS_IGNORE.read_text(encoding="utf-8")
    assert "Reason:" in ignore_text
    ignored = {
        line.strip()
        for line in ignore_text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert ignored == EXPECTED_HISTORICAL_FIXTURES
    assert all(re.fullmatch(r"[0-9a-f]{40}:.+:[a-z0-9-]+:\d+", item) for item in ignored)

    fixture_lines = [
        line
        for line in DOCTOR_TEST.read_text(encoding="utf-8").splitlines()
        if "sk-ABCDEFGH1234567890abcdef" in line or "hunter2-real-value" in line
    ]
    assert len(fixture_lines) == 2
    assert all("gitleaks:allow" in line and "fixture" in line.lower() for line in fixture_lines)
    assert "hunt-topics-001" not in HUNTING_TEST.read_text(encoding="utf-8")
