"""A generated first-admin credential must never reach output or logs (AUDIT-034 / R13, T003 RED).

``brain init`` prints the generated password on stdout and puts it in the JSON payload
(``cli/installer.py``: ``payload["admin_password"] = generated`` and ``f"(generated password:
{generated})"``). That command is the migrate-on-boot one-shot, so its stdout IS the ``migrate``
service log — and ``deploy/README.md`` documents reading the credential from there as the intended
delivery. Ratified outcome (AUDIT-034 acceptance): *when application logs, lifecycle logs, rendered
notes, long-running environments, and CI artifacts are scanned, then no credential value appears.*

The safe delivery already exists in the product, on the Helm path: the chart generates the password
into a Secret and ``NOTES.txt`` tells the operator where to read it, printing only the location. That
is the shape the compose/CLI path has to follow, which is why the guard below also asserts NOTES does
not regress into printing the value itself.

What this file does NOT assert: which mechanism the CLI should use to hand the operator a generated
credential (a mode-0600 file in a declared volume, refusing to generate at all and requiring
``--admin-password``, …). Asserting against an API that does not exist yet would fail on import
rather than on behaviour, which proves nothing. That choice belongs to T005; the invariant here is
that the value is absent from every ordinary channel.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from rsc_brain.cli.main import app

SENTINEL = "sentinel-generated-credential-9f3a1c"

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def bootstrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run ``brain init`` with the database work stubbed, so only its OUTPUT is under test."""
    import rsc_brain.deploy.bootstrap as bootstrap_mod
    import rsc_brain.stores.relational.database as database_mod
    import rsc_brain.stores.relational.migrations as migrations_mod

    async def _fake_ensure_first_admin(*_args: Any, **kwargs: Any) -> bootstrap_mod.AdminBootstrap:
        return bootstrap_mod.AdminBootstrap(
            email=kwargs.get("email") or "admin@rsc-brain.local",
            created=True,
            generated_password=SENTINEL,
        )

    class _Engine:
        async def dispose(self) -> None:
            return None

    monkeypatch.setattr(bootstrap_mod, "ensure_first_admin", _fake_ensure_first_admin)
    monkeypatch.setattr(migrations_mod, "upgrade_to_head", lambda: None)
    monkeypatch.setattr(database_mod, "make_engine", lambda *a, **k: _Engine())
    monkeypatch.setattr(database_mod, "make_sessionmaker", lambda *a, **k: None)


def test_the_human_output_does_not_contain_the_generated_credential(bootstrapped: None) -> None:
    result = CliRunner().invoke(app, ["init"])
    assert result.exit_code == 0, result.output
    assert SENTINEL not in result.output, (
        "`brain init` printed the generated first-admin password; this command is the "
        "migrate-on-boot one-shot, so its stdout is the migrate service's log"
    )


def test_the_json_output_does_not_contain_the_generated_credential(bootstrapped: None) -> None:
    result = CliRunner().invoke(app, ["--json", "init"])
    assert result.exit_code == 0, result.output
    assert SENTINEL not in result.output, (
        "the JSON payload carries the generated password, so it lands in CI artifacts and "
        "lifecycle logs verbatim"
    )


def test_the_operator_is_still_told_where_to_obtain_it(bootstrapped: None) -> None:
    """Absence must not mean silence: a fresh install whose password is unobtainable is unusable.

    The output has to say the admin was created and point at the retrieval path, without carrying the
    value — exactly what the Helm NOTES already does.
    """
    result = CliRunner().invoke(app, ["init"])
    assert result.exit_code == 0, result.output
    lowered = result.output.lower()
    assert "admin" in lowered
    assert any(word in lowered for word in ("retrieve", "secret", "stored", "file", "obtain")), (
        f"the output neither carries the credential nor says how to obtain it: {result.output!r}"
    )


def test_the_deploy_guide_does_not_send_operators_to_the_service_log() -> None:
    """Documentation is part of the contract: telling operators to read it from the logs makes the
    leak the supported procedure, so the guide has to change with the behaviour."""
    guide = (REPO_ROOT / "deploy" / "README.md").read_text(encoding="utf-8")
    # Looks for the INSTRUCTION, not for the two words appearing together: a sentence saying the
    # credential is never in the log is exactly what the fixed guide should contain, and a heuristic
    # that flags it would push the documentation back towards silence.
    log_phrases = ("logs ", "in the logs", "service log", "log output")
    offending = [
        line.strip()
        for line in guide.splitlines()
        if "password" in line.lower()
        and any(phrase in line.lower() for phrase in log_phrases)
        and "never" not in line.lower()
    ]
    assert not offending, (
        f"deploy/README.md documents the credential leak as the delivery mechanism: {offending}"
    )


def test_the_helm_notes_point_at_the_secret_without_printing_the_value() -> None:
    """Guard on the path that is already right: NOTES must keep printing the LOCATION only.

    Without this, 'make the CLI stop printing it' could be 'fixed' in the other direction by having
    the chart render the value into release notes, which are stored and shared.
    """
    notes = (REPO_ROOT / "deploy" / "helm" / "rsc-brain" / "templates" / "NOTES.txt").read_text(
        encoding="utf-8"
    )
    assert "kubectl" in notes and "jsonpath" in notes, (
        "NOTES no longer tells the operator how to retrieve the credential from the Secret"
    )
    assert "{{ .Values.admin.password }}" not in notes, "NOTES renders the credential value itself"
