# The rsc-brain web

The web is how people use rsc-brain: they read the wiki and its graph, follow what agents do, approve or
return proposals, correct the journal, connect their agents and run the installation. Agents use the
same server over MCP and HTTP; the web is for the people around them.

It is one page application (Preact, Vite) that the rsc-brain process serves on the same address as the
API. It calls only the public API at `/v1` and the live events, with the same permissions a program has:
there are no private routes. Anything the web can do, a program with the same role can do.

The text of the web is in English and lives in `src/text.ts`, so it can be translated later.

## Run it in development

```sh
npm install
npm run build                       # once: the server and dist/web
RSC_BRAIN_PORT=4100 node dist/cli/main.js serve   # with RSC_BRAIN_PG_URL set
npm run web:dev                     # Vite on port 5173; it forwards /v1, /mcp, /oauth and /.well-known to 4100
```

Open <http://localhost:5173>. The first visit runs the first-time setup.

Without a database, walk the web against the fixture of the API instead:

```sh
npm run build
node test/web/fixture/main.ts       # the fixture and the built web on port 4173
```

Open <http://127.0.0.1:4173/__fixture/use?preset=signed-in> (or `fresh`, `signed-out`, `member`,
`alone`, `insecure`). Each preset is a scenario of its own: sign-ins, data and forced states.

### Pick a port browsers accept

Browsers and `fetch` refuse some ports outright (the «bad ports» of the Fetch standard), whatever the
server says. Among them: 4190, 5060, 5061, 6000, 6566, 6665–6669, 6697 and 10080. An installation on one of
those ports answers `curl` but not the web, the bridge or the Claude Code hooks. Use another port, such as
the default 8090, or put rsc-brain behind a reverse proxy on 443.

## How the code is laid out

- `src/screens/` paints the screens. A screen holds no logic it can avoid: what decides goes in `src/lib/`.
- `src/lib/` holds the logic of the screens (filters, the live check, settings, the shortcuts), without
  the DOM, so node tests reach it.
- `src/api/` is the client of the API: one call per operation, a cache with `useFresh`, and drafts.
- `src/live/` follows a brain's events (reconnects, catches up from the last id, lets go when the tab hides).
- `src/graph/` lays the graph out in a worker and paints it on a canvas, so no task blocks the page.
- `src/ui/` holds the shared parts: buttons that say why they are off, fields, dialogs and the states of a
  screen (`states.tsx`: loading, empty, filtered empty, error, offline, no access).

Rules every screen follows:

- Every screen has all its states (spec B6 «Estados en todas las pantallas»). `test/browser/matrix.spec.ts`
  holds the list of screens and states; a new route without a row fails it.
- Writes are off while offline or while sending, and say why next to the button (`Button` with `blocked`).
- The keyboard never falls to the page body after an action: `src/lib/landing.ts` decides where it lands.
- No editable empty box while a saved value is still loading.
- Drafts stay in memory, or are keyed by account; passwords, codes, tokens and keys are never stored.
- The server decides who may do what. The web hides what a role cannot do, but never relies on that.

## How it is tested

Three layers, from fast to real:

1. **Node tests** (`test/web/*.test.ts`, run by `npm test`): the logic in `src/lib/`, the graph's layout
   and model, the API client and the conformance of the fixture.
2. **Browser tests against the fixture** (`test/browser/*.spec.ts`, `npm run test:web`): the built web in
   Chromium against a fixture of the API (`test/web/fixture/`), with no database. CI runs these. They
   cover every screen and state at 320 px (`matrix.spec.ts`), the accessibility audit with axe in the
   light and dark themes (`axe.spec.ts` and the audits in each screen's spec), the keyboard, and the
   timing of the graph (CA5, CA6; CI is the judge for timing).
3. **End-to-end tests** (`test/e2e/*.spec.ts`, `npm run test:e2e`): the built web against the real server
   and PostgreSQL (`RSC_BRAIN_PG_URL`), one worker, mail captured. They run locally in `scripts/verify.sh`
   when PostgreSQL answers; CI has no PostgreSQL and says so. CA1 (from the invitation to a connected
   agent) is counted here and printed by `verify.sh`.

`npm run verify` runs them all, with lint, types, the build and the dependency audit.

### The fixture and the contract

The fixture lets CI test the web without a database, so it must not drift from the server:

- Every answer the fixture gives is checked against the description of `/v1` that the server generates
  from its own route table (`test/web/fixture.test.ts`). A field the server does not describe fails.
- The main answers of `/v1` are pinned in `test/api/contract.test.ts`, which also calls the real server.
  A new field is added to the server, its description and the pin, then to the fixture.
- A state of a screen is forced per scenario (`scenario(context, url, preset, { screen: state })`):
  `loading`, `empty`, `filtered-empty`, `error`, `forbidden` and `much-data`. A screen's operations name
  their screen in the fixture's table, so the state reaches every answer the screen reads.
- The graph's data comes from a seeded generator (`web/test/data/generate.ts`): the same seed gives the
  same 300 or 5 000 pages to the fixture and to the real server.
- Tests wait for the requests in flight before they assert, and never rely on the time a request takes.
  Linux fonts are wider than macOS ones: a test of fit measures, it does not assume widths.
