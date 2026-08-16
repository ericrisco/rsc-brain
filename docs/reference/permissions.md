<!-- diataxis: reference -->

# Permissions reference

rsc-brain uses two distinct authority types. Project-owned data requires a `ProjectScope`, which
binds an authenticated principal to one real membership and carries its project, allowed topics,
project role, platform role, curation flag, and validated delegation. Downstream stores receive
this combined scope rather than a caller-supplied project identifier. Platform lifecycle operations
resolve a separate `PlatformIdentityScope` with only the authenticated human identity and platform
role: it has no project, membership, topics, or curation state and cannot authorize content.

## Principal and credential types

### Principals

| Principal type | Identity source | Authority characteristics |
|---|---|---|
| `human` | Active user; a project membership is additionally required for `ProjectScope` | Can hold a platform role, project role, topic set, and `can_curate`. A platform scope contains only the active identity and platform role; a project scope requires the real membership. |
| `agent` | Active agent record bound to one project | Holds an allowed-topic set and the fixed project role `agent`. It has no platform role, project-management role, or console capability. |

`ProjectScope` is the authority object accepted by project-owned boundaries; its project cannot be
replaced later by a request parameter. `PlatformIdentityScope` is accepted only by named platform
operations. A delegated agent remains an agent and retains the agent role.

### Credentials

| Credential | Prefix or form | Scope and lifetime | Storage and revocation |
|---|---|---|---|
| Password | Email and password | Authenticates a human for console sign-in. Passwords do not carry project scope. | Argon2id hash. Unknown email, wrong password, and inactive user share one response. |
| Console session | `cks_…` | User-scoped across memberships; expires after 7 days. An admin API request made with a session must select an authorized project with `project=<slug>`. | Only a SHA-256 token hash is stored. Logout, expiry, or user deactivation stops resolution. |
| Human personal access token | `ck_…` | Bound to one project membership; optional expiry at the data-model level. | Plaintext is returned at issuance and not persisted. Revocation, expiry, or user deactivation stops resolution. |
| Agent personal access token | `ck_…` | Bound to one agent and one project. | Same hashed-at-rest token handling; inactive agents and revoked tokens do not resolve. |
| OAuth access token | Opaque bearer token | Bound to the membership selected during consent; expires after at most 3600 seconds. | SHA-256 hash; resolved against current membership and user state on every call. |
| OAuth refresh token | Opaque bearer token used at the token endpoint | Bound to the OAuth client and membership. Each refresh issues a new refresh token. | The used refresh credential is marked revoked during rotation. |
| Invitation or password-reset token | `inv_…` | Single-purpose, single-use credential. Invitations expire after 7 days; password-reset tokens expire after 1 hour. It is not accepted as REST or MCP bearer authentication. | SHA-256 hash; plaintext is returned only when issued. |
| Hunt reply token | `hunt_…` | Grants access only to the corresponding hunt reply route while the hunt is awaiting an answer. It is consumed by answer or decline. | SHA-256 hash. Missing, consumed, and non-awaiting values share the same refusal. The HTML lookup checks the stored expiry timestamp; the JSON answer handler currently relies on hunt-state expiration and does not check that timestamp itself. |

OAuth clients are public clients: dynamic registration returns a client identifier but no client secret. Authorization code flow requires PKCE with `S256`; authorization codes expire after 300 seconds and are single-use.

The server performs a database lookup for bearer and session credentials on every request. Credential revocation and principal deactivation therefore affect the next resolution rather than waiting for a scope cache to expire.

## Roles and authority attributes

| Attribute | Values | Meaning |
|---|---|---|
| Platform role | `owner`, `admin`, `member` | Governs platform lifecycle operations. `owner` and `admin` are platform-administrator roles. Platform role grants no project-content access. |
| Project role | `project-admin`, `member`, `viewer`, `agent` | Governs operations within one explicit project membership. `agent` is assigned to nonhuman principals and is not a membership role. |
| `can_curate` | boolean | Grants assigned knowledge-review decisions only. It does not grant project configuration, document lifecycle, ontology, audit, hunt, export, or platform authority. |
| Allowed topics | set of topic slugs | Limits reads, aggregates, exports, and mutations. Empty means no topical authority. |
| Delegation | nullable human user ID | Records that an agent acts for a human in the same project. Effective topics are the intersection of both parties' topic sets. |

## Capability matrix

Authorization is deny-by-default. The server names one capability for each operation and grants it only through the rule shown below.

| Capability | Platform `owner`/`admin` | `project-admin` | `member` | `viewer` | Agent | Additional rule |
|---|---|---|---|---|---|---|
| `platform.project.create` | allow | no grant from project role | no | no | no | Platform authority still arrives through an authenticated human scope. |
| `platform.user.invite` | allow | no grant from project role | no | no | no | Creates a platform user invitation. |
| `platform.project.list_all` | allow | no grant from project role | no | no | no | Global inventory is capability-gated; no project role or `project` query can widen it. |
| `platform.credential.revoke` | allow | no grant from project role | no | no | no | Covers administrator revocation of another user's OAuth connection. |
| `project.manage.read` | no grant from platform role | allow | no | no | no | Used for project-management lists, audit views, people, sources, and pending documents. |
| `project.config.write` | no grant from platform role | allow | no | no | no | Used for topics, sources, people, skills, and ontologies. |
| `project.settings.write` | no grant from platform role | allow | no | no | no | Used for project setting changes such as query-text logging. |
| `document.decide` | no grant from platform role | allow | no | no | no | Caller must hold every current and replacement topic on the document. |
| `gap.promote` | no grant from platform role | allow | no | no | no | Caller must hold every topic on the gap. |
| `hunt.manage` | no grant from platform role | allow | no | no | no | Caller must hold every topic named by the hunt. |
| `knowledge.read` | no grant from platform role | allow | allow | allow | no | Every result remains filtered by project and topics. |
| `usage.read` | no grant from platform role | allow | allow | allow | no | Usage data is limited to the scoped project. |
| `knowledge.review.decide` | no grant from platform role | allow | allow only with `can_curate` | deny even with `can_curate` | no | Caller must hold all current and replacement topics. |
| `correction.revert` | no grant from platform role | allow | allow when the caller owns the target's topic and holds all target topics | deny | no | Curation status does not grant this capability. |
| `operator.metrics.read` | no | no | no | no | no | The operator credential contract is not present, so the Prometheus scrape has no authorized principal. |

Platform and project roles are independent. A platform administrator needs an explicit membership before reading project content. A project administrator does not gain instance-wide platform operations. A user may carry both authorities, but the decision for each operation reads the relevant attribute.

Project administrators do not implicitly own every topic. Creating a topic explicitly adds that topic to the creator's membership; other topic grants remain separate and revocable.

## Topic scope

### Read visibility

Topic filtering runs inside database queries, before result rows, counts, totals, pagination density, or exports are observable. For a topical chunk or claim, all of these conditions apply:

- The row belongs to the scope's project.
- Its topics overlap the scope's allowed topics.
- It carries no sensitive topic that is absent from the allowed-topic set.
- Pending-review content is excluded from normal recall.

The sensitive-topic rule prevents overlap from weakening confidentiality. A chunk tagged both `general` and `hr`, where `hr` is sensitive, is hidden from a principal that holds only `general`. The default sensitive threshold is topic sensitivity `3`.

Rows with no topic dimension are not treated as universally visible. A surface can admit untagged project-level records explicitly; otherwise empty topic arrays do not match. Internal status markers `__needs_review__` and `__rejected__` are excluded when the server determines whether an object has a topic dimension.

### Mutation scope

Mutation authorization uses subset semantics, not overlap. The caller must hold every topic affected by the object and every replacement topic supplied by the request. This applies to document approvals, review decisions, gap promotion, hunts, and correction reverts.

Knowledge submission also requires a nonempty tag set entirely contained in the caller's allowed topics. The server rejects an unknown or unauthorized requested tag rather than dropping it, because dropping a tag would publish the fact under a different visibility set.

### Delegated scope

An agent can delegate only to an active human member of the agent's project. Effective topics are `agent topics ∩ human topics`; project identity and agent principal type do not change. Invalid delegation is an authentication failure. Delegation does not inherit the human's project or platform role.

## Denial behaviour

| Surface and condition | Result |
|---|---|
| REST request has no required bearer/session credential | HTTP `401`. |
| REST credential is invalid, revoked, expired, or belongs to a disabled principal | HTTP `401`. |
| Authenticated REST caller lacks a capability and object existence is not sensitive | HTTP `403` with a capability-specific reason. |
| REST target is absent, belongs to another project, or is hidden and existence is sensitive | HTTP `404` with the same not-found shape. |
| Console session omits an authorized `project` selection for a project-scoped admin route | HTTP `404`; it does not reveal whether another project exists. Platform operations do not use a project selection. |
| MCP credential or delegation does not resolve | `AUTH_INVALID`. |
| MCP recall or timeline has no visible result | `found: false` with an empty result, whether data is absent or hidden. |
| MCP skill or document is absent or hidden | The same empty-result shape in both cases. |
| Cross-project scope mismatch inside a service boundary | Constant `not found` error; the message does not identify the other project. |

Empty topic authority never means all topics. `can_curate` never stands in for administration. Agent credentials never satisfy a REST console/management capability. Caller-supplied project identifiers never widen a bearer token's project.

See the [REST authentication and errors](rest-api.md#authentication) and [MCP authentication and errors](mcp.md#authentication) sections for transport-specific shapes.
