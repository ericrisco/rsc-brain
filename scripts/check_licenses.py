#!/usr/bin/env python3
"""Fail if any installed dependency uses a license incompatible with AGPL-3.0 distribution.

Reads pip-licenses' JSON output. The denylist is a conservative set of source-available /
proprietary license families that genuinely cannot be redistributed inside an AGPL-3.0 work.
It matches unambiguous substrings only, so it never false-positives on GPL/LGPL/AGPL/MIT/etc.
Run: ``uv run python scripts/check_licenses.py`` (NFR-10 license audit).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

# Unambiguous, genuinely AGPL-incompatible license families (lower-case substrings).
DENYLIST: tuple[str, ...] = (
    "sspl",
    "server side public",
    "business source",
    "busl",
    "commons clause",
    "elastic license",
    "proprietary",
    "unlicensed",
)


def _pip_licenses_exe() -> str:
    # Prefer PATH, but fall back to the console script beside the active interpreter so this
    # works under `uv run` and in CI regardless of PATH ordering.
    found = shutil.which("pip-licenses")
    if found:
        return found
    candidate = Path(sys.executable).parent / "pip-licenses"
    return str(candidate)


def main() -> int:
    result = subprocess.run(
        [_pip_licenses_exe(), "--format=json"],
        capture_output=True,
        text=True,
        check=True,
    )
    packages = json.loads(result.stdout)
    violations = [
        (pkg.get("Name"), pkg.get("License"))
        for pkg in packages
        if any(bad in str(pkg.get("License", "")).lower() for bad in DENYLIST)
    ]
    if violations:
        print("License audit FAILED — AGPL-incompatible dependencies:", file=sys.stderr)
        for name, license_name in violations:
            print(f"  - {name}: {license_name}", file=sys.stderr)
        return 1
    print(f"License audit OK: {len(packages)} packages, none AGPL-incompatible.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
