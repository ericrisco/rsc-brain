# Security and tenancy
<!-- diataxis: explanation -->

rsc-brain uses one self-hosted instance for an organization and isolates knowledge inside that
instance by project and topic. The application model assumes that the infrastructure operator is
trusted with the host, database, volumes, backups, and process environment. Project permissions do
not protect data from that operator.

## Authority has several independent axes

| Axis | What it controls | Why it stays separate |
|---|---|---|
| Platform role | Organization-wide project and user lifecycle | A platform administrator does not gain project content access by role alone. |
| Project membership role | Management and participation inside one project | Authority in one project does not carry to another. |
| Topic grants | Which knowledge a membership or agent can see | A broad project role still needs explicit topic access. |
| Curation flag | Assigned knowledge-review decisions | Review authority does not imply project administration. |
| Principal type | Human or agent operations | Agent credentials cannot reach console management capabilities. |

An empty topic set means no topic access. For content with a sensitive topic, overlap on a second,
non-sensitive topic is insufficient; the caller must hold the sensitive topic explicitly. Mutations
that affect several topics require authority over the whole object.

The split adds administrative work because roles and topics must both be maintained. It avoids a
single coarse role becoming an implicit path to every document in a project.

## Scope comes from the credential

Personal access tokens and OAuth access tokens resolve to an identity already bound to one project.
The request cannot nominate a different project and reuse the same authority. Downstream store,
ingestion, and recall interfaces carry that identity-project binding as one `ProjectScope` value.

Resolution reads current database state on each call. Revoked or expired credentials and disabled
principals stop resolving without waiting for an authorization cache. Agent delegation intersects
the agent's topic grants with the represented human's grants and never changes the project.

Opaque bearer tokens are stored as SHA-256 hashes, and passwords use Argon2id. Console sessions are
also stored by hash. The Next.js console keeps its session token in an HTTP-only cookie and forwards
it from its server-side proxy, so browser JavaScript does not hold the token.

## Enforcement happens before data leaves storage

Project and topic predicates are part of relational and vector queries. Sensitive-topic exclusions
are also part of those queries. Unauthorized rows are not fetched and then removed in application
code, which narrows the places where pagination, counts, or logs could reveal hidden records.

The schema adds a second layer. Project-owned records carry a non-null `project_id`, and references
between tenant-owned rows use project-qualified constraints. Graph names derive from the project
identifier, and graph operations receive the same scope used by relational and vector stores.

This is logical multitenancy inside one PostgreSQL service, not one database server per project. The
shared service reduces deployment and transaction complexity, while a database or host compromise
crosses every project's boundary. Infrastructure isolation, encryption, access control, and backups
remain operator responsibilities.

## Denial reveals as little as absence

For project-scoped objects whose existence is sensitive, a wrong-project or unauthorized request has
the same public outcome as a missing object. Recall returns no result, and REST paths map the decision
to the same not-found response. This reduces identifier-probing signals but gives authorized users
less detail when a permission assignment is wrong.

Aggregate and administration surfaces apply topic filters before counts and pages are formed. That
matters because a total can disclose hidden activity even when individual rows are absent.

Recall audit records store raw query text by default. A project setting can replace that text with a
hash while retaining topics and outcome metadata. The default improves investigation context but
increases the amount of potentially sensitive content held in the audit log.

## Network and model boundaries

The canonical edge terminates TLS and separates console, REST, MCP, OAuth, and metrics routes. OAuth
metadata uses a configured public origin rather than caller-supplied host headers. MCP uses that
same origin as its exact Host and Origin allow-list while keeping DNS-rebinding protection enabled.
Public OAuth and MCP deployments therefore depend on a real HTTPS origin and correct proxy headers.

The packaged deployment files do not set `ingress.public_origin` from their domain value, and their
route maps omit the API's `/hunt/{token}` page. Operators must inject the public origin for OAuth
and public MCP traffic; public hunt replies remain unavailable through those edges in release
0.13.0.

The metrics route exists, but release 0.13.0 has no credential contract that can satisfy its operator
capability. The endpoint is therefore unavailable to scrapers rather than exposed without authority.
Every packaged edge still assigns public `/metrics` to that endpoint. This also shadows the Next.js
product-metrics page at `/metrics`, so neither surface is publicly reachable through a packaged edge.
The project-scoped product-metrics API remains under `/api/v1/admin/metrics/product` and applies the
ordinary knowledge-read boundary.

Model providers sit outside the storage permission boundary. Configuration owns their routes and
credentials; ordinary request data cannot choose a provider, endpoint, model, or key. Secrets belong
in environment variables or secret stores, not the YAML configuration file.

Retrieved fragments are labeled as untrusted data. rsc-brain returns source fragments rather than a
synthesized answer, so the consuming agent remains responsible for treating document text as data and
for resisting instructions embedded inside it.

These controls describe the current application design; they are not an external security
certification. See the [permissions reference](../reference/permissions.md) for the exact capability
matrix and [SECURITY.md](../../SECURITY.md) for private vulnerability reporting.
