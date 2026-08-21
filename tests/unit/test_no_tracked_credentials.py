"""No tracked file may carry a credential (constitution §3.10, AUDIT-116).

A gate-run state file containing four live personal access tokens was committed and pushed. The
gitleaks job passed: its rules did not recognise this product's own token prefixes, so the one check
whose whole job is to catch this could not. A scanner that does not know your credential formats is
a scanner for somebody else's secrets.

This check knows them, because they are defined in this repository.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
#: The product's own credential prefixes, as issued by `rsc_brain.identity`, followed by a body that
#: looks generated rather than written: `ck_` is also SQLAlchemy's CHECK-constraint naming prefix, so
#: requiring both an upper-case letter and a digit separates `ck_claims_credibility_range` from
#: `ck_Eaw3nQ…`. A token with neither would be a token with almost no entropy.
CREDENTIAL_PATTERN = re.compile(
    r"\b(ck_|cks_|hunt_)(?=[A-Za-z0-9_-]{16,})(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])"
    r"[A-Za-z0-9_-]{16,}"
)
#: Text files only; a binary fixture cannot be scanned this way and none is expected to hold one.
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf", ".ico", ".woff", ".woff2", ".gz", ".zip"}


def _tracked_files() -> list[Path]:
    listing = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [REPO / name for name in listing.stdout.split("\0") if name]


def test_no_tracked_file_contains_an_issued_credential() -> None:
    offenders: list[str] = []
    for path in _tracked_files():
        if path.suffix.lower() in SKIP_SUFFIXES or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for match in CREDENTIAL_PATTERN.finditer(text):
            # This file necessarily contains the pattern it searches for.
            if path.name == Path(__file__).name:
                continue
            offenders.append(f"{path.relative_to(REPO).as_posix()}: {match.group(1)}…")

    assert not offenders, f"tracked files carry issued credentials: {offenders}"
