# Evaluation corpus and metrics

The repository includes a synthetic, reviewable corpus for recall quality, abstention, temporal
behavior, prompt-injection resistance, and project/topic isolation. It contains no production
company data.

## Current corpus

`documents.yaml` is the source for two fictional organizations and their source documents.
`taxonomy.yaml` defines project-local topics and sensitivities. `golden.yaml` contains 47 cases:

| Family | Cases | Purpose |
|---|---:|---|
| `hit` | 12 | Relevant knowledge should be returned. |
| `abstain` | 5 | Unsupported questions should return no answer. |
| `denied` | 6 | Topic-hidden knowledge must not leak. |
| `cross_project` | 5 | Another project's knowledge must not leak. |
| `exact_id` | 4 | Exact identifiers remain retrievable. |
| `temporal` | 9 | Current and historical intent select the correct validity interval. |
| `injection` | 6 | Instructions embedded in documents remain untrusted data. |

Of the 47 cases, 24 must find knowledge and 23 must abstain. `contradictions.yaml` supplies
contradiction cases for the living-graph evaluator.

Validate the static corpus and report its composition:

```bash
uv run python -m evals.validate
uv run brain --json eval
```

The CLI command reports composition only. It does not run model-backed recall.

## Generate PDF fixtures

The YAML source can be rendered into native and scanned PDF fixtures:

```bash
uv run --group evals python -m evals.generate_pdfs
```

Generated files are written under `evals/pdfs/` and are ignored by Git. Scanned fixtures have no
text layer, which forces the OCR path. The locked default application environment supports Markdown;
PDF and OCR execution also needs the operator-installed Docling backend.

## Run quality evaluation

`evals.runner.run_eval` accepts a sequence of `EvalCase` values and an asynchronous `recall_fn`.
The caller owns dataset ingestion, per-case principal scope, model/provider configuration, and
result persistence. The runner returns:

- must-find hit rate (`retrieval_precision` in the 0.13.0 report);
- correct-abstention rate over must-abstain cases;
- permission leak count for `denied` and `cross_project` cases; and
- average recall latency.

`evals.runner.run_calibration` runs the same cases through a retriever configured to expose raw top
scores and selects the threshold that maximizes abstention F1.

The deterministic gateway and metric functions run in automated tests. A live-provider evaluation
requires a prepared corpus and provider environment; record that evidence separately rather than
treating `brain eval` as a live quality pass.

## Change rule

Run the corpus evaluation before changing a model, provider, embedding, judge, reranker, or
versioned prompt under `src/rsc_brain/prompts/`. Review golden expectations whenever a source
document or taxonomy changes. Security cases must remain strict: any result for a denied or
cross-project case is a permission leak.
