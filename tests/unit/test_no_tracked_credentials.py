"""No tracked file may carry a credential (constitution §3.10, AUDIT-116, AUDIT-142).

A gate-run state file containing four live personal access tokens was committed and pushed. The
gitleaks job passed: its rules did not recognise this product's own token prefixes, so the one check
whose whole job is to catch this could not. A scanner that does not know your credential formats is
a scanner for somebody else's secrets.

This check knows them, because they are defined in this repository.

AUDIT-142 found the sentence above was half true. It knew the *token* prefixes and not the other
credential this same repository defines: the first-admin password, written by
`bootstrap.store_generated_credential` as `email:` then `password: <token_urlsafe(24)>` into a file
whose name is a constant here. One such file was tracked in this PUBLIC repository from 2026-07-25,
past gitleaks AND past this test. The data directory it lives in was not ignored either, so any local
run left it one `git add -A` from being committed — which is how 39 generated blobs followed it in.

So the checks below now cover three things rather than one: the issued token formats, the generated
password format, and the directory the product writes private state into. All three are read from the
product rather than copied, because a guard that restates a literal stops tracking what it guards.
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


#: The exact shape `bootstrap.store_generated_credential` writes. Anchored per line so a prose
#: mention of the word cannot trip it, and length-bounded so `password: changeme` in an example does
#: not either — this looks for a generated value, which is what a leak is made of.
GENERATED_PASSWORD_PATTERN = re.compile(r"^password:[ \t]*[A-Za-z0-9_-]{20,}[ \t]*$", re.MULTILINE)


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


def test_no_tracked_file_is_a_generated_first_admin_credential() -> None:
    """By NAME, taken from the product's own constant rather than a copied string.

    `brain init` writes this file when it generates a password. Its name is not a coincidence and not
    a guess: `CREDENTIAL_FILENAME` is defined in `rsc_brain.deploy.bootstrap`, so if the product ever
    renames it, this guard follows instead of quietly passing.
    """
    from rsc_brain.deploy.bootstrap import CREDENTIAL_FILENAME

    offenders = [
        path.relative_to(REPO).as_posix()
        for path in _tracked_files()
        if path.name == CREDENTIAL_FILENAME
    ]

    assert not offenders, (
        f"a generated first-admin credential is tracked: {offenders}. This is the file AUDIT-142 "
        "found published; the data directory is ignored now, so a new one means the ignore was lost."
    )


def test_no_tracked_file_carries_a_generated_password() -> None:
    """And by CONTENT, because the next one may not be called that."""
    offenders: list[str] = []
    for path in _tracked_files():
        if path.suffix.lower() in SKIP_SUFFIXES or not path.is_file():
            continue
        if path.name == Path(__file__).name:
            continue  # this file necessarily contains the pattern it searches for
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if GENERATED_PASSWORD_PATTERN.search(text):
            offenders.append(path.relative_to(REPO).as_posix())

    assert not offenders, f"tracked files carry a generated password: {offenders}"


def test_the_products_private_state_directory_is_not_tracked() -> None:
    """Nothing under the ingest data directory belongs in the repository.

    It holds parsed document blobs and the generated credential. The directory name comes from the
    config default, so this follows a rename too. Both classes of file were tracked before AUDIT-142:
    39 blobs and one credential.
    """
    from rsc_brain.config.models import IngestConfig

    data_dir = IngestConfig().data_dir
    offenders = [
        path.relative_to(REPO).as_posix()
        for path in _tracked_files()
        if path.relative_to(REPO).as_posix().startswith(f"{data_dir}/")
    ]

    assert not offenders, (
        f"{len(offenders)} file(s) under {data_dir}/ are tracked: {offenders[:5]}"
        + (" …" if len(offenders) > 5 else "")
    )


def test_the_scanner_knows_the_generated_password_format() -> None:
    """gitleaks runs over the full history on every push, and it did not recognise this format.

    Asserted against the config rather than by running the scanner: the binary is pinned and fetched in
    CI, and a unit test that shells out to it would either be skipped locally or lie. What matters here
    is that the rule exists and carries the id the historical fingerprint is bound to — remove either
    and the pair silently stops meaning anything.
    """
    import tomllib

    config = tomllib.loads((REPO / ".gitleaks.toml").read_text(encoding="utf-8"))
    rules = {rule["id"]: rule for rule in config.get("rules", [])}

    assert "rsc-brain-generated-password" in rules, (
        "the default rules do not recognise this product's generated password; AUDIT-142 is what "
        "happens when the scanner only knows somebody else's secrets"
    )
    pattern = re.compile(rules["rsc-brain-generated-password"]["regex"])
    assert pattern.search("password: xj3Kd9_pQm2LrTn8Vb4Zs1Ay"), (
        "the rule must match what it exists for"
    )
    assert not pattern.search("password: changeme"), "and not a documentation placeholder"

    # The fingerprint itself, not a mention of the rule id: the comment above it names the rule too,
    # and a test satisfied by prose is a test that passes when the line is deleted.
    fingerprints = {
        line.strip()
        for line in (REPO / ".gitleaksignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert any(
        entry.endswith(":rsc-brain-generated-password:2") and "data/first-admin-credential" in entry
        for entry in fingerprints
    ), (
        "the one already-published occurrence is recorded as a commit:path:rule:line fingerprint, or "
        "CI fails forever on a commit nobody can change without a history rewrite"
    )


def test_the_private_state_directory_is_ignored_and_not_only_untracked() -> None:
    """Untracking without ignoring is half a fix: the next `git add -A` puts it straight back.

    That is not hypothetical — it is how the 39 blobs arrived after the credential, and it happened
    once more while fixing AUDIT-141, which is what led here.
    """
    from rsc_brain.config.models import IngestConfig

    probe = f"{IngestConfig().data_dir}/first-admin-credential"
    result = subprocess.run(
        ["git", "-C", str(REPO), "check-ignore", "-q", "--no-index", probe],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, (
        f"{probe} is not ignored (git check-ignore exited {result.returncode}: "
        f"{result.stderr.strip() or 'no match'}). Exit 1 means no ignore rule matches; anything else "
        "means the check itself failed and proves nothing either way."
    )
