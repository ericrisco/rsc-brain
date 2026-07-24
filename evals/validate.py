"""Validate the foundational content (SPEC-02).

Checks — per AUDIT-009 — the exact **paths** and **manifest completeness**, not just counts:
the five versioned prompts (with the AUDIT-008 untrusted-data block and ES+EN few-shot), the
eight hunting templates at the canonical `src/rsc_brain/hunting/templates/` path, the taxonomy,
and — when they exist (SPEC-02 increment 2) — the corpus, golden set, and contradiction pairs
against their schemas. Run: ``uv run python -m evals.validate``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

from evals.schema import Contradictions, Corpus, Golden, Taxonomy

REPO = Path(__file__).resolve().parents[1]
PROMPTS_DIR = REPO / "src" / "rsc_brain" / "prompts"
TEMPLATES_DIR = REPO / "src" / "rsc_brain" / "hunting" / "templates"
EVALS = REPO / "evals"

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
}


def check_prompts() -> list[str]:
    errors: list[str] = []
    for name in REQUIRED_PROMPTS:
        path = PROMPTS_DIR / f"{name}.v1.md"
        if not path.is_file():
            errors.append(f"missing prompt: {path.relative_to(REPO)}")
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


def check_templates() -> list[str]:
    return [
        f"missing hunting template: {(TEMPLATES_DIR / name).relative_to(REPO)}"
        for name in REQUIRED_TEMPLATES
        if not (TEMPLATES_DIR / name).is_file()
    ]


def check_taxonomy() -> list[str]:
    errors: list[str] = []
    taxonomy = Taxonomy(**yaml.safe_load((EVALS / "taxonomy.yaml").read_text(encoding="utf-8")))
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


def check_corpus() -> list[str]:
    path = EVALS / "documents.yaml"
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


def check_golden() -> list[str]:
    path = EVALS / "golden.yaml"
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


def check_contradictions() -> list[str]:
    path = EVALS / "contradictions.yaml"
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


def validate() -> list[str]:
    return (
        check_prompts()
        + check_templates()
        + check_taxonomy()
        + check_corpus()
        + check_golden()
        + check_contradictions()
    )


def main() -> int:
    errors = validate()
    if errors:
        print("FOUNDATIONAL CONTENT INVALID:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("Foundational content valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
