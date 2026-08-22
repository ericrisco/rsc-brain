<!-- diataxis: reference -->

# MCP reference

rsc-brain mounts a stateless MCP streamable-HTTP server at `/mcp`. The same endpoint serves every project; the bearer credential determines the principal, project, role attributes, and visible topics.

## Authentication

Every tool call requires an HTTP header of the form `Authorization: Bearer <token>`. The resolver accepts a project-scoped personal access token or OAuth access token. A token is looked up on every call and fails authentication when it is missing, malformed, unknown, revoked, expired, bound to an inactive human, or bound to an inactive agent.

The client cannot supply a project identifier as tool input. Project scope comes from the credential. Personal access tokens and OAuth access tokens are stored as SHA-256 hashes, not plaintext.

### Delegation

Most tools accept `on_behalf_of`. Delegation is valid only when the authenticated caller is an agent and the named human is active and belongs to the same project. The effective topic set is the intersection of the agent's topics and the human membership's topics. The acting principal remains the agent, and audit records retain the delegated human identifier.

Dynamic tool discovery has no tool arguments, so delegated `tools/list` uses the `X-RSC-On-Behalf-Of` request header. Dynamic and generic skill invocation accept `on_behalf_of`; if the header and argument are both present, they must be identical. Discovery and invocation resolve the credential, represented user, and current authority again on every request.

Invalid delegation has the same `AUTH_INVALID` error class as an invalid credential. Delegation never changes projects or grants a console role.

## Authorization

All reads apply project and topic predicates before rows, counts, or fragments become observable. A chunk or claim must overlap an allowed topic and must not carry a sensitive topic that the caller lacks. Empty topic authority reads no topical knowledge.

| Tool class | Authorization behavior |
|---|---|
| Recall, timeline, documents, and skills | Return only data visible to the token scope. A skill is visible only when the caller holds its complete topic-tag set. Hidden and absent data use the same result shape. |
| Feedback | Applies feedback through the authenticated scope; claim identifiers do not rebind the request to another project. |
| Submission | Requires at least one nonempty tag, and every submitted tag must be in the effective topic set. The project `agent_writes` policy controls activation. |
| Correction | Resolves the target through visible claims. Human topic owners may apply corrections; agents and nonowners route suggestions to an owner. Sensitive corrections require a second owner. |

`include_superseded=true` on recall is honored only when the resolved scope has curation authority. Other callers receive the normal current-knowledge view.

## Tools

### `recall`

Retrieves scored fragments for a query and abstains below the configured relevance threshold.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `query` | string | required | Natural-language or identifier query. |
| `top_k` | integer | `8` | Maximum requested result count after scoring. Candidate retrieval has an internal width cap of `200`. |
| `topics_hint` | array of strings or null | null | Topic hints for retrieval and gap registration. Hints do not grant topic access. |
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |
| `as_of` | string or null | null | ISO date used for a point-in-time view. Invalid ISO dates fail the call. |
| `include_historical` | boolean | `false` | Selects the historical temporal mode. |
| `include_superseded` | boolean | `false` | Requests superseded claims; effective only for a curator scope. |

The result contains `found`, `fragments`, `gap_registered`, and nullable `degraded`. Each fragment contains `text`, `claim_ids`, the display label `document`, stable `document_id` and `chunk_id`, nullable `page`, `credibility`, `tags`, `content_type`, nullable `valid_from`, nullable `valid_to`, and `is_current`. When nothing visible clears the threshold, `found` is false; a gap can be registered without disclosing whether matching hidden knowledge exists. `degraded` is null on a normally judged verdict and otherwise states why this one is worth less than it looks — an unreachable reranker whose abstention fell back to the blended threshold, candidates the reranker did not score, or an answer resting on a batch score that could not be confirmed alone. It names no knowledge and no principal, so it discloses nothing the verdict does not.

Before either recall or skill context crosses the MCP boundary, one project-accounted topicalizer batch checks every final fragment against the full project taxonomy and the resolved effective topic set. Only an exact allowed verdict survives. Missing, partial, unknown, timed-out, failed, or unauthorized verdicts are omitted; an all-omitted recall returns the ordinary `found: false` shape. Blocked chunks enter review and an alert is attempted through the configured hunting channel. Equivalent alerts are suppressed for 60 minutes, and alert failure never restores blocked data.

### `timeline`

Returns the oldest-first evolution of claims for a topic or entity.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `topic` | string or null | null | Topic selector. A topic outside the effective scope produces an empty result. |
| `entity` | string or null | null | Entity name, including recorded canonical names and aliases. |
| `as_of` | string or null | null | ISO date; entries must be valid at that date. |
| `top_k` | integer | `50` | SQL result limit. |
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |

At least one of `topic` or `entity` is needed for a nonempty result. The output contains `found`, the echoed selectors, and `entries`. Entries contain claim text and identifiers, subject/predicate/object fields, credibility, tags, `content_type`, validity bounds, current-state flag, and source document identifier.

### `list_skills`

Lists active reusable procedures visible to the effective topic scope.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |

The result contains `skills`; each summary has `slug`, `title`, nullable `when_to_use`, and `stale`.

### `run_skill`

Returns one visible skill's Markdown instructions plus supporting recall fragments.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `slug` | string | required | Skill slug. |
| `args` | object or null | null | Reserved argument map. It is accepted but is not interpreted by the current skill runner. |
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |

The output contains `found`, `instructions`, and `context_fragments`. A hidden or absent slug returns `found: false`, empty instructions, and no fragments. Supporting fragments use the same provenance and untrusted-data fields as recall.

Context is restricted to the skill's declared `depends_on` UUIDs. A same-project Entity UUID maps to the canonical entity's deterministic typed endpoint key; a same-project Topic UUID maps to its slug. Eligible chunks must also overlap the skill tags, be fully authorized, published, review-safe, and current under the shared retriever. Missing, invalid, or foreign dependencies contribute no context and never trigger a broad descriptive fallback. The returned fragments are a deterministic highest-ranked prefix capped at 2,000 approximate tokens, even when the global recall budget is larger.

### `skill_<slug>` dynamic tools

Every active skill visible to the effective scope appears in authenticated `tools/list` as `skill_<slug>`. Proposed, archived, partially authorized, sensitive, and foreign-project skills are omitted. Discovery is read-through: creating, archiving, retagging, or changing authority affects the next list without a process-level authorization cache.

Each dynamic tool accepts only `args` and `on_behalf_of`; its output schema and execution semantics are the same as `run_skill` for that slug. Invocation reauthenticates and rereads skill state independently of discovery, so a stale client-side tool definition cannot authorize an archived or newly hidden skill. Unauthorized, foreign, and nonexistent dynamic names all return the same `found: false` shape. Generic and dynamic invocations produce separate `run_skill` audit rows whose `tool` field identifies the surface used.

### `get_document`

Fetches visible stored chunk text and document metadata.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `document_id` | string | required | Document UUID. |
| `page` | integer or null | null | Exact stored page selector. Null joins all visible pages in page order. |
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |

The output contains `title`, `page_text`, `content_type`, `document_id`, `project_id`, and `metadata`. Metadata contains document `status` and `tags` for a visible result. A missing document, another project's document, or a document with no visible chunks returns empty title/text/identifiers and empty metadata.

### `report_feedback`

Applies credibility feedback to visible claims.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `claim_ids` | array of strings | required | Claim identifiers. |
| `signal` | `helpful`, `wrong`, or `outdated` | required | Feedback signal. |
| `note` | string or null | null | Reserved note. The current handler accepts it but does not persist it. |
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |

Human feedback uses adjustment factor `0.1`; agent feedback uses `0.03`. Daily credibility movement is capped at `0.1` for each principal/claim pair. Human negative feedback can mark a low-credibility claim disputed; agent feedback does not. The output is `{ "ok": true }` after the handler completes.

### `submit_knowledge`

Submits one fact under the project's agent-write policy.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `text` | string | required | Claim text. |
| `idempotency_key` | string | required | Retry key scoped to project and principal. An empty value is rejected. |
| `entities` | array of strings or null | null | Entity hints; the first value becomes the submitted claim's subject. |
| `tags` | array of strings or null | null | Required in practice: at least one nonempty tag, all within effective topic authority. |
| `on_behalf_of` | string or null | null | Human user identifier for validated agent delegation. |

A retry with the same project, principal, and idempotency key returns the original status and claim identifiers. The output contains `ok`, `status`, and `claim_ids`.

| Project policy | Agent result | Human result |
|---|---|---|
| `quarantine` (default) | `quarantined`; the claim is excluded from recall until review. | `active`. |
| `direct` | `active`, with credibility capped at `0.6`. | `active`. |
| `off` | `rejected`. | `active`. |

Missing or unauthorized tags return `rejected`. Submitted provenance records the acting principal and validated delegation.

### `correct_knowledge`

Submits an owner-authority correction or routes a suggestion to the topic owner.

| Input | Type | Required/default | Meaning |
|---|---|---|---|
| `correction` | string | required | Replacement statement. |
| `claim_id` | string or null | null | Exact target. Use this alone, or use both `topic` and `statement`. |
| `topic` | string or null | null | Required alongside `statement` for the alternate target form. The current resolver does not apply it as an additional candidate filter. |
| `statement` | string or null | null | Existing statement embedded for candidate resolution when `claim_id` is absent. |
| `reason` | string or null | null | Audit reason. |
| `on_behalf_of` | string or null | null | Delegated attribution assertion. The value must match delegation already present in the resolved scope. The current wrapper authenticates the base scope for this tool, so a non-null value is rejected unless that scope already carries the same delegation. |
| `dry_run` | boolean | `false` | For a human topic owner, previews the predicted apply/pending outcome without changing claims. Agent and nonowner routing occurs before this check and can still create a routed correction. |

Exactly one target form is valid: `claim_id`, or the `topic`/`statement` pair. Output fields are `status`, `explanation`, `candidates`, nullable `correction_id`, and nullable `reverted_hint`. Status values are `applied`, `pending_confirmation`, `routed_to_owner`, `needs_disambiguation`, and `rejected`. Applied corrections preserve the superseded claim with a validity end, which supports timelines and reversal.

## Errors

Authentication and quota failures are MCP tool errors formatted with a stable leading code:

| Code | Meaning | Additional data |
|---|---|---|
| `AUTH_INVALID` | Credential or delegation did not resolve. Missing, malformed, revoked, expired, and disabled-principal cases share this code. | None. |
| `RATE_LIMITED` | Per-minute rate or agent daily budget was exceeded. | The tool-error text includes `retry_after=<seconds>`. |
| `INTERNAL` | Reserved typed code for an internal tool failure. | No stable additional fields. |

Schema/type failures and invalid ISO dates can be reported by the MCP transport or tool runtime rather than as a successful output object. Domain refusals use tool output where defined: recall uses `found: false`, submission uses `status: rejected`, correction uses `status: rejected`, and hidden skills/documents use their empty-result shapes.

## Quotas and limits

Quota counters are persisted in PostgreSQL and shared across server workers.

| Principal | Per-minute calls | Daily non-submission calls | Daily submissions |
|---|---:|---:|---:|
| Human | `60` | no daily quota | no daily quota |
| Agent | `300` | `5000` | `1000` |

The per-minute window starts at the minute boundary. Agent daily budgets reset at midnight UTC. All tools consume the per-minute counter; `submit_knowledge` consumes the write bucket, while the other registered tools consume the recall bucket. `retry_after` points to the next minute boundary or UTC midnight.

These are server-construction defaults in `QuotaConfig`; they are not fields in `AppConfig`. Tool schemas provide types and defaults but do not publish hard maxima for text, arrays, `top_k`, or timeline length. Recall candidate retrieval remains capped internally at `200` even when a larger `top_k` is requested.

## Trust and provenance

Retrieved company content is data, not executable instruction. Recall fragments, timeline entries, and document reads carry `content_type: "untrusted_data"`. Clients must not follow imperative text embedded in those fields.

Recall provenance includes source document, page, claim identifiers, credibility, tags, temporal bounds, and current-state status. Timeline entries preserve claim-level source and validity data. Generic and dynamic skill tools keep skill instructions separate from untrusted supporting fragments; dependency-grounded fragments retain the complete recall provenance fields.

Default recall selects knowledge valid now. `as_of` selects knowledge valid at a date, `include_historical` opens the historical view, and every returned temporal record labels `valid_from`, `valid_to`, and `is_current`. Superseded claims remain stored rather than being erased.

The server does not redact fragment text and does not expose a graph-dump tool. Permission filters decide which complete fragments are returned. Recall and timeline record a query hash in the audit log; raw query text is stored only while the project's query-text logging setting is enabled. Audit records identify the acting principal, delegated user, topics used, result count, duration where measured, and denial state.
