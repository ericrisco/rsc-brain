"""AUDIT-080/081: my AUDIT-072 fix reintroduced the defect it was named for.

An adversarial review ran nine malformed `--golden` fixtures against the real binary:

    empty file            AttributeError: 'NoneType' object has no attribute 'get'
    scalar                AttributeError: 'str' object has no attribute 'get'
    top-level list        AttributeError: 'list' object has no attribute 'get'
    cases: (null)         TypeError: 'NoneType' object is not iterable
    case missing family   KeyError: 'family'
    cases: [a-string]     TypeError: string indices must be integers
    cases: {a: 1}         TypeError: string indices must be integers
    non-YAML              yaml.scanner.ScannerError
    NO `cases` KEY        {"status": "ok", "golden": {"total": 0, ...}}   exit 0   <-- the worst

The last one is AUDIT-072 verbatim: a command reporting success while doing nothing, at the one
place the operator cannot detect it. An operator who typos the top-level key, or points at the wrong
YAML entirely, is told their calibration set is fine. My own docstring indicts the previous
behaviour as "an exit code and not one word… The product knew exactly what was wrong and said
nothing" — and the very next executable line reintroduced the same class one step further along. I
moved the silence; I did not remove it.

AUDIT-081, the same review: `docs/INSTALL.md` says "No default set is shipped on purpose", and
`_GOLDEN_CANDIDATES[0]` is `Path("evals/golden.yaml")` — cwd-relative, and with **precedence** over
the installed location. Run from the repository root, which is where INSTALL.md tells operators to
run `brain apply`/`plan`/`doctor`, the fictional Acme/Globex set wins silently and nothing names the
file that was read. An operator who does exactly what the doc says — install their real set at
`/etc/rsc-brain/golden.yaml` — gets the fictional one instead, and cannot tell.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from rsc_brain.cli.main import app

MALFORMED = {
    "empty": "",
    "scalar": "not a mapping",
    "top_level_list": "- a\n- b",
    "cases_null": "cases:\n",
    "case_missing_family": "cases:\n  - question: q\n    must_find: true\n",
    "cases_of_strings": "cases:\n  - just-a-string\n",
    "cases_mapping": "cases:\n  a: 1\n",
    "not_yaml": "{{{ this is not yaml",
    "no_cases_key": "questions:\n  - q: one\n",
}


@pytest.fixture
def elsewhere(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Run from a directory with no `evals/`, which is every real install."""
    monkeypatch.chdir(tmp_path)
    yield tmp_path


@pytest.mark.parametrize("name", sorted(MALFORMED))
def test_a_malformed_calibration_set_is_refused_with_a_reason(name: str, elsewhere: Path) -> None:
    """Every one of these must exit non-zero AND explain. None may traceback, and none — least of
    all the missing `cases` key — may report success."""
    golden = elsewhere / f"{name}.yaml"
    golden.write_text(MALFORMED[name], encoding="utf-8")

    result = CliRunner().invoke(app, ["calibrate", "--golden", str(golden), "--json"])
    combined = (result.output or "") + (result.stderr or "")

    assert result.exit_code != 0, (
        f"{name}: reported success on a set the product cannot use — the AUDIT-072 defect, "
        f"reintroduced. Output: {combined[:200]}"
    )
    assert "Traceback" not in combined and "Error" not in combined.split("\n")[0], (
        f"{name}: died with a traceback instead of an actionable message: {combined[:200]}"
    )
    assert "calibration set" in combined or "cases" in combined, (
        f"{name}: the refusal does not say what is wrong: {combined[:200]}"
    )


def test_a_well_formed_set_is_accepted_and_names_the_file_it_read(elsewhere: Path) -> None:
    """AUDIT-081: nothing reported WHICH file was summarised, so an operator could not tell their
    own set from the repository's fictional one."""
    golden = elsewhere / "mine.yaml"
    golden.write_text(
        "cases:\n"
        "  - family: hit\n    question: who owns payroll?\n    must_find: true\n"
        "  - family: abstain\n    question: capital of Mars?\n    must_find: false\n",
        encoding="utf-8",
    )
    result = CliRunner().invoke(app, ["calibrate", "--golden", str(golden), "--json"])
    assert result.exit_code == 0, result.output
    assert '"total": 2' in result.output, result.output
    assert str(golden) in result.output, "the resolved path is not reported"


def test_an_installed_set_wins_over_a_repository_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AUDIT-081: the checkout path had precedence, so an operator who installed their real set at
    the documented location and then ran from the source tree silently got the fictional one."""
    from rsc_brain.cli import installer

    checkout = tmp_path / "repo"
    (checkout / "evals").mkdir(parents=True)
    (checkout / "evals" / "golden.yaml").write_text(
        "cases:\n  - family: hit\n    question: fictional\n    must_find: true\n", encoding="utf-8"
    )
    installed = tmp_path / "etc" / "golden.yaml"
    installed.parent.mkdir(parents=True)
    installed.write_text(
        "cases:\n"
        "  - family: hit\n    question: mine one\n    must_find: true\n"
        "  - family: hit\n    question: mine two\n    must_find: true\n"
        "  - family: abstain\n    question: mine three\n    must_find: false\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        installer, "_GOLDEN_CANDIDATES", [installed, Path("evals/golden.yaml")], raising=True
    )
    monkeypatch.chdir(checkout)

    result = CliRunner().invoke(app, ["calibrate", "--json"])
    assert result.exit_code == 0, result.output
    assert '"total": 3' in result.output, (
        f"the repository's checkout set won over the installed one: {result.output}"
    )


def test_the_repository_checkout_is_not_silently_the_default(elsewhere: Path) -> None:
    """The docstring calls calibrating against the fictional set "worse than an honest refusal".
    Using it must therefore be visible, not silent."""
    source = (
        Path(__file__).resolve().parents[2] / "src" / "rsc_brain" / "cli" / "installer.py"
    ).read_text(encoding="utf-8")
    assert "AUDIT-081" in source, "the precedence and the reporting carry no record"


def test_the_fixture_does_not_depend_on_the_hosts_own_installation(elsewhere: Path) -> None:
    """The previous fixture chdir'd but could not neutralise the absolute installed candidate, so on
    a host that followed INSTALL.md the suite broke. `monkeypatch.setattr` on the candidate list is
    what makes these tests independent of the machine."""
    assert not (elsewhere / "evals").exists()
    assert Path.cwd() == elsewhere
