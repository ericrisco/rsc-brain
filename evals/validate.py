"""Validate the foundational content (SPEC-02).

Checks — per AUDIT-009 — the exact **paths** and **manifest completeness**, not just counts:
the five versioned prompts (with the AUDIT-008 untrusted-data block and ES+EN few-shot), the
eight hunting templates at the canonical `src/rsc_brain/hunting/templates/` path, the taxonomy,
and — when they exist (SPEC-02 increment 2) — the corpus, golden set, and contradiction pairs
against their schemas. Run: ``uv run python -m evals.validate``.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path, PurePosixPath
from typing import Any

import yaml
from pydantic import ValidationError

from evals.schema import (
    Contradictions,
    Corpus,
    FoundationalEvidence,
    FoundationalManifest,
    FoundationalQuality,
    FoundationalStatus,
    Golden,
    PromptInjectionSuite,
    Taxonomy,
)
from rsc_brain.ingest.prompt_injection import detect_prompt_injection

REPO = Path(__file__).resolve().parents[1]
PROMPTS_DIR = REPO / "src" / "rsc_brain" / "prompts"
TEMPLATES_DIR = REPO / "src" / "rsc_brain" / "hunting" / "templates"
EVALS = REPO / "evals"
MANIFEST = EVALS / "foundational_manifest.yaml"
QUALITY = EVALS / "foundational_quality.yaml"
EVIDENCE = EVALS / "foundational_evidence.yaml"

REQUIRED_PROMPTS = (
    "extractor_entities",
    "extractor_relations",
    "extractor_claims",
    "topicalizer",
    "contradiction_judge",
)
REQUIRED_TEMPLATES = tuple(
    f"{name}.{lang}.md"
    for name in ("consent", "question", "reminder", "thanks")
    for lang in ("en", "es")
)
REQUIRED_GOLDEN_FAMILIES = {
    "hit",
    "abstain",
    "denied",
    "cross_project",
    "exact_id",
    "temporal",
    "injection",
    "qualifier",
}


def _read_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def load_artifact_manifest(path: Path = MANIFEST) -> FoundationalManifest:
    """Load the typed, exhaustive prompt/template inventory."""
    return FoundationalManifest.model_validate(_read_yaml(path))


def load_quality_manifest(path: Path = QUALITY) -> FoundationalQuality:
    """Load the explicit live sample and its semantic expectations."""
    return FoundationalQuality.model_validate(_read_yaml(path))


def _frontmatter(path: Path) -> dict[str, Any]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("missing opening YAML frontmatter delimiter")
    try:
        closing = lines.index("---", 1)
    except ValueError:
        raise ValueError("missing closing YAML frontmatter delimiter") from None
    raw = yaml.safe_load("\n".join(lines[1:closing]))
    if not isinstance(raw, dict):
        raise ValueError("frontmatter must be a YAML mapping")
    return raw


def _expected_artifact_path(kind: str, artifact_id: str, version: str, language: str | None) -> str:
    if kind == "prompt":
        return f"src/rsc_brain/prompts/{artifact_id}.{version}.md"
    if language is None:
        return ""
    return f"src/rsc_brain/hunting/templates/{artifact_id}.{language}.md"


def validate_artifact_manifest(
    *, repo: Path = REPO, manifest_path: Path | None = None
) -> list[str]:
    """Prove bidirectional membership plus exact path/frontmatter identity."""
    path = manifest_path or repo / "evals" / "foundational_manifest.yaml"
    try:
        manifest = load_artifact_manifest(path)
    except (OSError, ValidationError, yaml.YAMLError) as exc:
        return [f"artifact manifest invalid: {path}: {exc}"]

    errors: list[str] = []
    paths: set[str] = set()
    identities: set[tuple[str, str, str, str | None]] = set()
    for artifact in manifest.artifacts:
        identity = (artifact.kind, artifact.id, artifact.version, artifact.language)
        if artifact.path in paths:
            errors.append(f"duplicate artifact path: {artifact.path}")
        paths.add(artifact.path)
        if identity in identities:
            errors.append(f"duplicate artifact identity: {identity}")
        identities.add(identity)

        relative = PurePosixPath(artifact.path)
        if relative.is_absolute() or ".." in relative.parts:
            errors.append(
                f"artifact path must be repository-relative and confined: {artifact.path}"
            )
            continue
        expected = _expected_artifact_path(
            artifact.kind, artifact.id, artifact.version, artifact.language
        )
        if artifact.path != expected:
            errors.append(
                f"artifact {identity} has non-canonical path {artifact.path}; expected {expected}"
            )

        artifact_path = repo / artifact.path
        if not artifact_path.is_file():
            errors.append(f"missing manifested artifact: {artifact.path}")
            continue
        try:
            header = _frontmatter(artifact_path)
        except (OSError, ValueError, yaml.YAMLError) as exc:
            errors.append(f"{artifact.path}: invalid frontmatter: {exc}")
            continue
        expected_header: dict[str, str] = {
            "id": artifact.id,
            "version": artifact.version,
            "role": artifact.role,
        }
        if artifact.kind == "template" and artifact.language is not None:
            expected_header["lang"] = artifact.language
        for key, expected_value in expected_header.items():
            actual = header.get(key)
            if actual != expected_value:
                errors.append(
                    f"{artifact.path}: frontmatter {key}={actual!r}; expected {expected_value!r}"
                )

    actual_paths = {
        item.relative_to(repo).as_posix()
        for root in (
            repo / "src" / "rsc_brain" / "prompts",
            repo / "src" / "rsc_brain" / "hunting" / "templates",
        )
        if root.is_dir()
        for item in root.rglob("*.md")
    }
    for orphan in sorted(actual_paths - paths):
        errors.append(f"orphan artifact not present in manifest: {orphan}")
    for absent in sorted(paths - actual_paths):
        if (repo / absent).is_file():
            errors.append(f"manifested artifact is outside canonical inventory roots: {absent}")

    required_prompts = {("prompt", name, "v1", None) for name in REQUIRED_PROMPTS}
    required_templates = {
        ("template", name, "v1", lang)
        for name in ("consent", "question", "reminder", "thanks")
        for lang in ("en", "es")
    }
    foundational = {
        (artifact.kind, artifact.id, artifact.version, artifact.language)
        for artifact in manifest.artifacts
        if artifact.foundational
    }
    for missing in sorted((required_prompts | required_templates) - foundational):
        errors.append(f"missing foundational artifact identity: {missing}")
    unexpected = foundational - required_prompts - required_templates
    for identity in sorted(unexpected):
        errors.append(f"unexpected foundational artifact identity: {identity}")
    return errors


def foundational_fingerprint(repo: Path = REPO) -> str:
    """Fingerprint every input whose change requires new live prompt evidence."""
    manifest_path = repo / "evals" / "foundational_manifest.yaml"
    manifest = load_artifact_manifest(manifest_path)
    relative_paths = {
        "evals/foundational_manifest.yaml",
        "evals/foundational_quality.yaml",
        "evals/documents.yaml",
        "evals/taxonomy.yaml",
        *(artifact.path for artifact in manifest.artifacts),
    }
    digest = hashlib.sha256()
    for relative in sorted(relative_paths):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update((repo / relative).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def validate_live_evidence(evidence: FoundationalEvidence, *, repo: Path = REPO) -> list[str]:
    """Validate live counts, semantic outcomes, prompt versions and freshness."""
    errors: list[str] = []
    manifest = load_artifact_manifest(repo / "evals" / "foundational_manifest.yaml")
    quality = load_quality_manifest(repo / "evals" / "foundational_quality.yaml")
    corpus = Corpus.model_validate(_read_yaml(repo / "evals" / "documents.yaml"))
    current_fingerprint = foundational_fingerprint(repo)
    if evidence.content_fingerprint != current_fingerprint:
        errors.append(
            "live evidence is stale: content fingerprint does not match the current artifacts/corpus"
        )

    prompt_versions = {
        artifact.id: artifact.version
        for artifact in manifest.artifacts
        if artifact.kind == "prompt" and artifact.foundational
    }
    if evidence.prompt_versions != prompt_versions:
        errors.append("live evidence prompt_versions do not match the foundational manifest")

    expected_by_case = {case.id: case for case in quality.cases}
    expected_cases = set(expected_by_case)
    documents = {document.id: document for document in corpus.documents}
    result_cases = {result.case_id for result in evidence.results}
    if result_cases != expected_cases or len(evidence.results) != len(quality.cases):
        errors.append("live evidence results do not cover each quality case exactly once")
    if evidence.sample_size != len(quality.cases):
        errors.append("live evidence sample_size does not match the quality manifest")
    actual_attempts = sum(result.extraction_attempted for result in evidence.results)
    if evidence.extraction_attempts != actual_attempts:
        errors.append("live evidence extraction_attempts does not match attempted results")

    actual_discards = sum(result.discarded for result in evidence.results)
    if any(result.discarded and not result.extraction_attempted for result in evidence.results):
        errors.append("live evidence marks a non-extracted result as discarded")
    if evidence.extraction_discards != actual_discards:
        errors.append("live evidence extraction_discard count does not match results")
    expected_rate = actual_discards / evidence.extraction_attempts
    if abs(evidence.discard_rate - expected_rate) > 1e-9:
        errors.append("live evidence discard_rate does not match results")
    if evidence.discard_rate >= 0.10:
        errors.append("live extraction discard_rate must be below 10%")

    actual_passes = 0
    for result in evidence.results:
        case = expected_by_case.get(result.case_id)
        if case is None:
            continue
        if result.document_id != case.document_id:
            errors.append(
                f"live evidence result {result.case_id}: document_id disagrees with quality case"
            )
        document = documents.get(case.document_id)
        if document is not None and result.extraction_attempted != (document.kind != "table"):
            errors.append(
                f"live evidence result {result.case_id}: extraction route disagrees with document kind"
            )
        graph_text = "\n".join(result.graph_terms).casefold()
        expected_missing_tags = tuple(tag for tag in case.required_tags if tag not in result.tags)
        expected_missing_terms = tuple(
            term for term in case.required_graph_terms if term.casefold() not in graph_text
        )
        expected_forbidden = tuple(
            term for term in case.forbidden_graph_terms if term.casefold() in graph_text
        )
        if (
            result.missing_tags != expected_missing_tags
            or result.missing_graph_terms != expected_missing_terms
            or result.forbidden_graph_terms_present != expected_forbidden
        ):
            errors.append(
                f"live evidence result {result.case_id}: recorded semantic deltas disagree "
                "with tags/graph terms"
            )
        recomputed = not (
            result.discarded
            or expected_missing_tags
            or expected_missing_terms
            or expected_forbidden
        )
        if result.passed != recomputed:
            errors.append(
                f"live evidence result {result.case_id}: passed flag disagrees with deltas"
            )
        actual_passes += recomputed
    if evidence.quality_cases_total != len(quality.cases):
        errors.append("live evidence quality_cases_total does not match the quality manifest")
    if evidence.quality_cases_passed != actual_passes:
        errors.append("live evidence quality_cases_passed does not match results")
    if actual_passes != len(quality.cases):
        errors.append("live evidence has failing semantic quality cases")
    if not evidence.semantic_reviewed:
        errors.append("live evidence has not received a declared semantic review")
    return errors


def foundational_status(
    *,
    repo: Path = REPO,
    evidence_path: Path | None = None,
    structural_only: bool = False,
) -> FoundationalStatus:
    """Return the two gates separately; structure alone is never overall completion."""
    structure_errors = tuple(validate(repo=repo))
    live_errors: tuple[str, ...]
    if structural_only:
        live_errors = ("live evidence not checked in structural-only mode",)
        summary = (
            "Structural checks passed; live evidence not checked."
            if not structure_errors
            else "Structural checks failed; live evidence not checked."
        )
        return FoundationalStatus(
            structure_passed=not structure_errors,
            live_evidence_passed=False,
            overall_complete=False,
            structure_errors=structure_errors,
            live_evidence_errors=live_errors,
            summary=summary,
        )

    path = evidence_path or repo / "evals" / "foundational_evidence.yaml"
    try:
        evidence = FoundationalEvidence.model_validate(_read_yaml(path))
    except (OSError, ValidationError, yaml.YAMLError) as exc:
        live_errors = (f"live evidence invalid or missing: {path}: {exc}",)
    else:
        live_errors = tuple(validate_live_evidence(evidence, repo=repo))
    live_passed = not live_errors
    overall = not structure_errors and live_passed
    summary = (
        "Foundational content contract complete."
        if overall
        else "Foundational content contract incomplete; inspect structural and live evidence errors."
    )
    return FoundationalStatus(
        structure_passed=not structure_errors,
        live_evidence_passed=live_passed,
        overall_complete=overall,
        structure_errors=structure_errors,
        live_evidence_errors=live_errors,
        summary=summary,
    )


def check_prompts(*, repo: Path = REPO) -> list[str]:
    errors: list[str] = []
    prompts_dir = repo / "src" / "rsc_brain" / "prompts"
    for name in REQUIRED_PROMPTS:
        path = prompts_dir / f"{name}.v1.md"
        if not path.is_file():
            errors.append(f"missing prompt: {path.relative_to(repo)}")
            continue
        text = path.read_text(encoding="utf-8")
        if "version: v1" not in text:
            errors.append(f"{name}: missing version header")
        if "Untrusted input" not in text:  # AUDIT-008 adversarial-data precedence block
            errors.append(f"{name}: missing untrusted-data precedence block (AUDIT-008)")
        if text.count("### Example") < 3:
            errors.append(f"{name}: fewer than 3 few-shot examples")
        if "(ES" not in text or "(EN" not in text:
            errors.append(f"{name}: few-shot must cover both ES and EN")
    return errors


def check_templates(*, repo: Path = REPO) -> list[str]:
    templates_dir = repo / "src" / "rsc_brain" / "hunting" / "templates"
    return [
        f"missing hunting template: {(templates_dir / name).relative_to(repo)}"
        for name in REQUIRED_TEMPLATES
        if not (templates_dir / name).is_file()
    ]


def check_taxonomy(*, repo: Path = REPO) -> list[str]:
    errors: list[str] = []
    evals_dir = repo / "evals"
    taxonomy = Taxonomy(**yaml.safe_load((evals_dir / "taxonomy.yaml").read_text(encoding="utf-8")))
    slug_sets: list[tuple[str, set[str]]] = []
    for pid, project in taxonomy.projects.items():
        if not any(topic.sensitivity >= 3 for topic in project.topics):
            errors.append(f"taxonomy project {pid}: no sensitive topic (sensitivity >= 3)")
        slug_sets.append((pid, {t.slug for t in project.topics}))
    for i in range(len(slug_sets)):
        for j in range(i + 1, len(slug_sets)):
            overlap = slug_sets[i][1] & slug_sets[j][1]
            if overlap:
                errors.append(
                    f"taxonomy slug overlap between {slug_sets[i][0]} and {slug_sets[j][0]}: {overlap}"
                )
    return errors


def check_corpus(*, repo: Path = REPO) -> list[str]:
    path = repo / "evals" / "documents.yaml"
    if not path.is_file():
        return []  # increment 2
    corpus = Corpus(**yaml.safe_load(path.read_text(encoding="utf-8")))
    errors: list[str] = []
    if len(corpus.documents) < 25:
        errors.append(f"corpus: {len(corpus.documents)} documents (< 25)")
    policies = {d.policy for d in corpus.documents}
    missing_policies = {"manual", "source_tags", "llm", "llm_review"} - policies
    if missing_policies:
        errors.append(f"corpus: missing D13 policies {missing_policies}")
    if not any(d.retained for d in corpus.documents):
        errors.append("corpus: no retained-sensitive document (review_if_sensitive)")
    if sum(1 for d in corpus.documents if d.kind == "scanned") < 3:
        errors.append("corpus: fewer than 3 scanned documents")
    if len({d.project for d in corpus.documents}) < 2:
        errors.append("corpus: fewer than 2 projects")
    return errors


def check_foundational_quality(*, repo: Path = REPO) -> list[str]:
    """Validate the ten-case ES/EN, cross-project, mixed-kind semantic sample."""
    evals_dir = repo / "evals"
    try:
        quality = load_quality_manifest(evals_dir / "foundational_quality.yaml")
        corpus = Corpus.model_validate(_read_yaml(evals_dir / "documents.yaml"))
        taxonomy = Taxonomy.model_validate(_read_yaml(evals_dir / "taxonomy.yaml"))
    except (OSError, ValidationError, yaml.YAMLError) as exc:
        return [f"foundational quality manifest invalid: {exc}"]

    errors: list[str] = []
    if len(quality.cases) != 10:
        errors.append(f"foundational quality: {len(quality.cases)} cases (expected exactly 10)")
    case_ids = [case.id for case in quality.cases]
    if len(set(case_ids)) != len(case_ids):
        errors.append("foundational quality: duplicate case ids")
    document_ids = [case.document_id for case in quality.cases]
    if len(set(document_ids)) != len(document_ids):
        errors.append("foundational quality: duplicate sampled documents")

    documents = {document.id: document for document in corpus.documents}
    sampled = []
    sensitive = False
    for case in quality.cases:
        document = documents.get(case.document_id)
        if document is None:
            errors.append(
                f"foundational quality case {case.id}: unknown document {case.document_id}"
            )
            continue
        sampled.append(document)
        project = taxonomy.projects.get(document.project)
        if project is None:
            errors.append(
                f"foundational quality case {case.id}: unknown project {document.project}"
            )
            continue
        sensitivities = {topic.slug: topic.sensitivity for topic in project.topics}
        unknown_tags = set(case.required_tags) - set(sensitivities)
        if unknown_tags:
            errors.append(
                f"foundational quality case {case.id}: unknown tags {sorted(unknown_tags)}"
            )
        if not set(case.required_tags).issubset(document.tags):
            errors.append(
                f"foundational quality case {case.id}: expected tags disagree with corpus source tags"
            )
        sensitive = (
            sensitive
            or document.retained
            or any(sensitivities.get(tag, 0) >= 3 for tag in case.required_tags)
        )

    if {document.lang for document in sampled} != {"en", "es"}:
        errors.append("foundational quality: sample must cover both en and es")
    if len({document.project for document in sampled}) < 2:
        errors.append("foundational quality: sample must cover both projects")
    missing_kinds = {"prose", "table", "scanned"} - {document.kind for document in sampled}
    if missing_kinds:
        errors.append(
            f"foundational quality: sample missing document kinds {sorted(missing_kinds)}"
        )
    if not sensitive:
        errors.append("foundational quality: sample has no sensitive/retained document")
    return errors


def check_golden(*, repo: Path = REPO) -> list[str]:
    path = repo / "evals" / "golden.yaml"
    if not path.is_file():
        return []  # increment 2
    golden = Golden(**yaml.safe_load(path.read_text(encoding="utf-8")))
    errors: list[str] = []
    if len(golden.cases) < 40:
        errors.append(f"golden: {len(golden.cases)} cases (< 40)")
    families = {c.family for c in golden.cases}
    missing = REQUIRED_GOLDEN_FAMILIES - families
    if missing:
        errors.append(f"golden: missing families {missing}")
    return errors


def check_contradictions(*, repo: Path = REPO) -> list[str]:
    path = repo / "evals" / "contradictions.yaml"
    if not path.is_file():
        return []  # increment 2
    pairs = Contradictions(**yaml.safe_load(path.read_text(encoding="utf-8"))).pairs
    errors: list[str] = []
    if len(pairs) < 30:
        errors.append(f"contradictions: {len(pairs)} pairs (< 30)")
    if {"agree", "contradict", "unrelated"} - {p.verdict for p in pairs}:
        errors.append("contradictions: not all three verdicts represented")
    if not any(p.lang_a != p.lang_b for p in pairs):
        errors.append("contradictions: no cross-language (ES<->EN) pair")
    return errors


def check_prompt_injection(*, repo: Path = REPO) -> list[str]:
    path = repo / "evals" / "prompt_injection.yaml"
    if not path.is_file():
        return ["prompt injection: missing evals/prompt_injection.yaml"]
    suite = PromptInjectionSuite(**yaml.safe_load(path.read_text(encoding="utf-8")))
    errors: list[str] = []
    if len(suite.cases) < 10:
        errors.append(f"prompt injection: {len(suite.cases)} cases (< 10)")
    stages = {case.stage for case in suite.cases}
    if stages != {"topicalizer", "extractor", "judge"}:
        errors.append(f"prompt injection: incomplete stages {stages}")
    languages = {case.lang for case in suite.cases}
    if languages != {"en", "es", "mixed"}:
        errors.append(f"prompt injection: incomplete languages {languages}")
    deliveries = {case.delivery for case in suite.cases}
    required = {"prose", "table", "ocr", "metadata", "encoded", "indirect"}
    if missing := required - deliveries:
        errors.append(f"prompt injection: missing deliveries {missing}")
    for case in suite.cases:
        values = [getattr(case, "content", ""), getattr(case, "claim_a", "")]
        if not any(value and detect_prompt_injection(value) is not None for value in values):
            errors.append(f"prompt injection: {case.id} is not recognized as adversarial")
    return errors


def validate(*, repo: Path = REPO) -> list[str]:
    return (
        validate_artifact_manifest(repo=repo)
        + check_prompts(repo=repo)
        + check_templates(repo=repo)
        + check_taxonomy(repo=repo)
        + check_corpus(repo=repo)
        + check_foundational_quality(repo=repo)
        + check_golden(repo=repo)
        + check_contradictions(repo=repo)
        + check_prompt_injection(repo=repo)
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--structural-only",
        action="store_true",
        help="Check static structure but explicitly leave overall completion false.",
    )
    parser.add_argument("--json", action="store_true", help="Emit the typed status as JSON.")
    parser.add_argument("--evidence", type=Path, help="Override the live-evidence YAML path.")
    args = parser.parse_args(argv)
    status = foundational_status(
        evidence_path=args.evidence,
        structural_only=args.structural_only,
    )
    if args.json:
        print(status.model_dump_json(indent=2))
    else:
        stream = sys.stdout if status.overall_complete or args.structural_only else sys.stderr
        print(status.summary, file=stream)
        for error in (*status.structure_errors, *status.live_evidence_errors):
            print(f"  - {error}", file=stream)
    return (
        0 if (status.structure_passed if args.structural_only else status.overall_complete) else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
