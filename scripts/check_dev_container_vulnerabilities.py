#!/usr/bin/env python3
"""Fail the dev database image gate on fixable or unreviewed high/critical CVEs."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = REPO / "docker" / "trivy-db-unfixed-baseline.json"
DEFAULT_IMAGE = "rsc-brain/db:pg16-age-pgvector"
TRIVY_IMAGE = (
    "aquasec/trivy:0.66.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e"
)


@dataclass(frozen=True, order=True)
class Finding:
    vulnerability_id: str
    severity: str
    status: str
    package: str
    installed_version: str


def _actual_findings(scan: dict[str, Any]) -> tuple[set[Finding], list[str]]:
    actual: set[Finding] = set()
    fixable: list[str] = []
    for result in scan.get("Results") or []:
        for item in result.get("Vulnerabilities") or []:
            finding = Finding(
                vulnerability_id=str(item.get("VulnerabilityID", "")),
                severity=str(item.get("Severity", "")),
                status=str(item.get("Status", "")),
                package=str(item.get("PkgName", "")),
                installed_version=str(item.get("InstalledVersion", "")),
            )
            actual.add(finding)
            fixed_version = str(item.get("FixedVersion") or "")
            if fixed_version:
                fixable.append(
                    f"{finding.vulnerability_id} {finding.package} "
                    f"{finding.installed_version} -> {fixed_version}"
                )
    return actual, sorted(fixable)


def _reviewed_findings(baseline: dict[str, Any], *, today: date) -> set[Finding]:
    reviewed: set[Finding] = set()
    entries = baseline.get("allowed_unfixed") or []
    for entry in entries:
        rationale = str(entry.get("rationale") or "").strip()
        if not rationale:
            raise ValueError(f"{entry.get('id', '<unknown>')} has no triage rationale")
        owner = str(entry.get("owner") or "").strip()
        if not owner:
            raise ValueError(f"{entry.get('id', '<unknown>')} has no risk owner")
        try:
            review_due = date.fromisoformat(str(entry.get("review_due") or ""))
        except ValueError as error:
            raise ValueError(f"{entry.get('id', '<unknown>')} has no valid review_due") from error
        if review_due < today:
            raise ValueError(
                f"{entry.get('id', '<unknown>')} triage expired on {review_due.isoformat()}"
            )
        for package in entry.get("packages") or []:
            reviewed.add(
                Finding(
                    vulnerability_id=str(entry["id"]),
                    severity=str(entry["severity"]),
                    status=str(entry["status"]),
                    package=str(package),
                    installed_version=str(entry["installed_version"]),
                )
            )
    return reviewed


def evaluate(
    scan: dict[str, Any], baseline: dict[str, Any], *, today: date | None = None
) -> list[str]:
    """Return policy violations; an empty list is a passing gate."""
    actual, fixable = _actual_findings(scan)
    reviewed = _reviewed_findings(baseline, today=today or date.today())
    violations = [f"fixable high/critical: {value}" for value in fixable]

    for finding in sorted(actual - reviewed):
        violations.append(f"unreviewed high/critical: {finding}")
    for finding in sorted(reviewed - actual):
        violations.append(f"stale baseline entry: {finding}")
    return violations


def _scan(image: str) -> dict[str, Any]:
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError("Docker is required; scanner absence is not a passing gate")
    completed = subprocess.run(
        [
            docker,
            "run",
            "--rm",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            TRIVY_IMAGE,
            "--quiet",
            "image",
            "--severity",
            "HIGH,CRITICAL",
            "--skip-version-check",
            "--scanners",
            "vuln",
            "--format",
            "json",
            image,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    parsed = json.loads(completed.stdout)
    if not isinstance(parsed, dict) or not parsed.get("Results"):
        raise RuntimeError("Trivy returned no scan results")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    args = parser.parse_args()

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    scan = _scan(args.image)
    violations = evaluate(scan, baseline)
    if violations:
        print("container vulnerability gate failed:", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    findings, _ = _actual_findings(scan)
    unique_cves = {finding.vulnerability_id for finding in findings}
    print(
        "container vulnerability gate passed: "
        f"0 fixable/unreviewed high-critical; {len(findings)} package findings "
        f"across {len(unique_cves)} explicitly reviewed unfixed CVEs"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
