# Changelog

What each published version of rsc-brain changes. Every release carries the same notes, the launcher
`rsc-brain.sh` as a file of the release and its SHA-256. Versions follow `vX.Y.Z`; updates only move
forward.

## v0.4.1

Nothing sits against the left edge with half the screen empty.

- **Empty, error and "nothing here" screens** fill the work area, their words in the middle, instead of a small card at the left.
- **First steps** of a new brain use the whole width, the three steps side by side.
- **The wiki's map** lays each folder out in as many columns as the screen holds, instead of one long column.

## v0.4.0

A new face for the web: a canvas you can turn, in a dark style.

- **An icon rail and the full width.** The navigation is a narrow rail of icons at the left (their names on
  hover and to screen readers), and every screen uses the whole window.
- **A dark style.** Dark panels with numbered heads and a colour each, in one monospaced face (JetBrains Mono,
  served by the installation itself). Light is still there: choose it in the account menu.
- **The graph is a cloud that turns.** The wiki's pages float in three dimensions around the brain, one colour
  and one shape for each kind of page, with a legend that counts them. It turns slowly when you leave it alone;
  light runs along the links, and a card shows one page after another with where it comes from. At first sight
  each page shows only its strongest links, and the pages without links lie in a row underneath.
- **Your hands on it.** Drag to turn it, zoom past Fit and the drag moves it instead; two fingers move and
  pinch it. A touch, a key or the pointer stops it, and it turns again after a short rest. Click a page to
  open it in the inspector; the arrow keys walk from page to page.
- **Still when you ask.** With reduced motion in the system nothing moves: the cloud is drawn once, from a
  fixed angle. Nothing moves either while the tab or the canvas is out of sight.
- **List, the same as text.** Every page of the graph is also in List, a table you can sort and filter: the
  alternative for a screen reader or for anyone who prefers reading.
- **The list screens redone.** Brains, the brain's overview, the wiki, its map, history and proposals take the
  new panels: what matters first, the counts at a glance, the actions where you need them.

## v0.3.0

Update rsc-brain from its own web, and know what version is out.

- **Updating from the web, off by default.** `rsc-brain.sh web-updates enable` starts a small updater in a
  container of its own. Whoever controls it controls the server, and `enable` says so. A private repository
  needs a read-only token or SSH key given as a file.
- **The button.** Administration › Backups & system offers «Update to vX.Y.Z» to an administrator, who confirms
  with their password. One update at a time, **Try again** after a failure (at most 3 times, 15 minutes apart),
  and the page follows the update to its result. If the update cannot start, the page says what is missing and
  how to fix it. If a way back could not restore your data, the page says so and gives the steps for the
  server instead of offering to try again. An installation made by rsc-factory has no button: update it there.
- **See what is new.** `rsc-brain.sh update --check` shows the version running, the newest published and what
  it changes, without stopping anything. A private repository says so instead of claiming it is up to date.
- **Something answers during an update.** While the service restarts, a page says so (503 with `Retry-After`
  for programs) instead of a dead port.
- **Safer updates on Linux.** If Docker made the `update` folders for root, `update` and `web-updates enable`
  say the exact `sudo chown` line instead of failing and rolling back.
- **`GET /v1/health` says the version to a valid key.** Without one it still does not.

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
