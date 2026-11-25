// Usage of T001 (spec learning-memory «Paso desde la versión anterior», CA-U1, U2, U3, U6): a clean installation of
// v0.7.15 used as a client would, then this release started on the same database, then what a client sees.
//   1. v0.7.15 (built from git, tag v0.7.15 = e371e84) on a new database: setup, brain «demo», three people.
//   2. As clients of v0.7.15: a contributor saves a step and a decision, the curator writes a page in the web and edits
//      it (revision 2), the contributor sends a proposal (pending, the only mode v0.7.15 has).
//   3. The step is made 30 days old in the database: no client can save in the past (the one step not over HTTP).
//   4. v0.7.15 stops; this release serves the same database (it migrates on start: 0032 and 0033).
//   5. Over HTTP only: the proposal still waits; the 30-day-old step is still found (its type lasts 7 days, counted from
//      the upgrade); the curator has the notice of the new mode, with the way back; the brain's audit says so; the
//      contributor and the reader have no such notice; the page reads as before.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-upgrade.ts [--no-build]
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'
import { api, build, createDatabase, dropDatabase, populate, ROOT, say, serve } from './clean-install.ts'

const run = promisify(execFile)
const OLD = process.env.RSC_BRAIN_OLD_REF ?? 'e371e84'
const noBuild = process.argv.includes('--no-build')

let failed = 0
const check = (what: string, ok: boolean, seen?: unknown) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}${seen === undefined ? '' : `  (${JSON.stringify(seen)})`}`)
  if (!ok) failed += 1
}

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-upgrade ${new Date().toISOString()} · this tree ${commit} · from ${OLD} (v0.7.15)`)
const oldDir = await mkdtemp(join(tmpdir(), 'rscb-old-'))
let dbUrl = ''
try {
  // ----------------------------------------------------------------------------------------- 1. v0.7.15, clean
  await run('sh', ['-c', `git -C "${ROOT}" archive ${OLD} | tar -x -C "${oldDir}"`])
  await symlink(join(ROOT, 'node_modules'), join(oldDir, 'node_modules'))
  await build(oldDir)
  if (!noBuild) await build(ROOT)
  dbUrl = await createDatabase()
  const old = await serve(dbUrl, oldDir)
  const people = await populate(old.base)
  const { curator, contributor, reader } = people
  // ---------------------------------------------------------------------------------- 2. used as v0.7.15 is
  let call = api(old.base)
  const tok = (w: { token: string; name: string }) => ({ token: w.token, name: w.name })
  const step = await call(
    tok(contributor),
    'POST',
    '/v1/brains/demo/entries',
    {
      type: 'step',
      title: 'Deployed the billing worker',
      content: 'Rolled out billing worker v2 to production.',
    },
    (b) => b.receipt,
  )
  const stepId = (step.body.receipt as { entryId: string }).entryId
  await call(
    tok(contributor),
    'POST',
    '/v1/brains/demo/entries',
    {
      type: 'decision',
      title: 'Billing runs nightly',
      content: 'The billing worker runs every night at 02:00.',
    },
    (b) => (b.receipt as { entryId: string }).entryId,
  )
  await call(
    curator,
    'POST',
    '/v1/brains/demo/wiki/changes',
    {
      op: 'create',
      address: 'billing',
      type: 'topic',
      title: 'Billing',
      summary: 'How billing runs.',
      body: 'Nightly.',
    },
    (b) => ({ revision: (b.page as { page: { revision: number } }).page.revision }),
  )
  await call(
    curator,
    'PATCH',
    '/v1/brains/demo/pages/billing',
    { baseRevision: 1, body: 'Nightly, at 02:00.', reason: 'The hour.' },
    (b) => ({ revision: (b.page as { page: { revision: number } }).page.revision }),
  )
  const prop = await call(
    tok(contributor),
    'POST',
    '/v1/brains/demo/proposals',
    {
      title: 'Add the worker page',
      reason: 'A step says how it is deployed.',
      ops: [
        {
          op: 'create',
          address: 'billing-worker',
          type: 'topic',
          title: 'Billing worker',
          summary: 'The worker that bills.',
          body: 'Runs nightly; see [[billing]].',
          reason: 'The step says it is deployed.',
          sources: [{ entryId: stepId }],
        },
      ],
    },
    (b) => ({ id: (b.proposal as { id: string }).id, status: (b.proposal as { status: string }).status }),
  )
  const proposalId = (prop.body.proposal as { id: string }).id
  // ------------------------------------------------------------------------------ 3. the step, 30 days old
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  await c.query(
    "UPDATE entries SET created_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE id = $1",
    [stepId],
  )
  await c.end()
  say(`$ psql: entry ${stepId} created 30 days ago (fixture: no client saves in the past)`)
  // ------------------------------------------------------------------------- 4. this release, same database
  await old.stop()
  say('$ v0.7.15 stopped')
  const now = await serve(dbUrl, ROOT)
  call = api(now.base)
  // ---------------------------------------------------------------------------------- 5. what clients see
  const p = await call(tok(contributor), 'GET', `/v1/proposals/${proposalId}`, undefined, (b) => ({
    status: (b.proposal as { status: string }).status,
    ops: (b.ops as Array<{ status: string }> | undefined)?.map((o) => o.status),
  }))
  check(
    'CA-U2: the proposal sent before the upgrade still waits',
    (p.body.proposal as { status: string }).status === 'pending',
  )
  const found = await call(
    tok(contributor),
    'GET',
    '/v1/search?q=billing%20worker&brains=demo&in=entries&types=step',
    undefined,
    (b) => (b.items as Array<{ id: string; type: string }>).map((i) => `${i.type}:${i.id}`),
  )
  const items = (found.body.items as Array<{ id: string }>) ?? []
  check(
    'CA-U1: the step of 30 days ago is still found after the upgrade',
    items.some((i) => i.id === stepId),
  )
  const notices = await call(curator, 'GET', '/v1/me/notices', undefined, (b) =>
    (b.notices as Array<{ kind: string; brain: string; text: string }>)
      .filter((n) => n.kind === 'wiki_mode')
      .map((n) => ({ brain: n.brain, text: n.text })),
  )
  const mine = (notices.body.notices as Array<{ kind: string; brain: string; text: string }>).filter(
    (n) => n.kind === 'wiki_mode',
  )
  check(
    'CA-U3: the curator has one notice: the wiki applies at once, and where to ask first',
    mine.length === 1 &&
      mine[0]?.brain === 'demo' &&
      /applies agents' changes at once, with undo/.test(mine[0]?.text ?? '') &&
      /\/b\/demo\/settings/.test(mine[0]?.text ?? ''),
  )
  for (const w of [contributor, reader]) {
    const r = await call(w, 'GET', '/v1/me/notices', undefined, (b) =>
      (b.notices as Array<{ kind: string }>).map((n) => n.kind),
    )
    check(
      `${w.name} (not a curator) has no such notice`,
      !(r.body.notices as Array<{ kind: string }>).some((n) => n.kind === 'wiki_mode'),
    )
  }
  const audit = await call(curator, 'GET', '/v1/brains/demo/audit', undefined, (b) =>
    ((b.items ?? b.entries ?? b.audit) as Array<{ action: string; detail: string }> | undefined)
      ?.filter((a) => a.action === 'wiki.mode')
      .map((a) => `${a.action} ${a.detail}`),
  )
  const lines = (audit.body.items ?? audit.body.entries ?? audit.body.audit) as
    | Array<{ action: string; detail: string }>
    | undefined
  check(
    'CA-U3: the brain audit has the line «wiki.mode auto (upgrade)»',
    (lines ?? []).some((a) => a.action === 'wiki.mode' && a.detail === 'auto (upgrade)'),
  )
  const page = await call(tok(reader), 'GET', '/v1/brains/demo/pages/billing', undefined, (b) => ({
    revision: (b.page as { revision: number }).revision,
    unreviewed: (b.page as { unreviewed?: boolean }).unreviewed ?? (b as { unreviewed?: boolean }).unreviewed,
  }))
  const pg2 = page.body.page as { revision: number; unreviewed?: boolean }
  check(
    'CA-U6: the page written before reads as before, at revision 2, not marked unreviewed',
    page.status === 200 && pg2.revision === 2 && pg2.unreviewed !== true,
  )
  await now.stop()
} finally {
  if (dbUrl) await dropDatabase(dbUrl)
  await rm(oldDir, { recursive: true, force: true })
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
