<!-- diataxis: reference -->

# Console control-plane authority matrix

Status: implementation contract for Console Control Plane T001. This reference records the
endpoint-to-UI boundary approved in UX-SPEC-01. It is intentionally API-authoritative: the
browser may reflect a capability, but no route may infer it from a role label or enforce it only
by hiding an action.

`ProjectScope` always carries the authenticated principal, selected project, membership role,
allowed topics, curation flag, and the effective capability decision. Project content, counts,
pagination, exports, and graph state require it. `PlatformInventoryScope` resolves an
authenticated platform identity only; it is never a substitute for `ProjectScope` and exposes no
project content.

## Session envelope

`GET /api/v1/me` returns a `SessionEnvelope` for an authenticated console session:

| Field | Authority source | Disclosure rule |
| --- | --- | --- |
| `identity` | Current authenticated identity | Display-safe identity metadata only; no token or credential material. |
| `platform_capabilities` | Current platform capability decisions | Contains only currently effective platform operations, including `platform.project.list_all` where granted. |
| `memberships[]` | Discoverable project memberships | Each member contains `project`, presentation-only `role`, `capabilities`, `allowed_topics`, and `can_curate`. |
| `memberships[].capabilities` | Current membership capability decisions | Capability strings are authoritative; clients do not derive them from `role` or `can_curate`. |
| `preference_metadata` | Server-held non-secret preference state | Contains display preferences only and never credential material. |

Platform capabilities do not add a membership or topic authority. Conversely, a membership
capability does not add platform inventory authority.

## Endpoint to route matrix

| Endpoint / field or command | Required capability | Required scope | Console route | Authority boundary |
| --- | --- | --- | --- | --- |
| `GET /api/v1/me` → `SessionEnvelope` fields above | Authenticated session | Identity scope | all authenticated routes | Supplies the only browser-readable capability source. |
| `GET /api/v1/admin/projects` → `ProjectPage` | `platform.project.list_all` | `PlatformInventoryScope` | `/manage/projects` | Owner/admin inventory and posture only; an owner with no membership is allowed. Any caller without the capability receives `403`, including a direct URL with `?project=`. |
| `POST /api/v1/admin/projects` → lifecycle result | `platform.project.create` | `PlatformInventoryScope` | `/manage/projects` | Project lifecycle creates no content membership. |
| project settings and topic/membership reads or mutations | `project.manage.read`, `project.config.write`, or `project.settings.write` as applicable | `ProjectScope` | `/manage/projects`, `/manage/users`, `/manage/topics` | A project administrator acts only in the scoped project and visible topics. |
| self PAT and connection commands | Authenticated session and self-ownership | Identity scope; project membership only when issuing a PAT | `/connections` | Every authenticated identity can manage only its own credentials. |
| third-party credential revoke | `platform.credential.revoke` | `PlatformInventoryScope` | `/manage/users` | Separate from self-service and from project-content authority. |
| knowledge lists, details, posture, and bounded graph reads | `knowledge.read` | `ProjectScope` | `/`, `/knowledge`, `/graph`, `/product-metrics` | Topic filtering occurs before any item, count, cursor, aggregate, or graph expansion. |
| review decisions and document lifecycle decisions | `knowledge.review.decide` or explicit document-lifecycle capability | `ProjectScope` plus target topics | `/review`, `/observability` | `can_curate` grants only explicitly assigned review decisions and never administration. |
| scoped observability reads | `knowledge.read` | `ProjectScope` | `/observability` | Query/privacy policy and topic filtering apply before telemetry aggregation. |
| usage, audit reads, and exports | `usage.read` or explicit export capability | `ProjectScope` | `/usage`, `/audit` | Server produces the complete authorized filter; hidden rows never affect totals or exports. |
| hunting directory commands | `hunt.manage` | `ProjectScope` plus supplied topics | `/manage/hunting` | A manual hunt retains the authorized topic set and never widens to a project-wide request. |
| skill lifecycle commands | `project.config.write` or explicit lifecycle capability | `ProjectScope` plus visible topics | `/manage/skills` | Commands re-check scope and version at execution. |

## Route-level non-disclosure rules

- `/` is a scoped overview unless `PlatformInventoryScope` is selected solely for authorized
  platform posture. It must not aggregate project content across memberships.
- `/connections` is self-service. It does not confer third-party credential administration.
- `/observability`, `/knowledge`, `/review`, `/usage`, `/audit`, `/product-metrics`, and `/graph`
  require `ProjectScope`; a global platform role alone is insufficient.
- `/manage/projects` is the only route allowed to consume platform project inventory. The other
  management routes remain project-scoped unless their individual command names a platform
  capability.
- `/login` is unauthenticated. The fourteen authenticated destinations consume the session
  envelope and must still rely on the corresponding server-side endpoint decision.

For a sensitive project object, denied and absent use the same external response. A capability
denial for the nonsensitive platform inventory is `403`, so a direct API request cannot turn a
hidden navigation item into an authorization bypass.
