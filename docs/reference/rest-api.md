<!-- diataxis: reference -->

# REST API reference

The rsc-brain ASGI service exposes the JSON, form, multipart, OAuth, and console operations listed below. Operation tokens mirror the generated OpenAPI document.

## Authentication

The API uses several credential lanes. An OpenAPI bearer marker identifies the HTTP mechanism but does not by itself identify which token kind a route accepts.

| Route family | Accepted authentication |
|---|---|
| Project-scoped `/api/v1/admin/*` operations | Personal access token, OAuth access token, or console session bearer. A PAT or OAuth token already carries its project. A console session must also send `project=<slug>` and must belong to that project. |
| Platform `/api/v1/admin/*` operations | Personal access token, OAuth access token, or console session bearer. All resolve a current identity-only platform scope; no credential's project binding or `project` query grants platform authority. |
| Base ingestion and document routes | Project-scoped personal access token or OAuth access token. Console sessions are not resolved by this lane. |
| `GET /api/v1/version` | **No credential.** Open by decision: monitoring, support and the upgrade runbook need it without one, and it discloses only the published version. |
| `/api/v1/me*` | Console session bearer; human PAT and OAuth credentials are also accepted for the authoritative `/me` reread. |
| `POST /api/v1/auth/login` | Email and password in JSON; no prior bearer. |
| `POST /api/v1/auth/logout` | A console session bearer is useful but optional at runtime; a supplied session is revoked. |
| OAuth discovery, registration, and token exchange | No bearer. Authorization consent requires a console session cookie or `cks_…` bearer. |
| Hunt answer | The one-time `hunt_…` path token is the credential. |

Use `Authorization: Bearer <token>` for bearer routes. Tokens are resolved against current database state on every request. Missing, revoked, expired, or disabled-principal credentials do not resolve.

## Authorization

Bearer scope comes from the token, never from a request body, path slug, or `project` query parameter. For project-scoped console-session calls, `project` selects one existing membership; it does not create authority. Platform operations use an identity-only platform scope, so `project` is ignored and never widens authority.

The admin surface makes named capability decisions:

| Capability | REST operations that depend on it |
|---|---|
| `platform.project.create` | Create a project. |
| `platform.user.invite` | Invite a platform user. |
| `platform.project.list_all` | Gate access to the exclusively global project inventory; without it the endpoint returns `403`. |
| `platform.credential.revoke` | Revoke another user's OAuth connection. |
| `project.manage.read` | Project-management lists, audit access, people, sources, pending documents, and project metadata. |
| `project.config.write` | Create or change topics, sources, people, skills, and ontologies. |
| `project.settings.write` | Change query-text logging. |
| `document.decide` | Approve or reject a document after checking all current and replacement tags. |
| `gap.promote` | Promote a gap after checking its topics. |
| `hunt.manage` | Open a hunt over topics the caller holds. |
| `knowledge.read` | Topic-filtered claims, corrections, skills, timeline, graph, hunts, metrics, and observability reads. |
| `usage.read` | Read project usage. |
| `knowledge.review.decide` | Resolve chunks and merge proposals over fully authorized topics. |
| `correction.revert` | Revert as project administrator or topic owner, with authority over every target topic. |

Platform and project roles are independent. Platform administration grants no project-content visibility. `can_curate` grants review decisions only. See the [permissions matrix](permissions.md#capability-matrix).

Topic filters execute inside topic-bearing knowledge reads, queues, audit views, exports, and aggregates. A topical row must belong to the scoped project, overlap an allowed topic, and carry no sensitive topic that the caller lacks. Empty topic authority reveals no topical knowledge. Project-management metadata such as topic definitions and source configuration follows its named management capability. Object mutations require authority over every affected topic rather than one overlapping topic.

## Request models

Unless a row says otherwise, fields are JSON properties. “Optional” means the property may be absent or null where its type permits null.

| Model | Fields |
|---|---|
| `ProjectCreate` | Required lowercase DNS-style `slug` and `name`; optional `settings` object, default empty. |
| `ProjectUpdate` | Required integer `expected_version`; optional `name` and complete replacement `settings`. |
| `TopicCreate` | Required `slug` string (maximum 128 characters) and `name` string (maximum 512); optional `sensitivity` integer from 0 through 10, default 0, and `hard_window_days`. |
| `TopicUpdate` | Required integer `expected_version`; optional `name`, `sensitivity`, and `hard_window_days`. |
| `MembershipCreate` | Required target `user_id` and project `role`; optional restrictive `allowed_topics` and `can_curate`. |
| `MembershipUpdate` | Required integer `expected_version`; optional `role`, complete replacement `allowed_topics`, and `can_curate`. |
| `CredentialCreate` | Optional `name`; `kind` currently accepts `pat`. |
| `SourceCreate` | Required `name` string (maximum 512); `type` string (maximum 128), default `folder`; `policy` string (maximum 128), default `llm`; `default_tags` array, maximum 100 items; `review_if_sensitive` boolean, default true. |
| `UserInvite` | Required normalized email; optional `platform_role`, `project_role`, restrictive existing `allowed_topics`, and `can_curate`. A project administrator can create only a platform `member`; assigning `admin` or `owner` additionally requires platform invite authority. |
| `PersonCreate` | Required `name` string (maximum 512); `topics` array, maximum 100; `channels` object; `quiet_hours` object; optional `language` string, maximum 128. |
| `PersonUpdate` | Optional `topics` array, maximum 100; optional `channels`, `quiet_hours`, and `language`, with language maximum 128. |
| `HuntAsk` | Required `question` string, maximum 65,536 characters; `topics` array, maximum 100. |
| `SkillUpsert` | Required `markdown` string, maximum 1,048,576 characters. |
| `ChunkApprove` | Optional `tags` array, maximum 100. |
| `ApproveDoc` | Optional `tags` array, maximum 100. |
| `RejectDoc` | Required `reason` string, maximum 65,536 characters. |
| `OntologyUpload` | Required `name` (maximum 512) and `content` (maximum 5,242,880 characters); `format` maximum 128, default `turtle`; optional `uri_base` maximum 512. |
| `QueryTextLogging` | Required `enabled` boolean. |
| `LoginRequest` | Required `email` and `password` strings. |
| `CreatePatRequest` | Required `project` slug and optional `name`. |
| `HuntAnswer` | Required nonempty `answer`, maximum 65,536 characters; `decline` boolean, default false. |

## Admin project and identity operations

Project-scoped operations in this table accept optional query parameter `project`. It is needed to
bind a console session to a membership and does not switch a PAT or OAuth token to another project.
Platform operations ignore it; it cannot switch or widen their identity-only scope.

| Operation | Authority | Input | Success |
|---|---|---|---|
| `GET /api/v1/admin/projects` | Platform owner. | No additional input. | `200`; exact global lifecycle inventory with settings, status, version, and membership count. |
| `GET /api/v1/admin/projects/{slug}` | Platform owner. | Project slug. | `200`; lifecycle/settings state without project content. |
| `POST /api/v1/admin/projects` | Platform owner. | `ProjectCreate`; stable `Idempotency-Key` recommended. | `201`; authoritative project state and audit correlation. A same-key retry is `200` with `replayed: true`. |
| `PATCH /api/v1/admin/projects/{slug}` | Platform owner. | `ProjectUpdate`; stable `Idempotency-Key`. | `200`; exact before/after state. A stale version is audited `409` with current state. |
| `GET /api/v1/admin/projects/{slug}/delete-impact` | Platform owner. | Project slug. | `200`; dependency counts, current version, confirmation text, and `can_delete`. |
| `DELETE /api/v1/admin/projects/{slug}` | Platform owner. | `expected_version`, exact `confirm`, and stable `Idempotency-Key`. | `200`; recoverable hard multistore deletion. The durable `deleting` checkpoint resumes after an AGE/filesystem interruption, and only a completed saga is replayed. The `default` project is an audited `409`; replay survives deletion. |
| `GET /api/v1/admin/users` | Project administrator. | Optional opaque `cursor` and bounded `limit`. | `200`; scoped identities and current authority. |
| `POST /api/v1/admin/users/invite` | Project administrator. | `UserInvite`; stable `Idempotency-Key`. | `201`; identity, restrictive membership, expiry, one-display invitation token, and audit correlation. |
| `POST /api/v1/admin/users/{user_id}/password-reset` | Project administrator. | Acknowledged impact; stable `Idempotency-Key`. | `201`; one-display reset token and expiry. |
| `POST /api/v1/admin/users/{user_id}/disable` | Project administrator for a single-project identity; platform administrator with membership for a cross-project identity. | Expected active status and acknowledged impact; stable `Idempotency-Key`. | `200`; disabled identity plus complete session/PAT/OAuth revocation. Cross-project impact without platform authority is an audited `403` with no side effect. |
| `GET /api/v1/admin/users/{user_id}/credentials` | Project administrator. | Target user. | `200`; PAT metadata only, never secret values or hashes. |
| `POST /api/v1/admin/users/{user_id}/credentials` | Project administrator. | `CredentialCreate`; stable `Idempotency-Key`. | `201`; active metadata and a secret shown exactly once. |
| `POST /api/v1/admin/credentials/{credential_id}/rotate` | Project administrator. | Expected version; stable `Idempotency-Key`. | `201`; advanced metadata and a new secret shown exactly once; old secret stops resolving. |
| `DELETE /api/v1/admin/credentials/{credential_id}` | Project administrator. | `expected_version`; stable `Idempotency-Key`. | `200`; revoked metadata. Stale versions are audited `409`. |
| `GET /api/v1/admin/topics` | `project.manage.read` | No additional input. | `200`; topic slugs and sensitivity values. |
| `POST /api/v1/admin/topics` | `project.config.write` | `TopicCreate`. | `201`; topic identifier, slug, and the creator's resulting topic grant. |
| `PATCH /api/v1/admin/topics/{slug}` | Project administrator. | `TopicUpdate`; stable `Idempotency-Key`. | `200`; exact before/after topic state and incremented version; stale writes are audited `409`. |
| `GET /api/v1/admin/memberships` | `project.manage.read` | No additional input. | `200`; each member's identifier, email, role, topic authority and curate flag. |
| `POST /api/v1/admin/memberships` | `project.config.write` | `MembershipCreate`; the project comes from the caller's scope, never the body. | `201`; membership identifier, user and role. `400` on an unknown role; `409` when the membership already exists. |
| `PATCH /api/v1/admin/memberships/{user_id}` | Project administrator. | `MembershipUpdate`; stable `Idempotency-Key`. | `200`; exact before/after authority and incremented version. Live session/PAT/OAuth reads see changes immediately. |
| `DELETE /api/v1/admin/memberships/{user_id}` | `project.config.write` | No body. | `200`; the detached user. `404` when there is no such membership in the caller's project. |
| `POST /api/v1/admin/topics/{slug}/grants` | `project.config.write` | `TopicGrant`; the project comes from the caller's scope, never the body. | `201`; the principal's resulting topic authority. `400` when the slug is not a topic of that project; `404` when the user has no membership there, so denied stays indistinguishable from absent. |
| `DELETE /api/v1/admin/topics/{slug}/grants/{user_id}` | `project.config.write` | No body. | `200`; the principal's remaining topic authority. Idempotent. `404` when the user has no membership in the caller's project. |
| `GET /api/v1/admin/sources` | `project.manage.read` | No additional input. | `200`; source records and categorization policy. |
| `POST /api/v1/admin/sources` | `project.config.write` | `SourceCreate`. | `201`; source identifier and name. |
| `GET /api/v1/admin/persons` | `project.manage.read` | No additional input. | `200`; minimized routing summaries with channel types, active-hunt impact and version, never contact values. |
| `GET /api/v1/admin/persons/{person_id}` | `project.manage.read` | Required path `person_id`. | `200`; authorized contact detail and current version; foreign and absent identifiers are both `404`. |
| `GET /api/v1/admin/persons/{person_id}/delete-impact` | `project.manage.read` | Required path `person_id`. | `200`; authoritative `can_delete`, active-hunt count and version. |
| `POST /api/v1/admin/persons` | `project.config.write` | `PersonCreate`. | `201`; person identifier, name and initial version. |
| `PATCH /api/v1/admin/persons/{person_id}` | `project.config.write` | Required path `person_id`; `PersonUpdate`, including required `expected_version`. | `200`; authoritative identifier, language and incremented version. A stale version is `409`. |
| `DELETE /api/v1/admin/persons/{person_id}` | `project.config.write` | Required path `person_id` and query `expected_version`. | `200`; identifier and `removed: true`. Stale versions and active-hunt dependencies are `409`. |
| `DELETE /api/v1/admin/connections/{connection_id}` | `platform.credential.revoke` | Required path `connection_id`. | `200`; revoked connection identifier. |

## Admin document and review operations

| Operation | Authority | Input | Success |
|---|---|---|---|
| `GET /api/v1/admin/documents/pending` | `project.manage.read` | Optional `project`. | `200`; pending document identifiers, titles, and proposed tags. |
| `GET /api/v1/admin/documents/pending/preview` | `project.manage.read` | Optional `project`. | `200`; pending records with source, 280-character preview, and untrusted-data marker. |
| `POST /api/v1/admin/documents/{document_id}/approve` | `document.decide` | Required path `document_id`; `ApproveDoc`; optional `project`. | `200`; identifier and resulting ingestion phase. |
| `POST /api/v1/admin/documents/{document_id}/reject` | `document.decide` | Required path `document_id`; `RejectDoc`; optional `project`. | `200`; identifier and resulting ingestion phase. |
| `GET /api/v1/admin/review-queue` | `knowledge.read` | Optional query `source` and `project`. | `200`; topic-filtered items, untrusted previews, and counts by source. |
| `POST /api/v1/admin/review-queue/chunks/{chunk_id}/resolve` | `knowledge.review.decide` | Required path `chunk_id`; required query `approve` boolean; `ChunkApprove`; optional `project`. | `200`; chunk identifier and outcome. Current and replacement tags are authorized together. |
| `POST /api/v1/admin/review-queue/merges/{proposal_id}/resolve` | `knowledge.review.decide` | Required path `proposal_id`; required query `approve` boolean; optional `project`. | `200`; proposal identifier and outcome. Every topic associated with both entities is checked. |

## Admin knowledge and hunting operations

| Operation | Authority | Input | Success |
|---|---|---|---|
| `GET /api/v1/admin/claims/disputed` | `knowledge.read` | Optional `project`. | `200`; visible disputed claims. |
| `GET /api/v1/admin/contradictions/resolutions` | `knowledge.read` | Optional `project`. | `200`; visible contradiction resolution records and scores. |
| `GET /api/v1/admin/corrections` | `knowledge.read` | Optional queries `status_filter`, `target_claim`, `author`, and `project`. | `200`; correction feed. |
| `GET /api/v1/admin/corrections/metrics` | `knowledge.read` | Optional `project`. | `200`; correction metrics. |
| `POST /api/v1/admin/corrections/{correction_id}/revert` | `correction.revert` after a visible-target lookup | Required path `correction_id`; optional `project`. | `200`; outcome status and explanation. |
| `GET /api/v1/admin/skills` | `knowledge.read` | Optional queries `state` and `project`. | `200`; topic-authorized frontmatter summaries with canonical owner UUID, tags, status, stale flag, dependencies and version; procedure bodies are absent. |
| `GET /api/v1/admin/skills/{slug}` | `knowledge.read` | Required path `slug`; optional `project`. | `200`; canonical Markdown with owner UUID and body. Hidden and absent skills are not distinguished. |
| `POST /api/v1/admin/skills` | `project.config.write` | `SkillUpsert` whose lifecycle state is `proposed`; optional `project`. Owner is an exact same-project UUID or unique exact name. | `201`; skill identifier and slug. Activation always goes through validation; absent, ambiguous and foreign owners share one non-disclosing error. |
| `PUT /api/v1/admin/skills/{slug}` | `project.config.write` | Required path `slug`; `SkillUpsert` preserving slug/state and carrying the current frontmatter version; optional `project`. | `200`; owner/body/frontmatter replaced, stale state resolved, pending stale delivery cancelled and version incremented. A stale version is `409`. |
| `POST /api/v1/admin/skills/{slug}/validate` | `project.config.write` | Required path `slug`; required `Idempotency-Key`; `VersionedCommand`; optional `project`. | `200`; a validated proposed skill becomes active at the next version with audit correlation. Same-key retries replay across restarts without a second transition or audit; missing dependencies and stale versions conflict. |
| `POST /api/v1/admin/skills/{slug}/archive` | `project.config.write` | Required path `slug`; required `Idempotency-Key`; `VersionedCommand`; optional `project`. | `200`; authoritative archived view and audit correlation. Same-key retries replay; stale versions are `409`. |
| `GET /api/v1/admin/timeline` | `knowledge.read` | Optional queries `topic`, `entity`, `as_of`, and `project`. | `200`; permission-filtered timeline. `as_of` is an ISO date. |
| `GET /api/v1/admin/graph/entity` | `knowledge.read` | Query `name`, default empty, maximum 512 characters; `limit` 1–200, default 25; `offset` at least 0, default 0; optional `project`. | `200`; visible center, neighbors, edges, total, offset, and limit. No visible center returns `404`. |
| `GET /api/v1/admin/gaps` | `project.manage.read` | Optional `audience` (`human` or `agent`) and `project`. Other audience values select all. | `200`; visible gaps. |
| `POST /api/v1/admin/gaps/{gap_id}/promote` | `gap.promote` | Required path `gap_id`; optional `project`. | `201`; hunt identifier and state. |
| `GET /api/v1/admin/hunts` | `knowledge.read` | `open_only` boolean, default false; optional `project`. | `200`; hunts filtered before serialization by their immutable topic snapshot. |
| `GET /api/v1/admin/hunts/{hunt_id}` | `knowledge.read` | Required path `hunt_id`; optional `project`. | `200`; one authorized hunt; hidden and absent identifiers are both `404`. |
| `POST /api/v1/admin/hunts/ask` | `hunt.manage` | `HuntAsk`; optional `Idempotency-Key` header and `project`. | `201` on creation or `200` on replay; persisted topics, routed person, delivery/throttle state and audit correlation. |
| `GET /api/v1/admin/ontologies` | `knowledge.read` | Optional `project`. | `200`; stored ontology versions and active state. |
| `POST /api/v1/admin/ontologies` | `project.config.write` | `OntologyUpload`; optional `project`. | `201`; ontology identifier and name. Invalid RDF returns `422`. |
| `GET /api/v1/admin/ontologies/coverage` | `knowledge.read` | `top` integer 1–100, default 10; optional `project`. | `200`; anchored coverage and leading unanchored names. |

## Admin audit, usage, and observability operations

| Operation | Authority | Input | Success |
|---|---|---|---|
| `GET /api/v1/admin/audit` | `project.manage.read` | Optional `action`, `tool`, `principal_type`, `principal_id`, `denied`, `since`, `until`, and `project`; `limit` 1–200, default 100. | `200`; topic-filtered audit rows, newest first. Dates accept ISO date or timestamp strings. |
| `GET /api/v1/admin/audit/export` | `project.manage.read` | Same filters; `limit` 1–10,000, default 10,000; optional `project`. | `200` CSV attachment. Export uses the same topic filter as list and records an export audit entry. |
| `GET /api/v1/admin/usage` | `usage.read` | `days` 1–365, default 7; optional `project`. | `200`; per-capability and day usage for the scoped project. |
| `GET /api/v1/admin/metrics/product` | `knowledge.read` | `window_days` 1–365, default 30; optional `project`. | `200`; adoption, quality, knowledge, and health metric families. |
| `GET /api/v1/admin/observability/activity` | `knowledge.read` | Optional `project`. | `200`; authorized recall totals, denied count, active principals, p95 duration, and daily counts. |
| `GET /api/v1/admin/observability/recalls` | `knowledge.read` | Optional `principal_type`, `denied`, and `project`; `limit` 1–200, default 100. | `200`; authorized recall audit stream. |
| `GET /api/v1/admin/observability/health` | `knowledge.read` | Optional `project`. | `200`; database state, pending-approval count, and ingest-error count for the project. |
| `GET /api/v1/admin/observability/ingest` | `knowledge.read` | Optional `project`. | `200`; ingestion checkpoints and up to 200 most recent extraction errors. |
| `GET /api/v1/admin/settings/query-text-logging` | `knowledge.read` | Optional `project`. | `200`; current `enabled` value. The project default is enabled. |
| `PUT /api/v1/admin/settings/query-text-logging` | `project.settings.write` | `QueryTextLogging`; optional `project`. | `200`; resulting `enabled` value. |

## Base ingestion operations

These routes resolve only a project-scoped PAT or OAuth access token.

| Operation | Input | Success |
|---|---|---|
| `POST /api/v1/projects/{slug}/documents` | Required path `slug`; multipart `file`; optional form field `source`. The path project must equal the token project. | `202`; `document_id`, pipeline `status`, and `duplicate` flag. Processing may continue through the queue. |
| `GET /api/v1/ingest/runs` | No request fields. | `200`; runs with phase, completed stages, chunk/claim/table counts, discarded count, and error. |
| `POST /api/v1/documents/{document_id}/approve` | Required path `document_id`; optional JSON body that is an array of replacement tag strings. | `200`; identifier, resulting phase, and generated-claim count. Requires document-decision authority over existing and replacement tags. |
| `POST /api/v1/documents/{document_id}/reject` | Required path `document_id`; required form field `reason`. | `200`; identifier and resulting phase. Requires document-decision authority. |

## Instance identity

One operation, and the only one in the API that accepts no credential.

| Operation | Input | Success |
|---|---|---|
| `GET /api/v1/version` | No request fields, no credential. | `200`; `version` is the published version this instance is, or that version with a `+dev` marker when the build is not a published release. Answers while the database and model providers are unreachable. |

The value is the **public form** of the build identity: it names the published version and never the
source revision. `brain --version` inside the instance reports the full form, which distinguishes
two different unpublished builds that answer identically here.

The identity is fixed when the artifact is built. It cannot be set by the deployment — see
[configuration](configuration.md#build-identity).

## Console authentication and self-service operations

| Operation | Authentication and input | Success |
|---|---|---|
| `POST /api/v1/auth/login` | Public; `LoginRequest`. | `200`; newly issued `session_token`. |
| `POST /api/v1/auth/invitations/accept` | Public; one-display invitation token and password. | `200`; authoritative active identity, unchanged membership, and one persisted audit correlation. The token is single-use. |
| `POST /api/v1/auth/password-reset/complete` | Public; one-display reset token and new password. | `200`; authoritative active identity, `completed` status, and one persisted audit correlation. The token is single-use. |
| `POST /api/v1/auth/logout` | Optional console session bearer. | `200`; `{ "ok": true }`. A supplied session is revoked; an absent bearer is still idempotent success. |
| `GET /api/v1/me` | Console session bearer. | `200`; user identity, owner flag, and project memberships with roles, topics, and curation flags. |
| `GET /api/v1/me/pats` | Console session bearer. | `200`; the user's PAT metadata across memberships. Plaintext tokens are never listed. |
| `POST /api/v1/me/pats` | Console session bearer; `CreatePatRequest`. | `201`; PAT identifier and plaintext token. The user must be a member of the named project. |
| `DELETE /api/v1/me/pats/{pat_id}` | Console session bearer; required path `pat_id`. | `200`; revoked identifier. A PAT owned by another user has the not-found shape. |
| `GET /api/v1/me/connections` | Console session bearer. | `200`; the user's OAuth connections. |
| `DELETE /api/v1/me/connections/{connection_id}` | Console session bearer; required path `connection_id`. | `200`; revoked connection identifier. Another user's connection has the not-found shape. |

## OAuth operations

| Operation | Input | Success and behavior |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | No input. | `200`; issuer plus authorization, token, registration, grant, response, PKCE, and token-auth metadata. Advertised URLs come from trusted origin resolution. |
| `POST /oauth/register` | JSON with nonempty `redirect_uris` array; optional `client_name`, `grant_types`, `response_types`, `token_endpoint_auth_method`, and `scope`. | `201`; public `client_id`, normalized metadata, and `token_endpoint_auth_method: none`. |
| `GET /oauth/authorize` | OAuth query values including `client_id`, registered `redirect_uri`, `response_type=code`, PKCE challenge and method, and optional scope. Requires an active console session cookie or session bearer. | `200` consent HTML; invalid client/redirect returns `400`; no membership returns `403`. |
| `POST /oauth/authorize` | Original OAuth query plus form fields `consent` and `membership_project_id`. The selected project must be one of the signed-in user's memberships. | Authlib authorization response or denial; an issued code is single-use and expires after 300 seconds. |
| `POST /oauth/token` | Form values for `authorization_code` with `client_id`, code, redirect URI, and PKCE verifier, or `refresh_token` with client and refresh token. | OAuth token response. Access tokens expire after 3600 seconds; refresh use rotates the refresh token. |

OAuth clients are public and authenticate at the token endpoint with method `none`. Redirect URIs are matched against the values stored at registration.

## Hunt answer operation

| Operation | Input | Success |
|---|---|---|
| `POST /hunt/{token}/answer` | Required one-time path `token`; `HuntAnswer` JSON. | `200`; hunt identifier and state. Unknown, consumed, correction-review, or non-awaiting tokens share one `404` response. |

A valid non-decline answer becomes knowledge with person provenance and credibility `0.95`. A decline consumes the token without creating an answer claim.

The HTML hunt lookup checks `expires_at`. The JSON answer and decline handlers currently check token and lifecycle state but do not compare `expires_at`; they rely on the scheduled expiration transition to move overdue hunts out of the awaiting state.

## Errors

FastAPI HTTP errors use a JSON `detail` field. Request-model and parameter validation normally returns `422` with a structured `detail` array. OAuth routes use OAuth-style JSON with an `error` field.

| Status | Meaning and shape |
|---|---|
| `400` | OAuth client or redirect input is invalid, or Authlib rejects a protocol request. |
| `401` | Required bearer/session is absent or invalid; sign-in credentials are invalid; OAuth consent has no session. Unknown email, wrong password, and inactive user share `invalid credentials`. |
| `403` | Authenticated caller lacks a nonsensitive capability, OAuth user has no selected membership, or operator authority is required on the unlisted scrape endpoint. |
| `404` | Target is absent, belongs to another project, or is hidden where existence is sensitive. These cases intentionally share a not-found shape. |
| `422` | OpenAPI/Pydantic validation failed, an answer is blank, skill frontmatter is invalid, or ontology parsing failed. |
| `429` | Console sign-in budget is exhausted. The response includes `Retry-After`. |

Domain mutations can return a `200` result whose status or outcome records a refusal or queued decision. Clients must read command-specific fields rather than assuming every `2xx` mutation changed active knowledge.

## Quotas and limits

Failed console sign-ins use PostgreSQL-backed 15-minute windows shared by replicas: 10 failures for one normalized account or 20 for one immediate source network exhaust the budget. A successful sign-in clears the account budget. An exhausted request returns `429` before password verification and includes seconds until the window boundary.

The REST surface has no general per-principal request-rate quota. MCP has a separate quota contract.

The generated schema enforces these endpoint-level query ceilings:

| Parameter | Ceiling |
|---|---:|
| Audit and recall-stream `limit` | 200 |
| Entity graph `limit` | 200 |
| Audit export `limit` | 10,000 |
| Ontology coverage `top` | 100 |
| Usage `days` and product metrics `window_days` | 365 |

Request models enforce the string and array maxima in [Request models](#request-models). The implementation names these ceilings with byte-oriented configuration fields, but Pydantic string `max_length` validation counts characters.

The current REST application does not install a global content-length middleware. `limits.json_body_bytes` is applied to the skill Markdown field, not to every JSON request. `limits.upload_bytes` is declared in configuration, but the upload route currently reads the file without consulting that value. Endpoints without a documented pagination input do not acquire one from `limits.page_items`. These fields therefore are not transport guarantees beyond the route validators named above.

## Trust and provenance

API content originating in documents or user submissions is untrusted data. Review-queue items and pending-document previews carry `content_type: "untrusted_data"`. Timeline entries returned by the admin API carry the same marker plus claim identifier, credibility, tags, validity interval, current-state flag, and source document identifier.

Default timeline/recall semantics distinguish current and historical knowledge. `as_of` returns claims valid at a date. Superseded claims retain validity end timestamps rather than disappearing, which preserves correction history.

Audit views include principal type and ID, validated delegation, trace ID, action/tool, query hash, optional query text, duration, topics, result count, and denial state. Query text is stored only while the project setting is enabled; its default is enabled. Audit list, aggregates, recall stream, and CSV export all apply topic visibility inside their queries. CSV export neutralizes formula-leading text and strips unsafe control characters before a spreadsheet can interpret cells.

OAuth metadata never trusts a caller-controlled `Host` or forwarding header by default. It uses configured `ingress.public_origin`; otherwise it accepts request origin only from an immediate peer in `ingress.trusted_proxies`; otherwise it advertises `https://localhost`.

The OpenAPI contract does not include the mounted `/mcp` transport, the HTML `GET /hunt/{token}` and form `POST /hunt/{token}` routes, or `/metrics`. The metrics route is also not authorized by any current principal type. Unknown method/path combinations receive the framework's not-found or method-not-allowed response; no unregistered REST command is inferred from a CLI or MCP name.
