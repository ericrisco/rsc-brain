# Deploying rsc-brain (SPEC-18)

One self-hosted instance per organization. There is **one canonical production compose**
(`docker-compose.prod.yml`); every target is a **thin overlay** on it — never a forked definition
(principle D18), so the targets can't drift. A CI lint enforces that overlays only carry deltas.

**GPU is a host precondition (D8).** The optional `ollama`/`vllm` backends assume the NVIDIA
Container Toolkit is already installed — no target ever installs drivers.

## What "plug-and-play" gives you (FR-18.x)

- **One secret** — `POSTGRES_PASSWORD`; the app database DSN derives from it.
- **Automatic TLS + domain** — Caddy (raw) or the PaaS proxy (Coolify/Dokploy). Required: Claude/
  ChatGPT will not connect an MCP without HTTPS (D11).
- **Migrate-on-boot** — a one-shot `migrate` service runs `brain init` (idempotent migrations +
  first-admin) before `api`/`worker` start (NFR-8).
- **Healthchecks** — reuse `brain verify` (FR-11.2).
- **First-admin bootstrap** — from `RSC_BRAIN_ADMIN_EMAIL`/`RSC_BRAIN_ADMIN_PASSWORD`, or a
  generated password shown once in the `migrate` service logs.
- **Persistent volumes** — Postgres data, the PDF inbox, and the model cache.

## Raw `docker compose` (baseline)

```bash
./deploy/init-secrets.sh                 # generate deploy/.env with unique secrets (once)
# edit deploy/.env: set RSC_BRAIN_DOMAIN to your real domain
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml up -d
docker compose -f deploy/docker-compose.prod.yml logs migrate   # first-admin password (if generated)
```

`brain verify` gates the `api` healthcheck; the MCP URL is `https://<domain>/mcp`.

## Coolify (v0.3)

Paste `docker-compose.prod.yml` + `docker-compose.coolify.yml` as the compose. Coolify injects
`SERVICE_PASSWORD_POSTGRES` (the one secret) and `SERVICE_FQDN_API_8080` / `SERVICE_FQDN_CONSOLE_3000`
(domain + TLS via its proxy); the overlay drops our Caddy. Nothing to hand-edit. Then log in as the
admin from the `migrate` logs.

## Dokploy (v0.3)

Paste `docker-compose.prod.yml` + `docker-compose.dokploy.yml`. Set `POSTGRES_PASSWORD` and
`RSC_BRAIN_DOMAIN` in the Dokploy env UI; Traefik labels on `api` provide TLS + routing (Caddy
dropped). Log in as the admin from the `migrate` logs.

## Upgrades (NFR-8)

`git pull` a new image tag and `docker compose … up -d`: the one-shot `migrate` re-runs
`brain init` (idempotent — migrations forward, the admin is never reset), then services restart.
Data is preserved on the named volumes; take a `brain backup` first for safety.

## Real-instance verification (per release)

The one-click deploys on **real Coolify and Dokploy instances** (AC#3/#4) and the live
Claude/ChatGPT MCP connect over HTTPS (AC#8) are executed against provisioned instances per release
— they need infrastructure this repo can't stand up in CI. The deterministic pieces (compose
structure + anti-drift, the `brain init` bootstrap, migrate idempotence) are covered automatically.
