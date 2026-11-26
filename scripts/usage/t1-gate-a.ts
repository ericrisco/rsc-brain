// The gate of block A (spec learning-memory; plan T011): over HTTP only, as clients would, twice — on a clean install of
// this release, and on the data of v0.7.15 (e371e84) after this release migrated it. Each time:
//   - a contributor's proposal applies at once and enters «Review later»; the curator undoes it in the web and the page
//     is exactly as before (title, summary, body, tags, status); a page the agent created is gone from its address;
//   - negatives: a part on a protected page waits (protected); a part against a person's correction waits (correction);
//     with the brain set to Ask first everything waits (ask_first), and setting it back applies again; a reader cannot
//     propose (403).
// Ends with PASS or FAIL.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-gate-a.ts [--no-build]
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  api,
  build,
  cleanInstall,
  createDatabase,
  dropDatabase,
  populate,
  ROOT,
  say,
  serve,
  type Who,
} from './clean-install.ts'

const run = promisify(execFile)
const OLD = process.env.RSC_BRAIN_OLD_REF ?? 'e371e84'
const noBuild = process.argv.includes('--no-build')

let failed = 0
const check = (what: string, ok: boolean, seen?: unknown) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}${seen === undefined ? '' : `  (${JSON.stringify(seen)})`}`)
  if (!ok) failed += 1
}

type People = { curator: Who; contributor: Who; reader: Who }
type R1 = { status: string; undo: string | null; held: Array<{ address: string; reason: string }> }

async function gate(base: string, p: People, label: string): Promise<void> {
  say(`\n## ${label}`)
  const call = api(base)
  const tok = (w: Who) => ({ token: w.token, name: w.name })
  const { curator, contributor, reader } = p
  const saved = await call(
    tok(contributor),
    'POST',
    '/v1/brains/demo/entries',
    {
      type: 'learning',
      title: 'Invoices go out at 03:00',
      content: 'The billing worker sends invoices at 03:00.',
    },
    (b) => (b.receipt as { entryId: string }).entryId,
  )
  const source = (saved.body.receipt as { entryId: string }).entryId
  const web = async (op: Record<string, unknown>) => call(curator, 'POST', '/v1/brains/demo/wiki/changes', op)
  const plant = (address: string, body: string) =>
    web({
      op: 'create',
      address,
      type: 'topic',
      title: address,
      summary: `About ${address}.`,
      body,
      reason: 'Gate.',
    })
  const read = async (address: string) => {
    const r = await call(tok(reader), 'GET', `/v1/brains/demo/pages/${address}`)
    const pg = r.body.page as Record<string, unknown> | undefined
    return { status: r.status, page: pg }
  }
  const exact = (pg?: Record<string, unknown>) =>
    pg ? JSON.stringify([pg.title, pg.summary, pg.body, pg.tags, pg.status, pg.type]) : null
  const propose = async (who: Who, title: string, ops: unknown[]) =>
    call(tok(who), 'POST', '/v1/brains/demo/proposals', { title, ops }, (b) =>
      b.error
        ? undefined
        : { status: b.status, undo: b.undo, held: (b.held as R1['held'])?.map((h) => h.reason) },
    )
  const revision = async (address: string) => Number((await read(address)).page?.revision)

  // Propose → applied → undo → the page exactly as before.
  await plant('gate/billing', 'Billing runs nightly.')
  const before = await read('gate/billing')
  const applied = await propose(contributor, 'Invoices at 03:00', [
    {
      op: 'edit',
      address: 'gate/billing',
      baseRevision: Number(before.page?.revision),
      body: 'Billing runs nightly; invoices go out at 03:00.',
      reason: 'The learning says when.',
      sources: [{ entryId: source }],
    },
    {
      op: 'create',
      address: 'gate/invoices',
      type: 'topic',
      title: 'Invoices',
      summary: 'When invoices go out.',
      body: 'At 03:00, from the billing worker.',
      reason: 'A page of its own.',
      sources: [{ entryId: source }],
    },
  ])
  const r1 = applied.body as unknown as R1
  check(
    'the proposal applies at once (status applied) with an undo',
    applied.status === 201 && r1.status === 'applied' && /^chg_/.test(String(r1.undo)),
  )
  const after = await read('gate/billing')
  check('the page changed', exact(after.page) !== exact(before.page))
  const tray = await call(curator, 'GET', '/v1/brains/demo/wiki/changes', undefined, (b) =>
    (b.items as Array<{ id: string }>).map((c) => c.id),
  )
  check(
    'it waits in «Review later»',
    (tray.body.items as Array<{ id: string }>).some((c) => c.id === r1.undo),
  )
  const un = await call(
    curator,
    'POST',
    `/v1/wiki/changes/${r1.undo}/undo`,
    { comment: 'Not yet decided.' },
    (b) => (b.error ? undefined : (b.undone as Array<{ address: string }>).map((u) => u.address)),
  )
  check('the curator undoes it in the web', un.status === 200)
  const back = await read('gate/billing')
  check(
    'the page is exactly as before (title, summary, body, tags, status, type)',
    exact(back.page) === exact(before.page),
  )
  check('the page the agent created is gone from its address', (await read('gate/invoices')).status === 404)

  // Negatives.
  await plant('gate/guard', 'Guarded.')
  await call(
    curator,
    'PUT',
    '/v1/brains/demo/protection/gate/guard',
    { protected: true },
    (b) => (b.page as { protected: boolean } | undefined)?.protected,
  )
  const g = await propose(contributor, 'Edit the guarded page', [
    {
      op: 'edit',
      address: 'gate/guard',
      baseRevision: await revision('gate/guard'),
      body: 'Changed.',
      reason: 'R.',
    },
  ])
  const g1 = g.body as unknown as R1
  check(
    'a protected page: the part waits (protected) and the page does not change',
    g1.status === 'held' &&
      g1.held[0]?.reason === 'protected' &&
      (await read('gate/guard')).page?.body === 'Guarded.',
  )
  await plant('gate/style', 'Short intros.')
  await call(curator, 'POST', '/v1/brains/demo/corrections', {
    title: 'Keep the intro short',
    content: 'Three seconds, no more.',
    page: 'gate/style',
  })
  const c = await propose(contributor, 'Long intros', [
    {
      op: 'edit',
      address: 'gate/style',
      baseRevision: await revision('gate/style'),
      body: 'Long intros.',
      reason: 'R.',
    },
  ])
  const c1 = c.body as unknown as R1
  check(
    'against a person’s correction: the part waits (correction)',
    c1.status === 'held' && c1.held[0]?.reason === 'correction',
  )
  const settings = await call(curator, 'GET', '/v1/brains/demo/wiki/settings', undefined, (b) => b.writeMode)
  await call(
    curator,
    'PUT',
    '/v1/brains/demo/wiki/settings',
    { writeMode: 'ask_first', base: { writeMode: settings.body.writeMode } },
    (b) => b.writeMode,
  )
  await plant('gate/free', 'Free.')
  const a = await propose(contributor, 'Ask first', [
    {
      op: 'edit',
      address: 'gate/free',
      baseRevision: await revision('gate/free'),
      body: 'Asked.',
      reason: 'R.',
    },
  ])
  const a1 = a.body as unknown as R1
  check(
    'Ask first: everything waits (ask_first), nothing applies',
    a1.status === 'held' &&
      a1.held[0]?.reason === 'ask_first' &&
      a1.undo === null &&
      (await read('gate/free')).page?.body === 'Free.',
  )
  await call(
    curator,
    'PUT',
    '/v1/brains/demo/wiki/settings',
    { writeMode: 'auto', base: { writeMode: 'ask_first' } },
    (b) => b.writeMode,
  )
  const back2 = await propose(contributor, 'Back to auto', [
    {
      op: 'edit',
      address: 'gate/free',
      baseRevision: await revision('gate/free'),
      body: 'Applied.',
      reason: 'R.',
    },
  ])
  check(
    'set back to apply automatically, it applies again',
    (back2.body as unknown as R1).status === 'applied',
  )
  const r = await propose(reader, 'A reader tries', [
    {
      op: 'edit',
      address: 'gate/free',
      baseRevision: await revision('gate/free'),
      body: 'Reader.',
      reason: 'R.',
    },
  ])
  check('a reader cannot propose (403)', r.status === 403)
}

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-gate-a ${new Date().toISOString()} · this tree ${commit} · old data from ${OLD} (v0.7.15)`)
// 1. A clean install of this release.
const fresh = await cleanInstall({ build: !noBuild })
try {
  await gate(fresh.base, fresh, 'clean install')
} finally {
  await fresh.stop()
  await fresh.drop()
}
// 2. The data of v0.7.15, migrated by this release.
const oldDir = await mkdtemp(join(tmpdir(), 'rscb-old-'))
let dbUrl = ''
try {
  await run('sh', ['-c', `git -C "${ROOT}" archive ${OLD} | tar -x -C "${oldDir}"`])
  await symlink(join(ROOT, 'node_modules'), join(oldDir, 'node_modules'))
  await build(oldDir)
  dbUrl = await createDatabase()
  const old = await serve(dbUrl, oldDir)
  const people = await populate(old.base)
  // Used as v0.7.15 is: a page by hand and a proposal that waits (the only mode it has).
  const oldCall = api(old.base)
  await oldCall(people.curator, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'legacy',
    type: 'topic',
    title: 'Legacy',
    summary: 'Written before.',
    body: 'Before the upgrade.',
  })
  await old.stop()
  say('$ v0.7.15 stopped; this release starts on the same database (it migrates on start)')
  const now = await serve(dbUrl, ROOT)
  try {
    const legacy = await api(now.base)(
      { token: people.reader.token, name: people.reader.name },
      'GET',
      '/v1/brains/demo/pages/legacy',
      undefined,
      (b) => (b.page as { body: string }).body,
    )
    check(
      'the page written under v0.7.15 reads as before',
      (legacy.body.page as { body: string } | undefined)?.body === 'Before the upgrade.',
    )
    await gate(now.base, people, 'v0.7.15 data, migrated')
  } finally {
    await now.stop()
  }
} finally {
  if (dbUrl) await dropDatabase(dbUrl)
  await rm(oldDir, { recursive: true, force: true })
}
say(failed ? `\nFAIL (${failed})` : '\nPASS')
process.exit(failed ? 1 : 0)
