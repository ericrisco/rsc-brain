# rsc-brain admin console (`apps/admin`)

Next.js (App Router) + TypeScript admin console for rsc-brain (SPEC-07 bootstrap).

## Golden rule

The console consumes **only** the typed REST admin client generated from the API's OpenAPI. No
direct database access, no raw fetch to the API from views — everything goes through
`lib/api` (typed client) → the same-origin server proxy (`app/api/proxy`) → the API. An ESLint
rule enforces this (bans DB drivers and raw `fetch` outside `lib/api`/`app/api`).

## Typed client + drift check

- `openapi.json` is exported from the API in CI (`uv run python scripts/export_openapi.py`).
- `npm run gen:api` runs `openapi-typescript openapi.json -o lib/api/schema.d.ts`.
- `npm run check:api` regenerates and **fails if the committed types drift** from the contract.

## Develop

```bash
npm install
cp .env.example .env.local   # point API_URL at a running rsc-brain API
npm run dev
```

## Session

Login (`/api/v1/auth/login`) mints a console session token (`cks_…`) held in an **httpOnly**
cookie set by the Next server; the browser never holds it. The server proxy attaches it as a
bearer. Logout / disabling the user / expiry stop the session resolving in <5s (FR-4.12).

## Scope

v0.1 bootstrap: session login, `/me` (project selector + owner-only global view + role reflection),
and self-service PATs ("My connections"). Observability, ingestion/approval views, and full
management arrive in SPEC-14 / SPEC-21; OAuth connections with SPEC-10.
