# rsc-brain administration console

The administration console is a Next.js 15 App Router application for project-scoped operations.
It covers sign-in, project selection, personal connections, knowledge and review views, graph
inspection, audit, usage, product metrics, and operational status.

## Contract boundary

Views use the generated OpenAPI types through `lib/api`. Browser traffic crosses same-origin Next.js
route handlers under `app/api/auth` and `app/api/proxy`; views do not connect to PostgreSQL or send
untyped requests directly to the Python API. ESLint enforces the import and `fetch` boundary.

Contract drift is checked in two stages:

```bash
uv run python scripts/export_openapi.py
cd apps/admin
npm run check:api
```

The first command refreshes `openapi.json` from the FastAPI application. `check:api` regenerates
`lib/api/schema.d.ts` and fails when the committed types differ.

## Development

Start a configured rsc-brain API first, then:

```bash
cd apps/admin
npm ci
cp .env.example .env.local
npm run dev
```

Set `API_URL` in `.env.local` to the API origin reachable from the Next.js server. Open
`http://localhost:3000`.

Before handing off a console change, run:

```bash
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

## Authentication and project scope

Login exchanges an email and password for a `cks_…` console session. The Next.js server stores the
token in an HTTP-only cookie and attaches it to API proxy requests; browser JavaScript does not
receive the token.

A console session is user-scoped, so project administration requests also select an authorized
project slug. The selection does not grant membership or widen topic authority. Logout, expiry,
user deactivation, and credential revocation affect subsequent resolution.

The **Connections** page creates and revokes project-scoped personal access tokens and lists OAuth
connections. A new PAT is displayed once; only its hash and metadata remain available afterward.

## Routes

| Route | Purpose |
|---|---|
| `/` | Dashboard and project selection |
| `/login` | Console sign-in |
| `/connections` | Personal access tokens and OAuth connections |
| `/knowledge` | Project knowledge and corrections |
| `/review` | Pending documents, chunks, and entity merges |
| `/graph` | Authorized entity graph inspection |
| `/audit` | Filtered audit records and CSV export |
| `/usage` | Model calls and token usage |
| `/metrics` | Product metrics when the console is reached directly in development |
| `/observability` | Project health, activity, recalls, and ingestion state |

The packaged Compose, Coolify, Dokploy, and Helm edges assign public `/metrics` to the Python
Prometheus endpoint. That endpoint has no authorizable principal in 0.13.0, and the assignment
prevents the request from reaching this Next.js page. The product-metrics page is therefore not a
publicly reachable packaged route in this release; its backing project-scoped API remains
`GET /api/v1/admin/metrics/product`.

For API permissions and denial behavior, see the
[permissions reference](../../docs/reference/permissions.md) and
[REST API reference](../../docs/reference/rest-api.md).
