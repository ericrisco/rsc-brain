// Usage of T005 (spec learning-memory A1, R1: CA-A1, A4, A5, A7, A8, A11, A20): proposals that apply at once, on a clean
// installation, over HTTP and /mcp only, as an agent's key and the web would.
//   - a contributor's proposal applies: a revision and a log line, and the answer says «applied»;
//   - half on a protected page: that half waits («held», protected), the other applies;
//   - an edit on an old revision comes back with the current page («returned»); sent again on it, it applies;
//   - the same request key twice: one revision; by MCP too;
//   - «Ask first»: the answer of v0.7.15 plus the new fields, nothing applied; a reader is refused.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-propose.ts [--no-build]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { api, cleanInstall, mcp, ROOT, say } from './clean-install.ts'

const run = promisify(execFile)
let failed = 0
const check = (what: string, ok: boolean) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
const pause = () => new Promise((r) => setTimeout(r, 20))

type R1 = {
  status: string
  proposal: { id: string; status: string }
  pages: Array<{ page: string; revision: number; change: string }>
  held: Array<{ op: number; address: string; reason: string }>
  returned: Array<{
    op: number
    address: string
    reason: string
    currentRevision: number
    current: { revision: number }
  }>
}
const r1 = (b: Record<string, unknown>) => {
  const x = b as unknown as R1
  return {
    status: x.status,
    proposal: x.proposal?.status,
    pages: x.pages,
    held: x.held?.map((h) => `${h.op} ${h.address} ${h.reason}`),
    returned: x.returned?.map((r) => `${r.op} ${r.address} ${r.reason} now ${r.currentRevision}`),
  }
}

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-propose ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
const tool = mcp(inst.base)
try {
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const cole = { token: inst.contributor.token, name: 'Cole' }
  const rita = { token: inst.reader.token, name: 'Rita' }
  const page = async (address: string) =>
    (
      await call(rita, 'GET', `/v1/brains/demo/pages/${address}`, undefined, (b) => ({
        revision: (b.page as { revision: number }).revision,
      }))
    ).body.page as { revision: number; body: string } | undefined

  const e = await call(cole, 'POST', '/v1/brains/demo/entries', {
    type: 'learning',
    title: 'Hooks',
    content: 'The first 30 seconds decide.',
  })
  const source = (e.body.receipt as { entryId: string }).entryId
  const create = (address: string) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
  })
  const edit = (address: string, baseRevision: number, body: string) => ({
    op: 'edit',
    address,
    baseRevision,
    body,
    reason: 'Better words.',
  })
  await call(web, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'runbook',
    type: 'guide',
    title: 'Runbook',
    summary: 'What to do.',
    body: 'Steps.',
  })
  await call(web, 'PUT', '/v1/brains/demo/protection/runbook', { protected: true }, (b) => ({
    protected: (b.page as { protected: boolean }).protected,
  }))

  const a = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    { title: 'Hooks page', ops: [create('hooks')] },
    r1,
  )
  check(
    'CA-A1: the proposal applied at once, page at revision 1',
    a.status === 201 &&
      (a.body as unknown as R1).status === 'applied' &&
      (await page('hooks'))?.revision === 1,
  )
  const log = await call(web, 'GET', '/v1/brains/demo/wiki/log?kind=proposal', undefined, (b) =>
    (b.items as Array<{ summary: string }>).map((l) => l.summary),
  )
  check(
    'CA-A1: the wiki log has the line «Applied at once: Hooks page»',
    (log.body.items as Array<{ summary: string }>).some((l) => l.summary === 'Applied at once: Hooks page'),
  )

  const half = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    { title: 'Runbook and tips', ops: [edit('runbook', 1, 'By an agent.'), create('tips')] },
    r1,
  )
  const hb = half.body as unknown as R1
  check(
    'CA-A4, A5: the part on the protected page waits, the other applies; the proposal is partially applied',
    hb.held.length === 1 &&
      hb.held[0]?.reason === 'protected' &&
      hb.pages.map((p) => p.page).join() === 'tips' &&
      hb.proposal.status === 'partially_applied' &&
      (await page('runbook'))?.revision === 1,
  )

  await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    { title: 'Hooks v2', ops: [edit('hooks', 1, 'Two.')] },
    r1,
  )
  const old = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    { title: 'Hooks from 1', ops: [edit('hooks', 1, 'Old base.')] },
    r1,
  )
  const ob = old.body as unknown as R1
  check(
    'an edit on revision 1 comes back with the page at revision 2',
    ob.status === 'returned' &&
      ob.returned[0]?.currentRevision === 2 &&
      ob.returned[0]?.current.revision === 2,
  )
  const redo = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    { title: 'Hooks from 2', ops: [edit('hooks', 2, 'New base.')] },
    r1,
  )
  check(
    'sent again on revision 2, it applies (revision 3)',
    (redo.body as unknown as R1).status === 'applied' && (await page('hooks'))?.revision === 3,
  )

  const body = { title: 'Keyed', ops: [create('keyed')], requestKey: 'usage-1' }
  const k1 = await call(cole, 'POST', '/v1/brains/demo/proposals', body, r1)
  await pause()
  const k2 = await call(cole, 'POST', '/v1/brains/demo/proposals', body, r1)
  check(
    'CA-A11: the same request key twice: the same proposal, and the page has one revision',
    (k1.body as unknown as R1).proposal.id === (k2.body as unknown as R1).proposal.id &&
      (await page('keyed'))?.revision === 1,
  )

  const m1 = await tool(
    cole,
    'brain_propose',
    { brain: 'demo', title: 'By MCP', ops: [create('by-mcp')], requestKey: 'mcp-1' },
    r1,
  )
  const m2 = await tool(
    cole,
    'brain_propose',
    { brain: 'demo', title: 'By MCP', ops: [create('by-mcp')], requestKey: 'mcp-1' },
    r1,
  )
  check(
    'by MCP: applied, and the retry gets the same receipt',
    (m1.result as unknown as R1)?.status === 'applied' &&
      (m1.result as unknown as R1).proposal.id === (m2.result as unknown as R1)?.proposal.id &&
      (await page('by-mcp'))?.revision === 1,
  )

  await call(web, 'PUT', '/v1/brains/demo/wiki/settings', { writeMode: 'ask_first' }, (b) => ({
    writeMode: b.writeMode,
  }))
  const asked = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    { title: 'Asked first', ops: [create('asked')] },
    (b) => ({ ...r1(b), keys: Object.keys(b).sort() }),
  )
  const ab = asked.body as unknown as R1 & Record<string, unknown>
  check(
    'CA-A7: «Ask first»: nothing applies, the proposal is pending with the fields of v0.7.15 and the new ones',
    ab.status === 'held' &&
      ab.proposal.status === 'pending' &&
      ['proposal', 'ops', 'warnings', 'coherence', 'neighbours', 'held', 'pages'].every((k) => k in ab) &&
      (await page('asked')) === undefined,
  )
  await pause()
  await call(web, 'PUT', '/v1/brains/demo/wiki/settings', { writeMode: 'auto' }, (b) => ({
    writeMode: b.writeMode,
  }))
  const byReader = await call(rita, 'POST', '/v1/brains/demo/proposals', {
    title: 'Reader',
    ops: [create('nope')],
  })
  check('CA-A8: a reader cannot propose (403)', byReader.status === 403)
} finally {
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
