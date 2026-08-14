"""AUDIT-072: the two commands that own the abstention threshold cannot run on any install.

Found on a rented host after the PDF lifecycle finally worked and the first adversarial recall was
asked. `brain calibrate` and `brain eval` both exited 2 with **zero output**, while `brain verify`
returned real JSON from the same container — so the CLI harness was fine and these two were not.

The cause is a development-time assumption in a shipped command: the calibration set is resolved
through a path relative to the current working directory, pointing into the source repo
(`evals/golden.yaml`), and `evals` is deliberately not part of the distributed package
(`packages = ["src/rsc_brain"]`). In a container, in a pip install, under Helm — anywhere that is
not a git checkout — the file cannot exist.

Why it matters beyond two broken commands: SPEC-06 D2 makes tau "calibrable por instalacion con
`brain calibrate`", and the measurement on the host shows calibration is not optional. With the
shipped default the relevance-independent terms of the score supply 0.324 of tau=0.45, leaving an
effective similarity floor of 0.230 — below the embedder's own noise. Measured against the ingested
corpus: a relevant question scored 0.723 similarity, unrelated English 0.219, and pure gibberish
("zxqwv plorbnat frimble") 0.304. The gate separates sense from nonsense by hundredths on a quantity
whose noise is tenths.

So the product's central promise — abstain and ask a human instead of answering from irrelevant
knowledge — depends on a per-install step that no install can perform, and that no install document
mentions.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from rsc_brain.cli.main import app

REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "src" / "rsc_brain" / "cli" / "installer.py"


@pytest.fixture
def outside_a_checkout(tmp_path: Path) -> object:
    """Run from a directory with no `evals/`, which is every real install."""
    previous = Path.cwd()
    os.chdir(tmp_path)
    yield tmp_path
    os.chdir(previous)


@pytest.mark.parametrize("command", ["calibrate", "eval"])
def test_a_missing_calibration_set_is_explained_not_signalled_by_an_exit_code(
    command: str, outside_a_checkout: Path
) -> None:
    """The observed behaviour on the host: exit 2 and not one character, on both commands, while
    `brain verify --json` in the same container returned normal JSON.

    A bare `raise typer.Exit(code=2)` tells the operator nothing — the same silence AUDIT-065 and
    AUDIT-068 removed one layer up. Every other refusal in this CLI echoes a reason first."""
    result = CliRunner().invoke(app, [command])
    assert result.exit_code == 2, "a missing calibration set must still be a failure"
    combined = (result.output or "") + (result.stderr or "")
    assert combined.strip(), f"brain {command} failed without saying anything"
    assert "calibration set" in combined, "the refusal does not name what is missing"
    assert "--golden" in combined, "the refusal does not say how to supply one"


def test_an_install_can_point_at_its_own_calibration_set(outside_a_checkout: Path) -> None:
    """Calibration has to run against the operator's OWN corpus. The repository's golden set
    describes two fictional companies: calibrating τ against it would hand an operator a confidently
    wrong threshold for their knowledge, which is worse than an honest refusal. So the route to a
    runnable command is letting an install supply its set — not shipping ours as the default."""
    golden = outside_a_checkout / "mine.yaml"
    golden.write_text(
        "cases:\n"
        "  - family: hit\n    question: who owns payroll?\n    must_find: true\n"
        "  - family: abstain\n    question: what is the capital of Mars?\n    must_find: false\n",
        encoding="utf-8",
    )
    result = CliRunner().invoke(app, ["calibrate", "--golden", str(golden), "--json"])
    assert result.exit_code == 0, f"a supplied calibration set was refused: {result.output}"
    assert '"total": 2' in result.output, result.output


def test_the_calibration_set_is_not_resolved_only_relative_to_the_working_directory() -> None:
    """`Path("evals/golden.yaml")` resolves against the process's cwd, pointing into the source repo
    — and `evals` is not part of the distributed package. Keeping it as ONE candidate preserves the
    developer-checkout convenience; being the only one is what made the command unrunnable
    everywhere else, so an install location must also be searched."""
    source = INSTALLER.read_text(encoding="utf-8")
    assert "AUDIT-072" in source, "the resolution path carries no record of why it changed"
    candidates = source[source.index("_GOLDEN_CANDIDATES") :]
    candidates = candidates[: candidates.index("\n\n")]
    assert any(c in candidates for c in ("/etc/", "/var/")), (
        "no installed location is searched, so the command still only works from a checkout"
    )


def test_the_install_path_tells_the_operator_to_calibrate() -> None:
    """Zero mentions of `calibrate`, `brain eval` or tau across INSTALL.md, deploy/README.md and
    README.md when this was found. An operator installs, ingests, asks a question outside their
    corpus, and gets a confident answer assembled from credible but irrelevant knowledge — with
    nothing anywhere having told them a calibration step exists."""
    install = (REPO / "docs" / "INSTALL.md").read_text(encoding="utf-8")
    assert "calibrate" in install, (
        "the install path never mentions the calibration the abstention threshold depends on"
    )
