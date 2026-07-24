# Foundational eval content (SPEC-02)

The synthetic content the whole product's quality is measured against: two fictional projects,
their documents, the golden question set, contradiction pairs, and the example taxonomy.
`documents.yaml` is the **source of truth**; `generate_pdfs.py` renders it to PDFs on demand.

## The `brain eval` rule (PRD §12) — non-negotiable

**Run `brain eval` before changing any model, provider, or versioned prompt in
`src/rsc_brain/prompts/`.** Prompts determine graph quality as much as the model does. In CI the
evals run over this corpus with a small, pinned model for reproducibility (§12.5). The `brain
eval` runner itself lands in SPEC-06; this SPEC produces the dataset + schema + validator.

## The two projects (used by the permission/isolation suite, FR-12.5)

**Acme Corp** (software) — topics: `general`, `engineering`, `sales`, `hr` (sensitivity 3),
`payroll` (4). **Globex Consulting** — topics: `corp`, `delivery`, `legal` (2), `personnel` (3).
Slugs are disjoint between projects (per-project topics, D9). See `taxonomy.yaml`.

### Users & memberships (referenced by `golden.yaml`)

| user | project | role | allowed_topics |
|------|---------|------|----------------|
| alice | acme | member | general, engineering, sales |
| bob | acme | member | general  *(no hr/payroll — the FR-4.14 denied cases)* |
| carol | acme | project-admin | general, engineering, sales, hr, payroll |
| dave | globex | member | corp, delivery |
| erin | globex | member | corp, delivery, legal |

alice/carol are acme-only; dave/erin globex-only → the cross-project cases. bob lacks the
sensitive topics → the FR-4.14 denied cases.

## D13 policy coverage (each policy has a test document)

| policy | document | note |
|--------|----------|------|
| `source_tags` | most docs (e.g. `acme-overview-en`) | tags from the source |
| `llm` | `acme-hr-reviews-en`, `acme-llm-note-en` | LLM-topicalized |
| `llm_review` | `acme-payroll-bands-es`, `globex-personnel-es` | **retained** (sensitive) until approved |
| `manual` | `acme-hr-manual-en`, `globex-legal-manual-en` | **retained** — not recallable until approved |

## Temporal cases (FR-16.9)

`acme-sla-2023-en` (24h) → `acme-sla-2024-en` (12h); `globex-rate-2022-en` (100 €/h) →
`globex-rate-2024-en` (120 €/h). Golden family `temporal` asks current vs historical; in v0.2
`current` mode must exclude the superseded claim and historical intent must recover it.

## Generating the PDFs

`documents.yaml` is the editable source. To materialize PDFs (native for prose/tables; a
rasterized, text-layer-free page for `kind: scanned`, to force the OCR path):

```bash
uv run --group evals python -m evals.generate_pdfs   # writes evals/pdfs/*.pdf (gitignored)
```

SPEC-05's ingestion tests consume these PDFs. Keeping the source in YAML (not committed binaries)
makes the corpus reviewable and editable; the PDFs are a generated view.

## Blocked-by-resource

Step 10 (iterate prompts against the target **local model**, sampling extraction discards to
< 10%) requires a local model (Ollama/vLLM), which is **not available on this host** — it is
recorded `blocked-by-resource` and runs when a local model is present. The v1 prompts ship with
the AUDIT-008 untrusted-data discipline and ES/EN few-shot in the meantime.
