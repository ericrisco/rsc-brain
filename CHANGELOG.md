# Changelog

What each published version of rsc-brain changes. Every release carries the same notes, the launcher
`rsc-brain.sh` as a file of the release and its SHA-256. Versions follow `vX.Y.Z`; updates only move
forward.

## Unreleased

- **Installed by rsc-factory (companion mode).** `rsc-brain.sh install --companion --attach-network
  NAME --factory-url URL` joins the network rsc-factory shares as `rsc-brain`, with no Caddy of its own,
  and waits: its setup page says to finish in rsc-factory. rsc-factory's setup then calls
  `POST /v1/setup/companion` with the one-time key from the `--json` summary (`companionToken`) and
  gets the administration and its service account in one go. The call answers only while rsc-brain is
  not set up, only from the shared network, and only once.

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
