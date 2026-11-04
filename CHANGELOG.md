# Changelog

What each published version of rsc-brain changes. Every release carries the same notes, the launcher
`rsc-brain.sh` as a file of the release and its SHA-256. Versions follow `vX.Y.Z`; updates only move
forward.

## Unreleased

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
