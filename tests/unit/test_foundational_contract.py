"""AUDIT-009: foundational artifacts and live evidence are one enforceable contract."""

from __future__ import annotations

import shutil
from pathlib import Path

import yaml
from evals.schema import FoundationalCaseResult, FoundationalEvidence
from evals.validate import (
    EVALS,
    REPO,
    check_foundational_quality,
    foundational_fingerprint,
    foundational_status,
    load_artifact_manifest,
    validate_artifact_manifest,
    validate_live_evidence,
)


def _contract_copy(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    for relative in (
        Path("src/rsc_brain/prompts"),
        Path("src/rsc_brain/hunting/templates"),
    ):
        shutil.copytree(REPO / relative, repo / relative)
    (repo / "evals").mkdir(parents=True)
    for name in (
        "foundational_manifest.yaml",
        "foundational_quality.yaml",
        "documents.yaml",
        "taxonomy.yaml",
    ):
        shutil.copy2(EVALS / name, repo / "evals" / name)
    return repo


def _passing_evidence(repo: Path) -> FoundationalEvidence:
    manifest = load_artifact_manifest(repo / "evals" / "foundational_manifest.yaml")
    quality = yaml.safe_load((repo / "evals/foundational_quality.yaml").read_text(encoding="utf-8"))
    corpus = yaml.safe_load((repo / "evals/documents.yaml").read_text(encoding="utf-8"))
    kinds = {document["id"]: document["kind"] for document in corpus["documents"]}
    prompt_versions = {
        artifact.id: artifact.version
        for artifact in manifest.artifacts
        if artifact.kind == "prompt" and artifact.foundational
    }
    return FoundationalEvidence(
        schema_version=1,
        run_at="2026-08-21T01:00:00Z",
        provider="ollama",
        model="gemma4:12b",
        model_digest="0" * 64,
        content_fingerprint=foundational_fingerprint(repo),
        prompt_versions=prompt_versions,
        sample_size=10,
        extraction_attempts=9,
        extraction_discards=0,
        discard_rate=0.0,
        quality_cases_passed=10,
        quality_cases_total=10,
        semantic_review="assisted",
        semantic_reviewed=True,
        results=tuple(
            FoundationalCaseResult(
                case_id=case["id"],
                document_id=case["document_id"],
                extraction_attempted=kinds[case["document_id"]] != "table",
                discarded=False,
                tags=tuple(case["required_tags"]),
                graph_terms=tuple(case["required_graph_terms"]),
                missing_tags=(),
                missing_graph_terms=(),
                forbidden_graph_terms_present=(),
                passed=True,
            )
            for case in quality["cases"]
        ),
    )


def test_manifest_covers_every_current_prompt_and_template() -> None:
    manifest = load_artifact_manifest()

    assert len(manifest.artifacts) == 15
    assert sum(a.foundational for a in manifest.artifacts if a.kind == "prompt") == 5
    assert sum(a.foundational for a in manifest.artifacts if a.kind == "template") == 8
    assert validate_artifact_manifest() == []


def test_live_quality_sample_is_stratified_and_referentially_valid() -> None:
    assert check_foundational_quality() == []


def test_unmanifested_artifact_names_the_orphan(tmp_path: Path) -> None:
    repo = _contract_copy(tmp_path)
    orphan = repo / "src/rsc_brain/prompts/untracked.v1.md"
    orphan.write_text("---\nid: untracked\nversion: v1\nrole: test\n---\n", encoding="utf-8")

    errors = validate_artifact_manifest(repo=repo)

    assert any("orphan artifact" in error and "untracked.v1.md" in error for error in errors)


def test_frontmatter_must_match_manifest_identity(tmp_path: Path) -> None:
    repo = _contract_copy(tmp_path)
    prompt = repo / "src/rsc_brain/prompts/extractor_entities.v1.md"
    prompt.write_text(
        prompt.read_text(encoding="utf-8").replace("version: v1", "version: v9"),
        encoding="utf-8",
    )

    errors = validate_artifact_manifest(repo=repo)

    assert any("extractor_entities.v1.md" in error and "version" in error for error in errors)


def test_duplicate_manifest_identity_is_rejected(tmp_path: Path) -> None:
    repo = _contract_copy(tmp_path)
    path = repo / "evals/foundational_manifest.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    duplicate = dict(raw["artifacts"][0])
    duplicate["path"] = raw["artifacts"][1]["path"]
    raw["artifacts"][1] = duplicate
    path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")

    errors = validate_artifact_manifest(repo=repo)

    assert any("duplicate artifact identity" in error for error in errors)


def test_structural_only_success_never_claims_overall_completion() -> None:
    status = foundational_status(structural_only=True)

    assert status.structure_passed is True
    assert status.live_evidence_passed is False
    assert status.overall_complete is False
    assert "structural" in status.summary.lower()
    assert "complete" not in status.summary.lower()


def test_shipped_live_evidence_closes_both_status_axes() -> None:
    status = foundational_status()

    assert status.structure_passed is True
    assert status.live_evidence_passed is True
    assert status.overall_complete is True
    assert status.structure_errors == ()
    assert status.live_evidence_errors == ()


def test_changed_prompt_invalidates_previously_passing_evidence(tmp_path: Path) -> None:
    repo = _contract_copy(tmp_path)
    evidence = _passing_evidence(repo)
    assert validate_live_evidence(evidence, repo=repo) == []

    prompt = repo / "src/rsc_brain/prompts/extractor_claims.v1.md"
    prompt.write_text(prompt.read_text(encoding="utf-8") + "\n<!-- changed -->\n", encoding="utf-8")

    errors = validate_live_evidence(evidence, repo=repo)
    assert any("stale" in error and "fingerprint" in error for error in errors)


def test_live_evidence_recomputes_semantic_deltas_instead_of_trusting_them(tmp_path: Path) -> None:
    repo = _contract_copy(tmp_path)
    evidence = _passing_evidence(repo)
    first = evidence.results[0].model_copy(
        update={"graph_terms": (), "missing_graph_terms": (), "passed": True}
    )
    forged = evidence.model_copy(update={"results": (first, *evidence.results[1:])})

    errors = validate_live_evidence(forged, repo=repo)

    assert any("recorded semantic deltas" in error for error in errors)
