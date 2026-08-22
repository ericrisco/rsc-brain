# Evaluation corpus and metrics

The repository includes a synthetic, reviewable corpus for recall quality, abstention, temporal
behavior, prompt-injection resistance, and project/topic isolation. It contains no production
company data.

## Current corpus

`documents.yaml` is the source for two fictional organizations and their source documents.
`taxonomy.yaml` defines project-local topics and sensitivities. `golden.yaml` contains 55 recall
cases. Those six `injection`-family queries are recall-side abstention checks; they do not exercise
the ingestion model boundary. `prompt_injection.yaml` separately contains 10 executable adversarial
ingestion cases for topicalization, extraction, and contradiction judging.

| Family | Cases | Purpose |
|---|---:|---|
| `hit` | 12 | Relevant knowledge should be returned. |
| `abstain` | 5 | Unsupported questions should return no answer. **This family is gate G4.** |
| `qualifier` | 6 | A sibling fact under a different qualifier must not be served as the answer. |
| `denied` | 8 | Topic-hidden knowledge must not leak. Two of them (`d7`, `d8`) deny a topic *below* the sensitivity threshold, which nothing asserted until AUDIT-139. |
| `cross_project` | 5 | Another project's knowledge must not leak. |
| `exact_id` | 4 | Exact identifiers remain retrievable. |
| `temporal` | 9 | Current and historical intent select the correct validity interval. |
| `injection` | 6 | Instructions embedded in documents remain untrusted data. |

Of the 55 cases, 30 must find knowledge and 25 must abstain; 54 are scored through recall and one
through the timeline surface. `contradictions.yaml` supplies contradiction cases for the living-graph
evaluator.

## Aiming the instrument at your own corpus

Every phase takes `--corpus DIR`:

```bash
uv run python -m evals.gate_run setup   --corpus /path/to/your-corpus
uv run python -m evals.gate_run ingest  --corpus /path/to/your-corpus
uv run python -m evals.gate_run measure --corpus /path/to/your-corpus
```

`DIR` holds `documents.yaml`, `golden.yaml`, `users.yaml`, `taxonomy.yaml`, `contradictions.yaml` and
`rerank_calibration.yaml` — this directory is the reference set to copy and replace. A directory
missing any of them is refused before anything is created. The run state (`.gate_run_state.json`, the
corpus-id → UUID map) is written inside `DIR`, so two corpora never share a document map.

Without the flag nothing changes, and every number published anywhere in this repository refers to the
corpus in this directory.

**Why it exists.** Until AUDIT-138 the corpus path was this module's own directory, so the only people
who could run the gates were the people who had written the corpus. "The shape of the failures
generalizes" was a claim nobody else could check. The first run against a second corpus — 11 documents
and 21 cases in marine manufacturing and a municipal office, sharing no vocabulary with these two
fictional companies — found two defects in **how the gates are measured** (AUDIT-139, AUDIT-140) that
27 documents had hidden. That is the argument for the flag, better than any number it produces.

## The calibration set is not the exam

`rerank_calibration.yaml` holds the 24 cases the `recall.tau_rerank` sweep may fit on, and **nothing
scores them**. They exist because a threshold decides abstention, abstention is gate G4, and the sweep
used to draw from `golden.yaml` — so G4 was reported over exactly the cases its threshold had been
fitted to (AUDIT-136). The two sets are disjoint by id, by question, and by reworded near-duplicate;
`holdout.py` computes that from the two files and `validate.py` fails if it stops being true, so the
overlap cannot come back silently.

Measured, on `BAAI/bge-reranker-v2-m3` over this corpus: the held-out sweep suggests **0.325** where
one fitted on the gate's own cases suggested **0.085**, and the honest threshold reports 0.667
retrieval precision where the fitted one reported 0.833. G4 itself stayed 5/5 — what fitting concealed
was the recall it cost, not the abstention it bought.

Two limits a split does not fix, and which the sweep's output states every time: both sets run over the
same 27 documents (a threshold has to be fitted on the distribution the install will serve), and one
person wrote both. The calibration positives deliberately span golden's three shapes — plain lookup,
table cell under a qualifier, dated fact — but the corpus holds only two temporal pairs and golden
already mines them, so the dated calibration cases ask for boundary *dates* where golden asks for
values. A fully representative held-out split needs a bigger corpus.

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
- permission leak count for `denied` and `cross_project` cases — **disclosures**, not answers; and
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
document or taxonomy changes.

Security cases must remain strict: **any** result for a denied or cross-project case is a failure. It
is not automatically a *leak*. AUDIT-127 separated the two after a `cpu_only` run reported eleven
permission leaks where the real number of disclosures was zero — eleven abstention failures and no
confidentiality breach, because the permission filter lives in the query and holds with or without a
reranker. `correct_abstention_rate` counts answering-when-it-should-abstain; `permission_leaks` counts
returning something this principal may not see.

Since AUDIT-139 the second is judged against what **`documents.yaml` declares** each document to be,
not against the effective tags the filter consulted. Judging by the effective tags asked the filter its
own question: a document carrying a topic it should not carry was admitted BY that topic, so nothing
looked forbidden about it. That is not theoretical — it hid two real disclosures in this very corpus
behind a reported zero for every published measurement. `filter_breaches` keeps the older and harder
question separate: did the SQL predicate itself return something it had no basis for.

## Running the success gates

G2, G3 and G4 are measurable from a running instance, and until AUDIT-114 nothing in this repository
ran them: every figure ever recorded came from a script written on a rented host and thrown away with
it, so no gate number could be reproduced after a change.

```bash
export RSC_BRAIN_CONFIG=/path/to/config.yaml          # real capability routes; models must be up
export RSC_BRAIN_DATABASE__DSN=postgresql+asyncpg://…  # a migrated database

uv run python -m evals.gate_run setup     # both projects, taxonomy, sources, 4 principals + PATs
uv run python -m evals.gate_run ingest    # the 27-document corpus through real models
uv run python -m evals.gate_run measure   # the 55 golden cases -> G2/G3/G4
```

`setup` and `ingest` are resumable: an already-present document is reported as a duplicate and costs
no model call, which matters because a live-model corpus takes tens of minutes.

What it deliberately does **not** do is assemble its own graph. The pipeline comes from
`runtime.build_pipeline`, the retriever is built as `ApiDeps.retriever()` builds it (reranker
included when configuration enables it), and each case's scope is resolved from that principal's own
personal access token through the real authentication path — a fabricated scope would make every
`denied` and `cross_project` case prove nothing. AUDIT-112 is what a measurement through a
hand-assembled graph costs.

Read the per-family breakdown, not only the aggregate: `correct_abstention_rate` spans `abstain`,
`denied`, `cross_project` and `injection`. **G4 is the `abstain` family alone**, and the runner prints
it separately for that reason. Abstention also depends on `reranker.enabled` — with the reranker off,
the blended-threshold path answers cases it should refuse.

G3 is its own phase, because it scores the **judge** rather than recall and therefore needs no corpus
and no principals:

```bash
uv run python -m evals.gate_run g3        # the 32 ES/EN contradiction pairs
```

Read the stratified numbers, not the aggregate. AUDIT-076 exists because a single accuracy figure
reported 30/32 (93.8%, passing) while hiding 12/14 cross-lingual (85.7%, failing) — and for a product
scoping `spa+eng` the second number is the one that matters. A population that was never measured
reports `null`, never `1.0` (AUDIT-082).
