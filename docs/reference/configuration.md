<!-- diataxis: reference -->

# Configuration reference

rsc-brain loads a typed `AppConfig` tree. YAML keys use the dotted names in this page; environment variables use the `RSC_BRAIN_` prefix and a double underscore between nesting levels.

For example, `capabilities.embedder.api_key` maps to `RSC_BRAIN_CAPABILITIES__EMBEDDER__API_KEY`, and `recall.weights.similarity` maps to `RSC_BRAIN_RECALL__WEIGHTS__SIMILARITY`. Environment names are case-insensitive.

## Configuration file selection

`load_settings()` selects one YAML file in this order:

| Priority | Source |
|---|---|
| 1 | The path passed to `load_settings(path)`. |
| 2 | The path in `RSC_BRAIN_CONFIG`. |
| 3 | `config.yaml` in the current working directory, when that file exists. |
| 4 | No YAML file; environment values and code defaults remain. |

## Precedence

For an individual setting, the highest available source wins:

| Priority | Value source |
|---|---|
| 1 | Explicit settings initialization values. |
| 2 | Process environment variables. |
| 3 | The selected YAML file. |
| 4 | Model defaults. |

The configuration-file selector and configuration values are separate concerns: `RSC_BRAIN_CONFIG` names a file, while variables such as `RSC_BRAIN_DATABASE__DSN` override values loaded from that file.

## Hardware and capability routing

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `hardware_profile` | `workstation` or `cpu_only` | `workstation` | Hardware preset reported by the runtime and installer. |
| `capabilities` | object | required | Container for the five model roles. |
| `capabilities.extractor` | object | required | Claim and relation extraction model route. |
| `capabilities.judge` | object | required | Contradiction and decision model route. |
| `capabilities.topicalizer` | object | required | Topic classification model route. |
| `capabilities.embedder` | object | required | Embedding model route. |
| `capabilities.reranker` | object | optional | Reranking model route. Required only when `reranker.enabled` is true (FR-3.6); the reranker is disabled by default and the recall path does not call it. |

Every capability object has the same fields:

| Fields | Type | Required/default | Meaning and validation |
|---|---|---|---|
| `capabilities.extractor.provider`<br>`capabilities.judge.provider`<br>`capabilities.topicalizer.provider`<br>`capabilities.embedder.provider`<br>`capabilities.reranker.provider` | string | required | LiteLLM provider prefix, such as `ollama` or `openai`. |
| `capabilities.extractor.model`<br>`capabilities.judge.model`<br>`capabilities.topicalizer.model`<br>`capabilities.embedder.model`<br>`capabilities.reranker.model` | string | required | Provider-specific model name. The gateway route is `provider/model`. |
| `capabilities.extractor.api_base`<br>`capabilities.judge.api_base`<br>`capabilities.topicalizer.api_base`<br>`capabilities.embedder.api_base`<br>`capabilities.reranker.api_base` | string or null | null | Configuration-owned provider endpoint. A production model call requires an explicit URL; null is retained only for injected offline/test adapters and readiness reports it unresolved. URLs must be canonical HTTP(S), carry no credentials/query/fragment, and pass DNS egress checks before every attempt. HTTPS to globally routable addresses is the safe default. |
| `capabilities.extractor.egress`<br>`capabilities.judge.egress`<br>`capabilities.topicalizer.egress`<br>`capabilities.embedder.egress`<br>`capabilities.reranker.egress` | object | safe defaults | Configuration-owned egress exceptions for this one capability. |
| `capabilities.extractor.egress.allow_http`<br>`capabilities.judge.egress.allow_http`<br>`capabilities.topicalizer.egress.allow_http`<br>`capabilities.embedder.egress.allow_http`<br>`capabilities.reranker.egress.allow_http` | boolean | `false` | Explicitly permits plain HTTP for this capability's configured endpoint. This does not permit private addresses by itself. |
| `capabilities.extractor.egress.allow_private_network`<br>`capabilities.judge.egress.allow_private_network`<br>`capabilities.topicalizer.egress.allow_private_network`<br>`capabilities.embedder.egress.allow_private_network`<br>`capabilities.reranker.egress.allow_private_network` | boolean | `false` | Explicitly permits RFC1918, ULA and loopback addresses for this capability (for example local Ollama). Link-local, unspecified, multicast, reserved and otherwise non-global destinations remain forbidden. |
| `capabilities.extractor.api_key`<br>`capabilities.judge.api_key`<br>`capabilities.topicalizer.api_key`<br>`capabilities.embedder.api_key`<br>`capabilities.reranker.api_key` | secret string or null | null | Provider credential. Supply it through the environment. |
| `capabilities.extractor.timeout_s`<br>`capabilities.judge.timeout_s`<br>`capabilities.topicalizer.timeout_s`<br>`capabilities.embedder.timeout_s`<br>`capabilities.reranker.timeout_s` | number | `60.0` | Request timeout in seconds; greater than `0` and at most `600`. |
| `capabilities.extractor.fallback_model`<br>`capabilities.judge.fallback_model`<br>`capabilities.topicalizer.fallback_model`<br>`capabilities.embedder.fallback_model`<br>`capabilities.reranker.fallback_model` | string or null | null | Same-provider fallback used after a definitive model failure. |
| `capabilities.extractor.dimension`<br>`capabilities.judge.dimension`<br>`capabilities.topicalizer.dimension`<br>`capabilities.embedder.dimension`<br>`capabilities.reranker.dimension` | integer or null | null | Embedding-dimension field. The embedder's effective default is `1024`; an explicit embedder value must equal `1024`. |
| `capabilities.extractor.daily_token_budget`<br>`capabilities.judge.daily_token_budget`<br>`capabilities.topicalizer.daily_token_budget`<br>`capabilities.embedder.daily_token_budget`<br>`capabilities.reranker.daily_token_budget` | integer or null | null | Per-capability daily token ceiling. Values are nonnegative; null has no daily ceiling. |

The two egress exceptions are independent. A local Ollama route such as
`http://localhost:11434` needs both `allow_http: true` and
`allow_private_network: true`. Production model requests never follow HTTP redirects; a 3xx is
reported as a redacted provider failure rather than changing the configured destination.

## Recall and ranking

| Field | Type | Default | Meaning and validation |
|---|---|---|---|
| `recall` | object | configured defaults | Recall, temporal filtering, and result-budget settings. |
| `recall.temporal_refill_factor` | integer | `4` | Candidate surplus retrieved before temporal filtering; from `1` through `20`. Retrieval width is also capped internally at `200`. |
| `recall.tau` | number | `0.45` | Relevance threshold. Recall abstains when the best score is lower; from `0` through `1`. |
| `recall.tau_rerank` | number | `0.5` | Relevance threshold used **instead of** `recall.tau` when `reranker.enabled` is true. It reads the reranker's answers-the-question score, a different quantity from the blended score, so it is calibrated separately; from `0` through `1`. |
| `recall.rerank_candidates` | integer | `10` | How many top candidates the reranker scores. Bounded so one recall cannot become an unbounded number of model calls; from `1` through `50`. |
| `recall.weights` | object | configured defaults | Four components of the recall score. |
| `recall.weights.similarity` | number | `0.55` | Similarity contribution; from `0` through `1`. |
| `recall.weights.credibility` | number | `0.25` | Credibility contribution; from `0` through `1`. |
| `recall.weights.freshness` | number | `0.10` | Freshness contribution; from `0` through `1`. |
| `recall.weights.importance` | number | `0.10` | Importance contribution; from `0` through `1`. |
| `recall.half_life_days` | integer | `365` | Default freshness half-life in days; greater than `0`. |
| `recall.half_life_by_topic` | object of integer values | `{}` | Per-topic half-life overrides keyed by topic slug. |
| `recall.k_hop` | integer | `1` | Graph expansion depth; from `0` through `3`. |
| `recall.answer_token_budget` | integer | `2000` | Approximate token budget across returned fragments; greater than `0`. |
| `recall.hybrid_enabled` | boolean | `true` | Enables Reciprocal Rank Fusion of lexical and vector candidate lists. |
| `recall.rrf_k` | integer | `60` | Reciprocal Rank Fusion constant; greater than `0`. |
| `recall.lexical_candidates` | integer | `20` | Maximum lexical candidates before fusion; greater than `0`. |

The four values under `recall.weights` must total `1.0` within a tolerance of `0.000001`.

## Feature switches

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reranker` | object | configured defaults | Reranker feature settings. |
| `reranker.enabled` | boolean | `false` | Reranker switch (FR-3.6). When true, recall decides abstention on the reranker's relevance score against `recall.tau_rerank` instead of the blended `recall.tau`; when false the blended path is unchanged. Model routing is under `capabilities.reranker`. **A `cpu_only` hardware profile cannot serve it — see below.** |
| `reranker.kind` | `chat` or `rerank_api` | `chat` | Which implementation serves the reranker seam. `chat` asks the `capabilities.reranker` model to return JSON relevance scores — one chat inference per query, and the only route this product had for most of its life. `rerank_api` calls a real rerank endpoint through the same capability route, which is what a cross-encoder speaks: far cheaper per call, and the only shape that could serve abstention without a GPU (see the `cpu_only` note below). The default is `chat` so an existing install keeps the behaviour it was measured with. |
| `vision` | object | configured defaults | Reserved vision settings. |
| `vision.enabled` | boolean | `false` | Reserved vision switch. The current runtime does not consume it. |
| `telemetry` | object | configured defaults | Anonymous telemetry settings. |
| `telemetry.enabled` | boolean | `false` | Anonymous-telemetry opt-in field. The current runtime has no telemetry sender and does not consume this switch. |

### The reranker needs more than a CPU

Measured with `qwen2.5:3b-instruct`, one relevance call over a page of 10 candidates, identical
prompt and passages — only the serving route changed:

| route | latency | scores returned |
| --- | --- | --- |
| ollama in the Compose `ollama` profile, on macOS | **256.1 s** | 10/10 |
| ollama running natively on the same machine | **5.2 s** cold, **2.5 s** warm | 10/10 |

The default `capabilities.reranker.timeout_s` is **60**, so the first route times out on every call and
the second is not close to it. Same host, same silicon, same model: a factor of roughly 50-100.

So on a `cpu_only` profile every reranker call times out. Recall does not fail — it falls back to the
blended `recall.tau`, which is the behaviour of an install with the reranker switched off, measured
unable to reach the abstention gate. The switch reads as on and the capability never runs.
`brain verify --probe-models` reports this combination as a failed check rather than leaving you to
discover it.

#### What a `cpu_only` install actually delivers

Measured on the 27-document evaluation corpus, 53 cases, `gemma4:12b` + `bge-m3`, with the reranker
off — the only `cpu_only` configuration this product permits:

| | `workstation` (reranker on) | `cpu_only` (reranker off) |
| --- | --- | --- |
| finds what is there (`retrieval_precision`) | 1.0 | **0.967** |
| abstains when it should (`correct_abstention_rate`) | 1.0 | **0.0** |
| discloses nothing unauthorized (`permission_leaks`) | 0 | **0** |
| answers present in the corpus (`hit`) | 12/12 | 12/12 |
| refuses what is absent (`abstain`) | 5/5 | **0/5** |
| refuses what is denied (`denied`, `cross_project`) | 6/6, 5/5 | **0/6, 0/5** |
| resists an embedded instruction (`injection`) | 6/6 | **1/6** |

Read the third row before the second: **a `cpu_only` install leaks nothing.** Topic authority is
enforced in the query, so it holds whether or not a model is available to judge relevance. What a
`cpu_only` install cannot do is **refuse**. It answers every question it is asked — including the ones
whose answer is not in the corpus, and the ones asked by a principal who may not have it — using
whatever was nearest.

For a product whose promise is "says *I don't have that* and asks a human", that is not a degraded
mode; it is the promise switched off. Choose `cpu_only` only where finding is the whole requirement
and a confidently wrong answer is acceptable. Otherwise give the reranker a GPU.

### On macOS, the Compose `ollama` profile has no GPU

This is the trap the numbers above came from, and it is worth stating on its own.

Docker Desktop on macOS does not pass Metal through to a Linux container. So an operator on an Apple
Silicon machine who starts the packaged `--profile ollama` service is running every model on CPU — no
matter how capable the host's GPU is. The measurement above was taken on an Apple M4 Pro with 16 GPU
cores: **256 s inside the container, 2.5 s on the same machine outside it.**

Nothing lies about this, and that is the difficulty. `brain doctor` reports `gpu=False`, truthfully,
because from inside the container there is none. The host's GPU is real and unreachable, and no
surface connects those two facts.

If you are on macOS and want the reranker, run ollama **natively** (`brew install ollama` or the app)
and point the capability at the host:

```yaml
RSC_BRAIN_CAPABILITIES__RERANKER__PROVIDER: ollama
RSC_BRAIN_CAPABILITIES__RERANKER__MODEL: qwen2.5:3b-instruct
RSC_BRAIN_CAPABILITIES__RERANKER__API_BASE: http://host.docker.internal:11434
RSC_BRAIN_CAPABILITIES__RERANKER__EGRESS__ALLOW_HTTP: "true"
RSC_BRAIN_CAPABILITIES__RERANKER__EGRESS__ALLOW_PRIVATE_NETWORK: "true"
```

On Linux with an NVIDIA GPU the in-container path does work, with the device plugin and drivers on the
host (D8) — the packaged profile does not provision them.

### Ways out

Four, in the order they are usually right:

1. **Route the capability to a model that is not CPU-bound.** It is a route like the other four;
   nothing requires it to be in the container. On macOS that means a native ollama on the host (above);
   elsewhere it can be any remote provider. Cheapest fix, no new hardware.
2. **Use a GPU profile.** `hardware_profile: workstation` with a GPU actually reachable by the route.
3. **Shrink the page.** `recall.rerank_candidates` below 10 reduces the work per call — and also
   shrinks the evidence the judge sees, so measure the abstention you get rather than assuming.
4. **Leave it disabled** and accept threshold-only abstention, knowing what that costs: the product
   answers questions whose answer is absent, and the hunting loop does not fire.

Raising `timeout_s` is not on that list on purpose. A 250-second recall is not a recall anyone waits
for, and a public surface holding a request that long is its own problem.

`brain verify --probe-models` reports this combination explicitly. It is **not** reported by plain
`brain verify`, because that is the container healthcheck and failing it would restart containers that
are otherwise serving traffic.

## Ingestion

| Field | Type | Default | Meaning and validation |
|---|---|---|---|
| `ingest` | object | configured defaults | Ingestion pipeline settings. |
| `ingest.data_dir` | string | `data` | Root for stored document blobs. Packaged targets also mount a reserved inbox directory beneath this path. |
| `ingest.sensitivity_threshold` | integer | `3` | Topic sensitivity at or above this value holds model-tagged documents for review; nonnegative. |
| `ingest.default_tag` | string | `general` | Fallback tag when categorization yields no other tag. |
| `ingest.watch_interval_s` | number | `2.0` | Poll interval accepted by the watcher library; greater than `0`. No deployed 0.13.0 process starts that watcher. |
| `ingest.watch_settle_s` | number | `1.0` | Watcher-library debounce window; nonnegative. It has no effect until a caller starts the watcher. |

## Knowledge lifecycle

| Field | Type | Default | Meaning and validation |
|---|---|---|---|
| `knowledge` | object | configured defaults | Credibility, contradiction, feedback, correction, and entity-merge settings. |
| `knowledge.authority_by_source` | object of number values | `hunting: 0.95`, `table: 0.9`, `official_prose: 0.7`, `prose: 0.6`, `low_quality_ocr: 0.4` | Initial authority by source kind. |
| `knowledge.default_authority` | number | `0.6` | Authority for unlisted source kinds; from `0` through `1`. |
| `knowledge.contradiction_sim_threshold` | number | `0.75` | Similarity threshold for contradiction candidates; from `0` through `1`. |
| `knowledge.tie_delta` | number | `0.15` | Score difference treated as a contradiction tie; from `0` through `1`. |
| `knowledge.winner_boost` | number | `0.1` | Credibility increase for a resolved winner; from `0` through `1`. |
| `knowledge.loser_factor` | number | `0.5` | Credibility multiplier for the losing claim; from `0` through `1`. |
| `knowledge.feedback_alpha_human` | number | `0.1` | Credibility adjustment factor for human feedback; from `0` through `1`. |
| `knowledge.feedback_alpha_agent` | number | `0.03` | Credibility adjustment factor for agent feedback; from `0` through `1`. |
| `knowledge.feedback_daily_cap` | number | `0.1` | Maximum absolute daily credibility movement for one principal and claim; from `0` through `1`. |
| `knowledge.human_wrong_disputed_below` | number | `0.3` | Human `wrong` feedback marks a claim disputed after credibility falls below this value; from `0` through `1`. |
| `knowledge.correction_credibility` | number | `0.9` | Credibility assigned to an applied correction; from `0` through `1`. |
| `knowledge.superseded_credibility` | number | `0.1` | Credibility assigned to a superseded claim; from `0` through `1`. |
| `knowledge.corrections_per_person_per_day` | integer | `20` | Per-person daily correction count; at least `1`. |
| `knowledge.correction_war_threshold` | integer | `3` | Back-and-forth corrections before administrator escalation; at least `1`. |
| `knowledge.agents_can_correct` | boolean | `false` | Declared agent-correction switch. The current correction service routes every agent attempt to an owner and does not consume this field. |
| `knowledge.merge_min_similarity` | number | `0.82` | Minimum name similarity for an entity-merge proposal; from `0` through `1`. |
| `knowledge.merge_auto_apply_confidence` | number | `0.97` | Confidence at or above which a merge is applied without review; from `0` through `1`. |

## Database and ingress

| Field | Type | Default | Meaning |
|---|---|---|---|
| `database` | object | configured defaults | Database connection settings. |
| `database.dsn` | secret string or null | null | PostgreSQL DSN. Supply it through the environment. |
| `ingress` | object | configured defaults | External-origin and proxy-trust settings. |
| `ingress.public_origin` | string or null | null | External scheme and host advertised in OAuth metadata and hunt links, and the exact deployment origin admitted by the MCP Host and Origin allow-list. A configured value takes priority over request data. |
| `ingress.trusted_proxies` | array of strings | `[]` | IP networks whose forwarding headers may influence origin resolution. An empty array trusts no proxy. Invalid network entries are ignored by origin resolution. |

`ingress.public_origin` accepts only an HTTP(S) scheme plus an ASCII host, with no credentials, path, query, or fragment. Write internationalized domains in IDNA punycode. Configuration lowercases the scheme and host, removes a trailing slash and the default port, and keeps a nonstandard port.

When no public origin is configured, OAuth metadata accepts a request-derived origin only from an immediate peer inside `ingress.trusted_proxies`. Otherwise it advertises `https://localhost` rather than trusting caller-controlled host headers. MCP keeps DNS-rebinding protection enabled and admits loopback hosts and origins only, so a public proxy host is rejected until `ingress.public_origin` matches it. Host and Origin scheme/host casing is normalized. Default HTTP and HTTPS ports are equivalent; a nonstandard port must match exactly.

## Hunting delivery

| Field | Type | Required/default | Meaning and validation |
|---|---|---|---|
| `hunting` | object | configured defaults | Delivery settings for knowledge hunts. |
| `hunting.channel` | `none`, `smtp`, or `slack` | `none` | Active delivery channel. `none` records an undelivered route instead of claiming a message was sent. |
| `hunting.smtp` | object or null | null | SMTP channel configuration. |
| `hunting.smtp.host` | string | required when the SMTP object is supplied | SMTP host. |
| `hunting.smtp.port` | integer | `587` | SMTP port; from `1` through `65535`. |
| `hunting.smtp.sender` | string | `rsc-brain@localhost` | From address. |
| `hunting.smtp.username` | string or null | null | SMTP account name. |
| `hunting.smtp.password` | secret string or null | null | SMTP credential. Supply it through the environment. |
| `hunting.smtp.starttls` | boolean | `true` | Enables STARTTLS for SMTP delivery. |
| `hunting.slack` | object or null | null | Slack channel configuration. |
| `hunting.slack.bot_token` | secret string | required when the Slack object is supplied | Slack bot credential. Supply it through the environment. |
| `hunting.slack.default_channel` | string or null | null | Default Slack channel when a person has no channel override. |

Selecting `smtp` or `slack` requires the corresponding object and credential at runtime; an incomplete selected channel fails service construction.

## Periodic maintenance

The production worker registers these policies on its PostgreSQL-backed maintenance queue. Hunting
maintenance runs every minute; retention and skill maintenance run daily at 03:00 UTC. The schedules
are code-owned so malformed cron text cannot prevent worker boot.

| Field | Type | Default | Meaning and validation |
|---|---|---|---|
| `maintenance` | object | configured defaults | Audit-retention and periodic skill-maintenance policy. |
| `maintenance.audit_retention_days` | integer | `365` | Delete older audit rows during the daily job; from `1` through `3650`. |
| `maintenance.skill_cluster_threshold` | integer | `3` | Recurrent-gap count required before proposing a skill; from `1` through `1000`. |
| `maintenance.skill_idle_days` | integer | `60` | No-use interval before prompting an active skill's owner; from `1` through `3650`. The job never archives automatically. |

## Public limits

| Field | Type | Default | Validation floor and role |
|---|---|---|---|
| `limits` | object | configured defaults | Declared ceilings for public surfaces. Deployments may lower these values. |
| `limits.json_body_bytes` | integer | `1048576` | At least `1024`; general JSON-body ceiling. |
| `limits.ontology_bytes` | integer | `5242880` | At least `1024`; ontology-text ceiling. |
| `limits.free_text_bytes` | integer | `65536` | At least `256`; free-text field ceiling. |
| `limits.upload_bytes` | integer | `52428800` | At least `1024`; document-upload ceiling. |
| `limits.public_array_items` | integer | `100` | At least `1`; public array ceiling. |
| `limits.page_items` | integer | `100` | At least `1`; ordinary page ceiling. |
| `limits.admin_page_items` | integer | `200` | At least `1`; administrator page ceiling. |
| `limits.audit_export_rows` | integer | `10000` | At least `1`; audit CSV row ceiling. |
| `limits.window_days` | integer | `365` | At least `1`; time-window ceiling. |

The REST schema currently binds these defaults to specific request models and query parameters. Consult the [REST API reference](rest-api.md#quotas-and-limits) for the enforced endpoint-level limits; the presence of a configuration field does not add a transport validator to an endpoint that does not consume it.

## Logging

| Field | Type | Default | Meaning |
|---|---|---|---|
| `logging` | object | configured defaults | Process logging settings. |
| `logging.level` | string | `INFO` | Declared process log level. Current API logging setup uses `INFO` directly and does not consume this field. |
| `logging.json` | boolean | `true` | Declared output-format switch. `json` is the public alias for the internal `json_format` field. Current logging setup emits JSON regardless of this value. |

## Build identity

`RSC_BRAIN_BUILD_IDENTITY` is **not configuration and not an override.** The image build writes it,
and it is the only thing that determines what an instance reports as its version — through
`brain --version` and through `GET /api/v1/version`.

Setting it in a deployment environment lets the deployment declare a version the code is not, which
is the exact defect the identity exists to close: before this, `brain --version` reported `0.13.0` on
a build forty-nine commits past that tag, so a development instance and the published release were
indistinguishable. A value an operator can set reintroduces that with better ergonomics.

A build with no stamp — a source checkout run through `uv run` — reports the version line it descends
from with an explicit marker that it is **not** a published release. It never reports the bare
version, because an unknown build claiming to be a release is worse than one saying it does not know.

## Runtime consumption

The production composition root currently passes loaded capability routes, ingestion profile/tag settings, recall settings, public limits, ingress, hunting delivery, maintenance policy, and data directory into runtime dependencies. Database setup resolves `database.dsn` independently, with the environment variable taking priority.

Some validated fields are not yet connected to the long-running API or worker behavior:

- `reranker.enabled`, `vision.enabled`, and `telemetry.enabled` have no runtime consumer.
- `ingest.watch_interval_s` and `ingest.watch_settle_s` match watcher-function defaults, but neither the production composition root nor a packaged service starts a watcher process. The mounted inbox is not an operative source transport in 0.13.0.
- Most `knowledge` overrides are not passed into API/MCP lifecycle services; those services construct `KnowledgeConfig` defaults. The entity-merge CLI does load `knowledge.merge_min_similarity` and the complete knowledge config.
- `logging.level` and `logging.json` are not passed to logging setup.
- Runtime dependencies carry `limits`, but REST request models currently bind compile-time defaults rather than deployment overrides.

These fields remain part of the accepted `AppConfig` schema. Validation success confirms their shape, not that every declared switch has a runtime consumer.

## Secret handling

The secret-bearing fields are the five capability `api_key` fields, `database.dsn`, `hunting.smtp.password`, and `hunting.slack.bot_token`. They use Pydantic secret-string types, which mask their values in model representations. Masking is not encryption; the runtime can reveal the value to the component that connects to the provider.

Supply secrets as environment variables and keep them out of YAML. The model type does not reject a secret merely because it came from YAML, so this is an operator-enforced boundary. Secret environment-variable examples are:

```text
RSC_BRAIN_DATABASE__DSN
RSC_BRAIN_CAPABILITIES__EXTRACTOR__API_KEY
RSC_BRAIN_HUNTING__SMTP__PASSWORD
RSC_BRAIN_HUNTING__SLACK__BOT_TOKEN
```

## Validation

Configuration is validated before runtime collaborators are built. Invalid types, missing required capability blocks, out-of-range constrained values, an embedder dimension other than `1024`, or score weights that do not total `1.0` raise a Pydantic validation error.

Nested configuration models reject unknown keys. The runtime `Settings` wrapper ignores unknown root-level environment or input keys, so a misspelled root variable does not become an application field. A misspelled key inside a recognized nested object is rejected when that object is parsed.
