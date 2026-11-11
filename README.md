# rsc-brain

A self-hosted knowledge server for AI agents and the people who work with them.

Agents write down what they do in a **journal**. People approve what becomes the **wiki**: typed pages with typed links, each citing its sources. Any agent can search it, over MCP or HTTP, before it works.

> Status: early development. Not ready for use.

## License

MIT. See [LICENSE](LICENSE).

## Install

rsc-brain runs in containers, on macOS or Linux. You need Docker with Compose v2 and git. One
command installs it; it checks what it needs first and changes nothing when something is missing.

Download the launcher from a published release (replace `vX.Y.Z` with the version), and check it
against the SHA-256 the release notes give for `rsc-brain.sh` before you run it:

```sh
curl -fsSLO https://github.com/ericrisco/rsc-brain/releases/download/vX.Y.Z/rsc-brain.sh
shasum -a 256 rsc-brain.sh      # Linux: sha256sum rsc-brain.sh; it must match the release notes
sh rsc-brain.sh install --local
```

While the repository is private, installing needs access to it: pass `--repo` with an address git
can read with your access (an SSH address, or HTTPS with git's credential helper; never a token in the
address), or `--image` with an image you already have.

It fetches the latest published version, builds its image, starts it with its own PostgreSQL and
tells you the address. It only writes in its own folder: an empty folder, or one that holds only
your `compose.override.yaml`; it refuses any other (a clone of this repository, say). Open it to finish the first-time setup, where you make the administration
account. `sh rsc-brain.sh help` lists every command and option.

### On this machine

`install --local` publishes the web on `http://localhost:8090`, on this machine only (`127.0.0.1`).
`--port N` picks another port; when the port is taken, the installer offers the next free one (or,
with `--yes`, stops and says which to pass). The installation lives in `~/rsc-brain` (`--dir` moves
it): its settings in `.env`, the copies in `backups/`.

### On a server with a domain

```sh
sh rsc-brain.sh install --domain brain.example.com
```

Point the domain at the server first. Caddy runs in front of rsc-brain on ports 80 and 443 and gets
the HTTPS certificate by itself (Let's Encrypt), and renews it; there is no certificate step. The
installation lives in `/opt/rsc-brain`. rsc-brain believes the forwarded headers only from Caddy's
fixed address in the installation's own network.

### An existing PostgreSQL

PostgreSQL 17 or newer, with the `unaccent` extension (it comes with PostgreSQL). Give the installer
either a database that is for rsc-brain alone, or an administration login it uses once to make one
(a role that is no superuser and a database only that role may connect to). Each goes in a file, or
on the standard input with `-`; never on the command line.

```sh
sh rsc-brain.sh install --local --db existing --db-url-file db-url.txt         # a database for rsc-brain
sh rsc-brain.sh install --local --db existing --db-admin-url-file admin-url.txt # let it make one
```

Inside the container, `localhost` is the container itself: a PostgreSQL on this machine is
`host.docker.internal`. The installer refuses a PostgreSQL that is too old or lacks `unaccent`,
before it makes anything.

### Sharing PostgreSQL with rsc-factory

```sh
sh rsc-brain.sh install --local --db shared --db-admin-url-file admin-url.txt --factory-db rsc_factory
```

rsc-brain gets its own database and role on the same server. Neither program can connect to the
other's database. If rsc-factory's login is a superuser, it can still reach everything; the installer
says so.

### Installed by rsc-factory (companion mode)

rsc-factory's installer can install rsc-brain next to it. It makes a Docker network both share and
calls:

```sh
sh rsc-brain.sh install --companion --attach-network rsc-shared --factory-url https://factory.example.com \
  --domain brain.example.com --trusted-proxy 192.168.210.2 \
  --db shared --db-admin-url-file admin-url.txt --factory-db rscf --yes --json
```

- rsc-brain joins the network as `rsc-brain` (`http://rsc-brain:8090` for rsc-factory) and runs no
  Caddy of its own: rsc-factory's Caddy serves its address. `--trusted-proxy` is that Caddy's fixed
  address on the network, the only proxy rsc-brain believes. With `--local` instead of `--domain`,
  the web is at `http://localhost:8090` on this machine and no proxy is believed.
- rsc-brain stays installed but not set up. Its first-time setup page says "Finish the setup in
  rsc-factory" and links there. rsc-factory's own setup makes the administration of both, with the
  same name, email and password, and the service account rsc-factory uses.
- It does that with a one-time key, `companionToken` in the `--json` summary (also in `.env`, which
  only its owner reads): `POST /v1/setup/companion` with `Authorization: Bearer <companionToken>`.
  rsc-brain answers that call only while it is not set up, only from the shared network (never
  through a proxy or from this machine), and only once: two calls at once set it up once.
- If rsc-factory loses its main key afterwards (an answer that never arrived, a restore), it gets a
  new one with `POST /v1/setup/companion/reconnect`: the same one-time key plus the email and
  password of an administrator of rsc-brain (wrong passwords wait as signing in does). It reaches
  only the account the first handshake made; the main key before, and the keys made from it, stop
  working. If an administrator removed that account, it says so (`service_removed`): reactivate it
  in Admin › People first.
- The shared network is IPv4 only: one with IPv6 on is refused (exit 2).
- It needs a PostgreSQL that is not rsc-brain's own (`--db shared` by default, or `--db existing`).
  With `--local`, also Docker Engine 28 and Docker Compose 2.33 or newer.
- Running `install` again keeps companion mode, the network and the key. An installation made
  without `--companion` does not become one.

Day to day, rsc-factory drives it (see rsc-factory's README, «Memory (rsc-brain)»):

- **Update:** rsc-factory's `update.sh` runs this launcher's `update` first, with everything under
  [Update](#update): maintenance, a copy, and the version before back if it fails. Then rsc-factory
  is not touched and its `update.sh` exits with 4.
- **Reconnect:** after a `restore`, rsc-factory's keys stop working. In rsc-factory, Administration ›
  Memory takes a new main key for the `rsc-factory` service account (make it in Admin › Service
  accounts here), or reconnects with the one-time key and your administrator's email and password.
- **Uninstall:** `sh <dir>/.rsc-brain/src/deploy/rsc-brain.sh uninstall --dir <dir>` stops it and
  keeps the data; rsc-factory's `install.sh` starts it again. With `--delete-data --confirm <name>
  --db-admin-url-file F` its database and role in rsc-factory's PostgreSQL go too (F: a superuser
  login of that PostgreSQL), and rsc-factory forgets it at its next `update.sh` or `install.sh`.
- rsc-factory fetches the newest `vX.Y.Z` tag of this repository: a version is usable as a companion
  only from the first tag that has `--companion`.

### Without questions

With every answer as an option and `--yes`, the installer asks nothing; whatever is missing is an
error that names the option giving it. With `--json`, standard output holds only a summary for
programs: `url`, `mode`, `db`, `installationKey`, `keyId`, `version` and `dir` (and, in companion
mode, `companionToken` and `internalUrl`). Exit codes: 0 done,
2 wrong usage, 3 a requirement is missing (nothing was changed), 4 it failed and put back what was
there, 1 anything else.

Running `install` again on an installation applies only what you change (the port, the domain) and
keeps its key, its passwords, its data and its copies.

### Update

```sh
sh rsc-brain.sh update                    # the latest published version
sh rsc-brain.sh update --version v0.2.0   # or that one (--image I: an image you already have)
sh rsc-brain.sh update --check            # only look: what runs, the newest published, what it changes
```

A published version is a `vX.Y.Z` tag of the repository. `update --check` (with `--json` for programs:
`installed`, `latest`, `newer`, `notes`) asks with this machine's own access, so it also works on a private
repository, stops nothing and writes nothing in the installation; it exits with 3 when it cannot say. The
web asks once a day, without credentials: on a private repository Administration › Backups & system says
«Could not check for a new version» and gives that command. It asks `RSC_BRAIN_REPO_URL` in `.env`, which
`install --repo` sets without credentials; empty, the web never asks.

The new version is fetched and built while the one installed keeps serving. Then rsc-brain goes
into maintenance: writes are refused with «rsc-brain is under maintenance, retry after N seconds»
(the web shows a band on every page), reads keep working. A copy of everything is made
(`…-pre-update.rscb`), the data is migrated, and the new version starts; once it answers as the
version asked, writes are taken again. If the migration or the start fails, the copy is restored, the
version before starts again and the launcher exits with 4: nothing written before the update is lost,
and sessions, tokens and connections keep working. Administration › Backups & system shows how the
last update went, and `last-failure.log` keeps the service's last lines. An update needs free disk
for twice the last copy and 1 GB more, and only moves forward (never to an older version; a release
comes after its release candidates, and `0.2.0-rc.2` after `0.2.0-rc.1`). What each version changes
is in [CHANGELOG.md](CHANGELOG.md) and in its release notes.

While the service is stopped (the migration, the start and the whole restore of a way back), a small stand-in
holds its port and its name: a browser sees a page with the current step, and anything else gets 503 with
`Retry-After` and the same `under_maintenance` answer as a refused write. An installation whose `compose.yaml`
has no stand-in yet (updated with `--image` from before) gets it with its next update from a version.

Ctrl-C during an update goes back the same way (a second Ctrl-C does not stop it). If the launcher
is killed outright once the new version has taken over (a power cut), the next `status`, or any
command that changes something, finds the note it left in `.rsc-brain/update.pending` and goes back first. If the copy is
restored but the version before does not start, the launcher says so: the data is back, and
`sh rsc-brain.sh install` starts it again. If the copy cannot be restored, every later command says so
(and `status` fails) until a `restore` of that copy goes well.

The way back runs in a session of its own, so a Ctrl-C at the terminal cannot cut it short: with
`setsid`, or with `perl` where there is no `setsid` (macOS). A machine with neither runs it like any
other step: there, do not press Ctrl-C while it goes back.

### Updating from the web (off until you turn it on)

By default only the terminal updates. To let an administrator do it from the web:

```sh
sh rsc-brain.sh web-updates enable [--repo-token-file F | --repo-key F]   # then: status, disable
```

This starts a container of its own, the updater, as a compose project apart from the service's
(`<name>-updater`). **It has full control of Docker on this machine: whoever controls it controls the
server**, and `enable` says so and asks (or wants `--yes`). It publishes no port and is on no network of the
service or of rsc-factory. It mounts exactly three things: the Docker socket, the installation folder at its own
path, and a list of users with its own in it, read only. The service never gets Docker, a credential or the
installation key from it: it only leaves an empty mark in `update/request`, which the updater looks at without
opening it, and reads `update/report` (read only) to learn the newest version. A private repository needs read
access that works from this machine: `--repo-token-file` (a file with one line, for an https address) or
`--repo-key` (an SSH private key, for an SSH one). The file is copied to `updater/credentials` (readable by its
owner only); nothing goes on a command line. `enable` proves the repository answers with it, from a container
like the updater's, before it starts anything.

The updater runs the same `update` as the terminal, always for the newest published version it found itself,
whatever the mark holds. A version that failed is tried once; **Try again** allows at most 3 retries, 15 minutes
apart, and after that only the terminal can try that version (the launcher put everything back each time). If the
machine stops halfway, the updater finishes taking the update back when it starts. After an update it restarts
from the new version's files; if its compose file or image changed, run `web-updates enable` again.

With the updater on, Administration › Backups & system shows **Update to vX.Y.Z** when a newer version is
published. An administrator signed in to the web confirms with their password (and the code of their
authenticator app, with a second factor); a wrong one counts as a failed attempt and asks for nothing. The
request is an empty file, whatever else the browser sends is ignored: the updater picks the version itself.
Two administrators at once start one update; the other is told one is already running. The page follows it,
says «Updated from X to Y.» at the end, or when and why it failed with **Try again** (within the limits above;
past them it gives the command). While the service restarts the stand-in page answers. A key, an app, a token
or a service account can never ask for it.

`web-updates disable` removes the container, the image and the credential, and the web shows the command again.
In an installation made by rsc-factory there is no button: `web-updates enable` exits 2 and tells you to update
it from rsc-factory.

### The installation key

The installer makes the installation key and keeps it in `.env`, which only its owner can read. It
opens every copy: without it a copy cannot be restored. Save it in a password manager.
`sh rsc-brain.sh key show` prints it again (it asks first); the first-time setup and Administration ›
Backups & system also give it to you.

```sh
sh rsc-brain.sh key rotate
```

makes a new key: rsc-brain stops for a moment, everything sealed (second factors, the mail password,
the key of the meaning provider) is sealed again with the new key, and it starts again. Sessions,
tokens and connections keep working. Copies made before need the previous key: it is kept in
`installation-key-<id>.txt` next to `.env` (only its owner reads it), and the web marks those copies
«Needs the older key». Save the new key in place of the old one. If a rotation is stopped halfway,
the new key stays in `.rsc-brain/env.rotated` (the data may already be sealed with it): run
`key rotate` again and it finishes with that key. Until then `install`, `update`, `backup`,
`restore` and `uninstall` refuse, and `status` warns.

### Copies

rsc-brain makes an encrypted copy every day at 03:00 and keeps the last 14, in `backups/`.

```sh
sh rsc-brain.sh backup                    # a copy now
sh rsc-brain.sh backups                   # the list
sh rsc-brain.sh restore --file rsc-brain-20261101T030000Z-manual.rscb --confirm "<installation name>"
```

`--file` takes a name as `backups` prints it (a copy in `backups/`) or the path of a copy from
elsewhere. Restoring replaces everything with the copy, after a copy of what is there. `--confirm` takes the
installation's name as the web shows it. To restore on another installation, pass the key of the
copy's installation in a file with `--key-file`. Afterwards every key, session and connection made
before stops working: everyone signs in again, and the administration issues new keys for programs.

### Uninstall

```sh
sh rsc-brain.sh uninstall
```

This stops rsc-brain and removes its containers. The database, the copies and the key stay: running
`install` again brings everything back as it was. To delete the data too:

```sh
sh rsc-brain.sh uninstall --delete-data --confirm rsc-brain
```

`--confirm` takes the installation's name on this machine (`--name` at install; `rsc-brain` by
default). With its own PostgreSQL, the database and the copies go. With an existing PostgreSQL, pass
`--db-admin-url-file` to remove its database and role as well; without it, the uninstaller tells you
what to remove. The installation key is kept in `installation-key.txt` for the copies you downloaded.
It only removes what it made: its containers, network and volumes, and its own files.

Your own additions to the containers go in `compose.override.yaml` next to `compose.yaml`; the
launcher keeps and loads it. Change settings by running `install` again, never by editing `.env` or
`compose.yaml`: the published port and `RSC_BRAIN_PUBLISH` must stay one value.

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

`npm run test:install` builds the container image and runs it with Docker (local only; skipped
without `RSC_BRAIN_INSTALL_TESTS=1`, and always in CI).

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

More on the web, its layers of tests and the rules of its fixture: [web/README.md](web/README.md).
Browsers refuse some ports outright (4190, 6000, 6566, 10080 and the rest of the Fetch standard's «bad
ports»): an installation on one of them answers `curl` but not the web, the bridge or the hooks.

## Search by meaning (optional)

Off by default; search by words works without it. The server offers a provider when its setting is
present, and the administration turns it on in the web, accepting that text is sent to the provider:

- `RSC_BRAIN_OPENAI_KEY` — OpenAI, model `text-embedding-3-small`;
- `RSC_BRAIN_OLLAMA_URL` — a local Ollama, model `nomic-embed-text`.

A curator can exclude a brain: its vectors are deleted and nothing more of it is sent.

## Better ranking with optional extensions

Search works on any PostgreSQL 17 or newer with `unaccent`. Two optional extensions improve the order of
results; rsc-brain uses them when they are installed in its database and works as before when they are not:

- **`pg_search`**: results are ranked by BM25, so a rare word counts more than a common one repeated, and a
  word in the title counts twice as much as the same word in the text. Words still match without accents and
  in their Spanish and English forms, and quoted phrases and excluded words filter as always.
- **`pgvector`**: with search by meaning on, closeness is worked out by its operator. Words and meaning are
  mixed by reciprocal rank fusion, so a result found both ways comes before one found only one way.

rsc-brain never installs them (its database role is no superuser). An administrator creates them in the
database of rsc-brain, as a superuser:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
```

On its next start rsc-brain makes the index it needs, as its own role (no other grant is needed), and says in its
log what search uses (`"event":"search","code":"bm25"`). If the index cannot be made, the log says
`"event":"search_index_failed"` with the database's error code, rsc-brain starts anyway, and search keeps its own
ranking.

## People, keys and mail

- The administration invites people by email to brains, each with a role: curator, contributor or
  reader. The link works once, for 72 hours. Without mail, the administration copies it from the web.
- People make their own tokens for agents in their profile: read, or read + write, for 30, 90 or 365
  days. A token is shown once. It never does more than its person's current role.
- Service accounts (such as RSC Factory) get a main key, and may hold two at once to rotate without
  a cut. With it they mint short keys, one per job.
- Mail is optional. Set the sending account in the web. Its password is stored sealed with
  `RSC_BRAIN_SECRET`. The mail log keeps who, what kind, when and how it ended, never the content.

## Writing to the wiki directly

By default an agent proposes changes to the wiki and a curator approves them in the web. A curator can let
one key write to the wiki of their brain directly: in the profile, on a token ("Can write to the wiki of …"),
when making it or later. The permission is per key and per brain, only a curator of that brain gives it (in
the web, never with a key), and any curator takes it back; it counts from the next request.

- A key with the permission sends the same operations as a proposal (`brain_write`, or
  `POST /v1/brains/:slug/wiki/write`), checked the same way. They apply at once, all or none, each page with a
  new revision and the change with a line in the log that says which key wrote it. It is undone like any
  other change: go back to a revision. Repeating a write with the same `requestKey` writes nothing twice.
- A key without it gets `403 wiki_write_not_allowed`, which says how to propose instead.
- A short key of a service writes with the permission of the main key that made it.

### Deciding proposals with a key

The same permission lets a key decide the proposals of that brain, as a curator does in the web. It lists them
(`brain_proposals` with `"mine": false`), reads one as a curator sees it, with its `fingerprint`
(`brain_review`, or `GET /v1/proposals/:id/review`), and decides it (`brain_decide`, or
`POST /v1/proposals/:id/approve` and `POST /v1/proposals/:id/return`):

- approve it all; approve the operations in `approve` and send the rest back with a `comment`; correct an
  operation in `corrections` and approve; or send it all back with a `comment`. What is approved applies all
  at once or not at all, and an operation needs those it depends on.
- Only what was read is approved: a `fingerprint` that no longer matches gets `409 proposal_changed` with the
  current review, and nothing applies. A proposal decided already gets `409 already_decided`.
- The log and the activity say who decided and with which key. The agent that proposed gets the comment as a
  correction. Repeating a decision with the same `requestKey` decides once and returns the same result.
- A key without the permission gets `403 web_only`. The permission is checked on every request, so taking it
  back between reading and deciding refuses the decision.

### Warnings before and after a change

A proposal, a direct write, and a check that writes nothing (`brain_check`, or
`POST /v1/brains/:slug/wiki/check`) answer with what the change would leave incoherent, worked out on the
wiki as it would be after it: `duplicate_title`, `broken_link`, `orphan_created`, `stale_page` and
`open_conflict`, each with the pages it is about. They come with `neighbours`, the pages linked to what the
change touches, so the agent can read them for contradictions. Warnings never block.

### The daily cleanup

A cleanup is a proposal or a direct write marked `"maintenance": true`. When nobody cleaned a wiki in the
last 24 hours, none waits for approval and its health has problems, an agent that starts work in the brain
(`mem_context`) is asked to clean it, with the health report. The Health screen says when the last cleanup
was.

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
  `brain_health`, `brain_compile_pack`, `brain_check`, `brain_write`, `brain_propose`, `brain_proposals`,
  `brain_review`, `brain_decide`, `brain_withdraw`, `brain_create`. A key sees only the tools it may use.
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

## In a container

`docker build -t rsc-brain .` builds the image: the server, the web and the migrations on Node 25,
run by an unprivileged user, healthy when `GET /v1/health` answers. `rsc-brain serve` is its command;
`docker run --rm rsc-brain rsc-brain version` prints the version. Copies go to `/backups`.

In a container, a browser on the same machine arrives through the container's gateway, not from
`127.0.0.1`, so the rule above would refuse its password. When the port is published on `127.0.0.1`
alone, set `RSC_BRAIN_PUBLISH=127.0.0.1:<port>` and `RSC_BRAIN_LOCAL_ONLY=1`: a request straight
from the gateway, with no forwarded headers and addressed to `localhost`, `127.0.0.1` or `[::1]`,
then counts as this machine. The service refuses to
start with `RSC_BRAIN_LOCAL_ONLY=1` and any other `RSC_BRAIN_PUBLISH`: published to the network,
every visitor would arrive from the gateway and a password would cross it in clear. Never publish
the port elsewhere by hand with the flag on; for access from other machines use a domain with HTTPS.

`rsc-brain db check | provision | drop` prepares an existing PostgreSQL (17 or newer, with
`unaccent`): `provision` takes an administration login (from a file or the standard input, never
kept) and creates a role that is no superuser and cannot create databases or roles, and a database
only it may connect to. `--isolate-from <database>` also closes another program's database to it,
and rsc-brain's to that program: every other login that could connect there is first given that
right by name (the command lists them), then the database is closed to everyone else. `db drop`
removes only a database and a role that `provision` made. The new connection URL goes to a new `0600` file
(`--url-file`) or is printed once.
