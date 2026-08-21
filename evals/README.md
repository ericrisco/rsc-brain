# Evaluation corpus and metrics

The repository includes a synthetic, reviewable corpus for recall quality, abstention, temporal
behavior, prompt-injection resistance, and project/topic isolation. It contains no production
company data.

## Current corpus

`documents.yaml` is the source for two fictional organizations and their source documents.
`taxonomy.yaml` defines project-local topics and sensitivities. `golden.yaml` contains 47 recall
cases. Those six `injection`-family queries are recall-side abstention checks; they do not exercise
the ingestion model boundary. `prompt_injection.yaml` separately contains 10 executable adversarial
ingestion cases for topicalization, extraction, and contradiction judging.

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

Validate structure alone, or validate the complete fingerprint-bound foundational contract:

```bash
uv run python -m evals.validate --structural-only
uv run python -m evals.validate --json
uv run brain --json eval
```

Structural-only success deliberately reports `live_evidence_passed=false` and
`overall_complete=false`; it cannot be quoted as SPEC-02 completion. The default validator also
checks `foundational_evidence.yaml` against `foundational_manifest.yaml`, every listed artifact,
the corpus, taxonomy, and `foundational_quality.yaml`. Any byte change to those inputs makes the
evidence stale. The `brain eval` CLI command reports composition only; it does not run model-backed
recall.

## Run the prompt-injection gate

Run the production prompt assemblers/adapters against the configured target profile three times:

```bash
uv run python -m evals.prompt_injection_eval --config config.yaml --runs 3
```

The gate requires 100% safe outcomes in all three complete runs and records the configured model
identity. One unsafe or unavailable case fails the profile; a pass is evidence for that exact run,
not a permanent guarantee for a mutable future model. In production topology, obvious topicalizer
attacks stop at deterministic quarantine before a provider call; extractor and judge cases exercise
the configured model directly. Structural envelopes, tag floors and persistent quarantine are also
enforced in the unit/integration suite, independently of model luck.

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

## Graph backend decision benchmark

AUDIT-011's D1 benchmark is separate from the per-PR smoke test. The decision population is fixed at
200,000 vertices and 1,000,000 unique directed edges. Generate it once, mount the generated directory
read-only at `/benchmark` in the product database image, and run both resource profiles against the
same manifest and immutable image identity:

```bash
uv run python -m evals.run_graph_decision prepare --output-dir /tmp/rsc-graph-decision/workload

export RSC_BRAIN_DATABASE__DSN='postgresql+asyncpg://USER:PASSWORD@127.0.0.1:PORT/rsc_brain'
uv run python -m evals.run_graph_decision run-age \
  --manifest /tmp/rsc-graph-decision/workload/workload-manifest.json \
  --profile workstation --server-csv-root /benchmark \
  --output /tmp/rsc-graph-decision/workstation.json \
  --image-identity sha256:IMAGE_ID --container-cpu-limit 8 \
  --container-memory-bytes 8000000000 --accelerator 'ACCELERATOR; AGE executes on CPU'

# Restart the disposable database with 4 vCPU / 6 GiB, then point the DSN at it.
uv run python -m evals.run_graph_decision run-age \
  --manifest /tmp/rsc-graph-decision/workload/workload-manifest.json \
  --profile cpu_only --server-csv-root /benchmark \
  --output /tmp/rsc-graph-decision/cpu_only.json \
  --image-identity sha256:IMAGE_ID --container-cpu-limit 4 \
  --container-memory-bytes 6442450944 --accelerator 'ACCELERATOR; AGE executes on CPU'

uv run python -m evals.run_graph_decision combine \
  --workstation /tmp/rsc-graph-decision/workstation.json \
  --cpu-only /tmp/rsc-graph-decision/cpu_only.json \
  --output evals/results/graph-decision-YYYY-MM-DD.json
```

`run-age` verifies every CSV digest, resets and loads through AGE's documented CSV functions,
creates the node-id indexes, and refuses to time a graph whose persisted counts differ. `combine`
accepts only the exact 5-warm-up/30-iteration, k=2 policy in both profiles. A scaled smoke remains
`decision_run=false` and cannot produce a verdict. Accelerator presence is inventory only:
PostgreSQL/AGE executes this traversal on CPU.

## Foundational prompt quality gate

`foundational_manifest.yaml` is the exhaustive inventory for all current prompts and hunting
templates, including later non-foundational additions and their owning spec. Validation is
bidirectional: a missing, misplaced, duplicated, or unmanifested Markdown artifact fails, as does
frontmatter that disagrees with the manifest identity, version, role, or language.

`foundational_quality.yaml` fixes a ten-document ES/EN sample across both projects, prose, a scanned
fixture, the production deterministic table path, and sensitive content. Run the production
extractor/topicalizer adapters against a reachable target model with its exact local digest:

```bash
uv run python -m evals.foundational_eval \
  --provider ollama \
  --model gemma4:12b \
  --model-digest 4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c \
  --api-base http://localhost:11434 \
  --allow-http --allow-private-network
```

The two grants are required, not optional decoration: AUDIT-005 denies a plain-HTTP or
loopback model endpoint unless the operator says otherwise, exactly as the configuration file
does. Drop them and the run refuses to start rather than reaching out.

The runner writes `foundational_evidence.candidate.yaml`, records every tag/graph term and semantic
delta, and exits non-zero unless extraction discards are strictly below 10% and every expectation
passes. Generated evidence always has `semantic_reviewed: false`: inspect all case results, record
whether review was `human` or `assisted`, and only then promote it to
`foundational_evidence.yaml`. The validator recomputes semantic deltas from the recorded outputs; it
does not trust self-reported `passed` or `missing_*` fields.

## Change rule

Run the corpus evaluation before changing a model, provider, embedding, judge, reranker, or
versioned prompt under `src/rsc_brain/prompts/`. Review golden expectations whenever a source
document or taxonomy changes. Security cases must remain strict: any result for a denied or
cross-project case is a permission leak.
