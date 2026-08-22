"""The gate instrument can be pointed at a corpus the maintainer never saw (AUDIT-138).

Every gate number this product publishes — G2 zero leaks, G3 the contradiction judge, G4 abstention —
was measured over 27 fictional documents and 53 cases written by one person, and the honest defence
was that the *shape* of the failures generalizes, not the numbers. That defence was load-bearing
because nobody else could run the instrument: `gate_run` resolved every corpus file against its own
directory. A company installing this could not ask "does it abstain on OUR documents?" using the
measurement the maintainer quotes.

AUDIT-136 hit the same wall from the other side: the held-out calibration split it needed is
corpus-limited, because 27 documents hold two temporal pairs and the golden set already mines them. A
bigger corpus is exactly what an operator has and the maintainer does not.

These tests hold the three properties that make aiming safe: the files really come from elsewhere, a
corpus that cannot support a gate is refused *before* anything is created, and the document map
follows the corpus rather than the checkout — because a map that stayed behind would compare a second
corpus's expectations against the first one's UUIDs, which is AUDIT-119's defect with an extra step.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from evals import gate_run
from evals.schema import Golden


@pytest.fixture(autouse=True)
def _restore_root() -> Iterator[None]:
    """`use_corpus` moves module state; a leaked root would aim every later test at a tmp dir."""
    original = gate_run.corpus_root()
    yield
    gate_run._corpus_root = original


def _corpus(directory: Path) -> Path:
    """A complete corpus directory, copied from the repository's own."""
    directory.mkdir(parents=True, exist_ok=True)
    for name in gate_run.REQUIRED_CORPUS_FILES:
        shutil.copy2(gate_run.EVALS / name, directory / name)
    return directory


def test_the_default_corpus_did_not_move() -> None:
    """AC4. Every published number refers to this directory; a moved default would silently rebase
    all of them onto whatever a test last pointed at."""
    assert gate_run.corpus_root() == gate_run.EVALS
    assert gate_run.state_path() == gate_run.EVALS / ".gate_run_state.json"


def test_every_corpus_read_comes_from_the_named_directory(tmp_path: Path) -> None:
    """AC1. Asserted by changing the content, not by inspecting a path: a corpus loader that resolved
    the directory and then read the repository's file anyway would satisfy a path check."""
    elsewhere = _corpus(tmp_path / "their-corpus")
    golden = (elsewhere / "golden.yaml").read_text(encoding="utf-8")
    trimmed = golden[: golden.index("  # --- family: abstain")]
    (elsewhere / "golden.yaml").write_text(trimmed, encoding="utf-8")

    assert gate_run.use_corpus(elsewhere) == elsewhere
    assert gate_run.corpus_root() == elsewhere
    theirs = gate_run._load(Golden, "golden.yaml")
    assert len(theirs.cases) == 12, (
        "the 12 `hit` cases of the trimmed copy, not the repository's 53"
    )
    assert {case.family for case in theirs.cases} == {"hit"}
    # `_users` reads its own path rather than going through `_load`; it has to move too.
    (elsewhere / "users.yaml").write_text(
        "users:\n  solo:\n    project: theirs\n    allowed_topics: [all]\n    can_curate: false\n",
        encoding="utf-8",
    )
    assert list(gate_run._users()) == ["solo"]


def test_an_incomplete_corpus_is_refused_before_anything_runs(tmp_path: Path) -> None:
    """AC2. Refusing late is expensive: a phase that discovers this mid-ingestion has already created
    principals and half a corpus, and the operator cleans up after a tool that knew in advance."""
    partial = _corpus(tmp_path / "partial")
    (partial / "contradictions.yaml").unlink()
    (partial / "taxonomy.yaml").unlink()

    with pytest.raises(SystemExit) as raised:
        gate_run.use_corpus(partial)

    message = str(raised.value)
    assert "contradictions.yaml" in message and "taxonomy.yaml" in message
    assert str(partial) in message, "name the directory; an operator may have several"
    assert str(gate_run.EVALS) in message, "point at the reference set"
    assert gate_run.corpus_root() == gate_run.EVALS, "a refused corpus must not become the root"


def test_a_path_that_is_not_a_directory_is_refused(tmp_path: Path) -> None:
    manifest = tmp_path / "corpus.yaml"
    manifest.write_text("cases: []\n", encoding="utf-8")

    with pytest.raises(SystemExit) as raised:
        gate_run.use_corpus(manifest)

    assert "not a directory" in str(raised.value)


def test_the_document_map_follows_the_corpus(tmp_path: Path) -> None:
    """AC3. Two corpora, two maps. Sharing one would compare a second corpus's `document_id`
    expectations against the first's UUIDs — reported as a product failure, which is AUDIT-119."""
    first = _corpus(tmp_path / "first")
    second = _corpus(tmp_path / "second")

    gate_run.use_corpus(first)
    first_state = gate_run.state_path()
    gate_run.use_corpus(second)
    second_state = gate_run.state_path()

    assert first_state == first / ".gate_run_state.json"
    assert second_state == second / ".gate_run_state.json"
    assert first_state != second_state
    assert gate_run.EVALS not in second_state.parents


def test_the_phase_argument_aims_the_instrument_and_says_so(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wiring, end to end through `main`, with the one phase that needs no corpus and no database.

    The printed line is not decoration. AUDIT-081's rule: which corpus produced a number is the first
    thing a reader of that number needs, and silence is the cheapest way to lose it.
    """
    elsewhere = _corpus(tmp_path / "theirs")
    seen: list[Path] = []

    async def _fake_g3() -> int:
        seen.append(gate_run.corpus_root())
        return 0

    monkeypatch.setattr(gate_run, "_g3", _fake_g3)
    assert gate_run.main(["g3", "--corpus", str(elsewhere)]) == 0
    assert seen == [elsewhere], "the phase ran with the aimed root, not the repository's"
    assert f"corpus: {elsewhere}" in capsys.readouterr().out


def test_omitting_the_argument_changes_nothing(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC4 again, through `main`: the default path must stay silent and stay put."""
    seen: list[Path] = []

    async def _fake_g3() -> int:
        seen.append(gate_run.corpus_root())
        return 0

    monkeypatch.setattr(gate_run, "_g3", _fake_g3)
    assert gate_run.main(["g3"]) == 0
    assert seen == [gate_run.EVALS]
    assert "corpus:" not in capsys.readouterr().out
