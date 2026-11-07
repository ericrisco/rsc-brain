# Changelog

What each published version of rsc-brain changes. Every release carries the same notes, the launcher
`rsc-brain.sh` as a file of the release and its SHA-256. Versions follow `vX.Y.Z`; updates only move
forward.

## Unreleased

- **What is published has one definition.** A `vX.Y.Z` tag of the repository, and what it changes from the
  `## vX.Y.Z` section of the `CHANGELOG.md` in that tag, for the launcher, the web and rsc-factory. The web
  asks the repository without credentials instead of the list of releases; `RSC_BRAIN_REPO_URL` says where,
  and empty (or an empty `RSC_BRAIN_RELEASES_URL`) turns it off.
- **`rsc-brain.sh update --check [--json]`.** Only looks: the version running, the newest published and what
  it changes, with the machine's own access. Nothing stops and nothing is written.
- **A private repository says so.** Administration › Backups & system says «Could not check for a new
  version» and gives that command, never that it is up to date.
- **`GET /v1/health` says the version to a valid key.** Without one it still does not.
- **Something answers during an update.** While the service is stopped, also through the restore of a way
  back, a stand-in holds its port and name: a page with the step for a browser, 503 with `Retry-After` and
  `under_maintenance` for the rest.

- **Updating from the web, off by default.** `rsc-brain.sh web-updates enable|disable|status` runs an updater
  in a container of its own (no port, none of the service's networks, the Docker socket, the installation and a
  user list mounted, nothing else). Whoever controls it controls the server, and `enable` says so. A private
  repository needs a read-only token or SSH key given as a file. At most 3 retries per version, 15 minutes
  apart. Not for an installation made by rsc-factory: it exits 2 and refers to rsc-factory.
- **The button.** With the updater on, Administration › Backups & system offers «Update to vX.Y.Z» to an
  administrator, who confirms with their password again (and the code). `POST /v1/admin/update` and
  `/update/retry` only leave an empty mark for the updater; nothing in the request reaches it. One update at
  a time, **Try again** after a failure within the updater's limits, and the page follows the update to its
  result. In an installation made by rsc-factory there is no button: the page says to update it from there
  and links to rsc-factory. `GET /v1/admin/system` gains `update`.
- **The web's version check follows the updater.** With the updater on, the web does not ask the repository:
  it reads what the updater found, with the server's own access. Notes drop control characters, as the
  launcher does.

## v0.2.0

rsc-brain as rsc-factory's memory: rsc-factory can install it, set it up and work with it.

- **Installed by rsc-factory (companion mode).** `rsc-brain.sh install --companion --attach-network
  NAME --factory-url URL` joins the network rsc-factory shares as `rsc-brain`, with no Caddy of its own,
  and waits: its setup page says to finish in rsc-factory. rsc-factory's setup then calls
  `POST /v1/setup/companion` with the one-time key from the `--json` summary (`companionToken`) and
  gets the administration and its service account in one go. The call answers only while rsc-brain is
  not set up, only from the shared network, and only once. A main key lost afterwards is replaced with
  `POST /v1/setup/companion/reconnect` (the one-time key and an administrator's password).
- **What a service asks for the people it serves.** `POST /v1/access` tells a service which role a
  person has in the brains it belongs to; a service allowed to invite brings people into the brains it
  created (`POST /v1/brains/{slug}/invitations`). It only ever raises a role, never lowers one, takes
  over someone else's open invitation only when the new mail goes out, and is held to an hourly
  invitation quota (`RSC_BRAIN_SERVICE_INVITES_PER_HOUR`). Brain listings say `createdByYou`.
- **Context names what it gave.** The context an agent starts with now lists each entry and page it
  included (`items`), so the program running the agent can say which correction reached it.
- **On behalf of.** An entry an agent writes with a short key made on behalf of a person now names
  that person; older entries are filled in on update where the key still says who it was.
- **Fixes.** A role picker that could put the old role back under load, and the same race in
  sessions, corrections and the wiki log; the "Get started" command wraps cleanly on a phone.

## v0.1.0

The first release: a knowledge server for AI agents that anyone can install.

- **The journal and the wiki.** Agents write freely to a journal of entries (decisions, findings,
  notes); people approve what goes into the wiki through proposals. Search by words, and by meaning
  when a provider is set up.
- **For agents.** An MCP endpoint and an HTTP API, the standard sign-in for MCP clients, short keys
  for an agent's session, a bridge for agents that only start local programs, and a reminder hook.
- **For people.** A web to read and curate each brain: overview, journal, wiki with its graph,
  proposals, activity live, health, settings, people and tokens; an administration with accounts,
  email, meaning search, the audit, and backups & system.
- **Install in one command.** `rsc-brain.sh install` on this machine or on a server with a domain
  (HTTPS by itself), with its own PostgreSQL, an existing one, or one shared with another program.
- **Copies and restore.** Encrypted copies every day (and by hand), restored here or on another
  installation with the installation key; the key can be rotated (`rsc-brain.sh key rotate`).
- **Export and import.** A brain exported as a folder that opens as an Obsidian vault, or as a
  faithful copy; a documentation folder (or a faithful export) imported into an empty brain.
- **Update with rollback.** `rsc-brain.sh update` makes a copy first, refuses writes while it
  migrates, and goes back to the version before by itself if anything fails, Ctrl-C included. An
  update killed halfway is taken back by the next command; a key rotation
  killed halfway is finished by the next `key rotate`. Release candidates are ordered as semver
  says.
