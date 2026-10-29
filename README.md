# RSC Brain

A self-hosted knowledge server for AI agents and the people who work with them.

Agents write down what they do in a **journal**. People approve what becomes the **wiki**: typed pages with typed links, each citing its sources. Any agent can search it, over MCP or HTTP, before it works.

> Status: early development. Not ready for use.

## License

MIT. See [LICENSE](LICENSE).

## Development

Requirements: Node 25 and, for the full test suite, PostgreSQL 17 or newer.

```sh
npm install
npm run verify      # lint, types, tests, audit
```

`scripts/verify.sh` runs the tests against a real PostgreSQL: the server in `RSC_BRAIN_PG_URL`, or,
when the PostgreSQL binaries are installed, a throwaway local cluster in `.pg-test/` (port 55432)
that it starts for you (`npm run pg:stop` stops it). Without either, the PostgreSQL tests are
skipped, as in CI.

`node scripts/bench-search.ts` (with `RSC_BRAIN_PG_URL`) loads 10 000 pages and 100 000 entries into a
throwaway database and times 100 varied searches; 95 % must answer in under a second.

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

Agents that support the MCP sign-in (OAuth 2.1 with PKCE) find Brain through
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. They open the
person's browser. The person signs in, chooses which brains to share (read, or read + write) and goes
back to the agent, without copying any key.

- An access key lasts an hour. The refresh token changes on every use, and using an old one again
  ends the connection.
- A connection ends after 90 days without use, or a year in all. Connections show in the profile
  under "Connected apps", where they can be revoked.
- Clients can name themselves with a metadata document (an https address that Brain fetches with
  guards against reaching private networks) or register dynamically.

## Agents over MCP

Brain serves MCP at `/mcp` (Streamable HTTP; protocol `2026-07-28`, and `2025-11-25` / `2025-06-18` for
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

## Audit

Every sign-in, invitation, role change, key, connection, purge and setting change is recorded. The
administration reads it with filters and downloads it as CSV. Curators see the part of their brain.
The database refuses to change or delete it.

## Behind a reverse proxy

Brain takes a password only over an encrypted connection, or from the same machine. A reverse proxy
on the same machine must therefore send `X-Forwarded-For` and `X-Forwarded-Proto` (nginx:
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and
`proxy_set_header X-Forwarded-Proto $scheme;`). List the proxy's own address in
`RSC_BRAIN_TRUSTED_PROXIES`. Without those headers, everything the proxy forwards looks local.
