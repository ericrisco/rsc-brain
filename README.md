# rsc-brain

A self-hosted knowledge server for AI agents and the people who work with them.

Agents write down what they do in a **journal**. People approve what becomes the **wiki**: typed pages with typed links, each citing its sources. Any agent can search it, over MCP or HTTP, before it works.

> Status: early development. Not ready for use.

## License

MIT. See [LICENSE](LICENSE).

## Development

Requirements: Node 25 and, for the full test suite, PostgreSQL 17 or newer.

```sh
npm install
npx playwright install chromium   # once, for the browser tests of the web
npm run verify      # lint, types, build, tests, the web in a browser, audit
```

`scripts/verify.sh` runs the tests against a real PostgreSQL: the server in `RSC_BRAIN_PG_URL`, or,
when the PostgreSQL binaries are installed, a throwaway local cluster in `.pg-test/` (port 55432)
that it starts for you (`npm run pg:stop` stops it). Without either, the PostgreSQL tests are
skipped, as in CI.

`node scripts/bench-search.ts` (with `RSC_BRAIN_PG_URL`) loads 10 000 pages and 100 000 entries into a
throwaway database and times 100 varied searches; 95 % must answer in under a second.

## The web

`rsc-brain serve` also serves the rsc-brain web, on the same address as the API: open it in a browser to
run the first-time setup, sign in, accept an invitation or reset a password. `npm run build` builds it
into `dist/web`; without that folder the server answers the API as usual and says the web is not built.
The web only calls the API at `/v1` (with the same permissions a program has) and never answers on
`/v1`, `/mcp`, `/oauth` or `/.well-known`. Press `?` on any screen for the keyboard shortcuts.

For work on the web: `rsc-brain serve` on port 4100, then `npm run web:dev` (Vite on port 5173, which
forwards the API to 4100).

The tests of the web run in Chromium. `npm run test:web` uses a fixture of the API (no database; each of
its answers is checked against the API description), as CI does. `npm run test:e2e` runs against the
real server and the PostgreSQL in `RSC_BRAIN_PG_URL`; `verify.sh` runs it when that PostgreSQL answers
and says why it skipped it otherwise. `node test/web/fixture/main.ts` starts the fixture on port 4173 to
walk the web by hand: open `/__fixture/use?preset=signed-in` (or `fresh`, `signed-out`, `insecure`).

## Search by meaning (optional)

Off by default; search by words works without it. The server offers a provider when its setting is
present, and the administration turns it on in the web, accepting that text is sent to the provider:

- `RSC_BRAIN_OPENAI_KEY` — OpenAI, model `text-embedding-3-small`;
- `RSC_BRAIN_OLLAMA_URL` — a local Ollama, model `nomic-embed-text`.

A curator can exclude a brain: its vectors are deleted and nothing more of it is sent.

## People, keys and mail

- The administration invites people by email to brains, each with a role: curator, contributor or
  reader. The link works once, for 72 hours. Without mail, the administration copies it from the web.
- People make their own tokens for agents in their profile: read, or read + write, for 30, 90 or 365
  days. A token is shown once. It never does more than its person's current role.
- Service accounts (such as RSC Factory) get a main key, and may hold two at once to rotate without
  a cut. With it they mint short keys, one per job.
- Mail is optional. Set the sending account in the web. Its password is stored sealed with
  `RSC_BRAIN_SECRET`. The mail log keeps who, what kind, when and how it ended, never the content.

## Connecting agents with the standard sign-in

Agents that support the MCP sign-in (OAuth 2.1 with PKCE) find rsc-brain through
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. They open the
person's browser. The person signs in, chooses which brains to share (read, or read + write) and goes
back to the agent, without copying any key.

- An access key lasts an hour. The refresh token changes on every use, and using an old one again
  ends the connection.
- A connection ends after 90 days without use, or a year in all. Connections show in the profile
  under "Connected apps", where they can be revoked.
- Clients can name themselves with a metadata document (an https address that rsc-brain fetches with
  guards against reaching private networks) or register dynamically.

## Agents over MCP

rsc-brain serves MCP at `/mcp` (Streamable HTTP; protocol `2026-07-28`, and `2025-11-25` / `2025-06-18` for
older clients). An agent connects with the standard sign-in or a personal token, and on connecting
receives a short protocol: resolve its brain, read the context, search before deciding, save as it
works, never save secrets, close with a summary.

- Tools: `brain_list`, `brain_resolve`, `mem_context`, `mem_session_start`, `mem_save`, `mem_update`,
  `mem_suggest_topic`, `mem_relate`, `mem_forget`, `mem_session_summary`, `mem_session_end`,
  `mem_search`, `mem_get`, `mem_timeline`, `brain_page`, `brain_neighbors`, `brain_map`,
  `brain_health`, `brain_compile_pack`, `brain_propose`, `brain_proposals`, `brain_withdraw`,
  `brain_create`. A key sees only the tools it may use.
- Each tool runs the same `/v1` route a program would, with the same key: the same checks, limits
  and results.
- Curators link repositories to their brain, so an agent finds it with `brain_resolve`.

## Connect your agent

`GET /v1/connect` (any key) gives, for Claude Code, Codex, OpenCode, Cursor and other agents:

- **Standard sign-in:** only the MCP address (`<your installation>/mcp`); the agent opens the browser.
  Claude Code: `claude mcp add --transport http rsc-brain <address> --scope user`, then
  `claude mcp login rsc-brain`. Codex: `codex mcp add rsc-brain --url <address>`, then
  `codex mcp login rsc-brain`. OpenCode: a `remote` server in `opencode.json`. Cursor: `{"url": …}` in
  `.cursor/mcp.json`.
- **With a token:** a config block per agent. The token is pasted at a hidden prompt into a file only you
  can read (`~/.config/rsc-brain/<agent>.token`, mode 600), never on a command line. Each agent has a
  variable of its own, loaded from that file, so two agents never overwrite one token, and a shared
  `.mcp.json` never holds it: Claude Code `.mcp.json`
  (`"Authorization": "Bearer ${RSC_BRAIN_TOKEN_CLAUDE_CODE}"`), Codex `~/.codex/config.toml`
  (`url` + `bearer_token_env_var = "RSC_BRAIN_TOKEN_CODEX"`), OpenCode `opencode.json`
  (`{env:RSC_BRAIN_TOKEN_OPENCODE}`), Cursor `.cursor/mcp.json` (`${env:RSC_BRAIN_TOKEN_CURSOR}`).
  Other agents use `RSC_BRAIN_TOKEN` and `~/.config/rsc-brain/token`, the bridge's. The kit only
  carries a placeholder (`tokenPlaceholder`); the web fills it once, when you create the token there.
- **The optional reminder:** for Claude Code, two hooks (below). Other agents get a text for their
  instructions file (`AGENTS.md`) and the server's `close_session` prompt.
- **The check:** ask your agent: *"What does this brain know about X?"*

`?agent=codex` returns one agent; `?brain=<slug>` names the brain in the check and the start hook.

### The bridge, for agents that only start local MCP programs

```sh
mkdir -p ~/.config/rsc-brain && (umask 077 && printf 'Token: ' && read -rs t && : > ~/.config/rsc-brain/token && chmod 600 ~/.config/rsc-brain/token && printf '%s\n' "$t" > ~/.config/rsc-brain/token && echo saved)
rsc-brain bridge --url https://brain.example.com/mcp
```

As a local MCP server: `{"command": "rsc-brain", "args": ["bridge", "--url", "<address>", "--token-file",
"~/.config/rsc-brain/token"]}`. The bridge reads one JSON-RPC message per line on stdin and sends each to
`/mcp` with the token and the headers the server checks; answers go to stdout, notifications get none.
It speaks to modern clients and to older ones that start with `initialize`. The token comes from
`--token-file`, else `RSC_BRAIN_TOKEN`, else `~/.config/rsc-brain/token`; there is no option to pass it on the
command line, and it is never printed. Plain `http` is refused except to this machine. When rsc-brain does
not answer, the request gets a JSON-RPC error that says so and how to proceed; the bridge keeps running.

### The Claude Code reminder

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact",
      "hooks": [{ "type": "command", "command": "rsc-brain hook session-start --url <address>", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "rsc-brain hook stop --url <address>", "timeout": 15 }] }]
  }
}
```

- `hook session-start` runs `git remote get-url origin` in the session's folder, asks rsc-brain which brain
  is linked to it (`/v1/resolve`), and adds that brain's context to the session. `--brain <slug>` is
  used when no brain is linked to the repository.
- `hook stop` asks `GET /v1/me/sessions` whether the token still has a brain session open (work saved
  without a summary). If so, it asks Claude once, per brain session and Claude Code session, to close it
  with `mem_session_summary`. It lets Claude stop when `stop_hook_active` is set.
- Both need a token (as for the bridge) and fail open: with no token, a bad input or rsc-brain down, they
  print nothing and let the session go on.

The `rsc-brain` command comes with this package: from a clone, `npm install && npm run build && npm link`.

## The API for programs

Everything a tool does is also a `/v1` route, with the same keys and permissions. The description of
the API is at `GET /v1/openapi.json` (OpenAPI 3.1, no key needed: it describes routes and holds no
data). Version 1 is a contract: its routes and the main fields of its answers do not change; a
breaking change goes to `/v2`, and `/v1` keeps working alongside it.

- **Errors** always come as `{ "error": { "code", "message", "howToProceed" } }`.
- **Rate limit:** each key may make 600 requests per minute by default. Beyond that the answer is
  429 `rate_limited`, with `Retry-After` and `retryAfter` in seconds; over MCP the same refusal comes
  as a JSON-RPC error. The administration changes the limit with `PUT /v1/admin/settings`
  (`{ "rateLimit": 1200 }`). The count lives in the memory of the server process.
- **Bounded answers:** no answer passes 256 000 characters. Lists go by pages and say how to ask for
  the next one. An answer that would still pass the limit is cut: it comes as
  `{ "cut": { "message", "howToProceed", … }, "partial": "…" }` with the header `X-Brain-Cut: true`.

## Following a brain live

`GET /v1/brains/:slug/events` is a stream of Server-Sent Events: sessions opened and closed, entries
saved and changed, searches, reads, proposals sent, withdrawn and decided, and wiki changes. Each event
carries its id, time, brain, kind, who and with which key (and the external reference of a short key),
and the id and title or address of what it touches; a search carries the text searched, already
redacted. It never carries the body of an entry or a page.

- **Who sees what:** curators see everything. Everyone else sees every change and proposal, and only
  their own searches and reads (a service account: what any of its keys did; an agent's short key:
  what it did itself).
- **Ids and order:** an event's id is its place in the delivery order, which is the order events became
  visible; ids grow along a stream. A write whose transaction takes long gets a later id, never none.
  A session left idle for 24 hours closes itself, with a `session.closed` event that has no `who`.
- **Resuming:** reconnect with `Last-Event-ID` (or `?lastEventId=`) to get what you missed, in order,
  from the last 24 hours. If you missed events older than that, a `gap` event says so first: catch up
  with the lists (pending proposals, recent sessions). An id ahead of the newest event (an installation
  restored from a copy) also gets a `gap` event, and the stream follows from now.
- **Liveness:** events arrive within 2 seconds; a comment line every 15 seconds keeps proxies from
  closing the connection. The key and the role are checked every 2 seconds: a revoked key or a
  changed role ends the stream with a `closed` event that says why.
- One poller reads new events for every open stream and gives them their ids. An installation runs as
  one server process.

## Audit

Every sign-in, invitation, role change, key, connection, purge and setting change is recorded. The
administration reads it with filters and downloads it as CSV. Curators see the part of their brain.
The database refuses to change or delete it.

## Behind a reverse proxy

rsc-brain takes a password only over an encrypted connection, or from the same machine. A reverse proxy
on the same machine must therefore send `X-Forwarded-For` and `X-Forwarded-Proto` (nginx:
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and
`proxy_set_header X-Forwarded-Proto $scheme;`). List the proxy's own address in
`RSC_BRAIN_TRUSTED_PROXIES`. Without those headers, everything the proxy forwards looks local.
