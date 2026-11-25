// Usage of T006 (spec learning-memory A1: CA-A9 the mark, A17): what an agent changes enters «Review later» and its pages
// read «unreviewed» — on the page, in search, among neighbours and in the context — until a person edits them by hand.
// A key with the wiki write permission writing directly is no exception. Clean installation, HTTP only.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-unreviewed.ts [--no-build]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { api, cleanInstall, ROOT, say } from './clean-install.ts'

const run = promisify(execFile)
let failed = 0
const check = (what: string, ok: boolean) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-unreviewed ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
try {
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const cole = { token: inst.contributor.token, name: 'Cole' }
  const coleWeb = { cookie: inst.contributor.cookie, name: 'Cole' }
  const rita = { token: inst.reader.token, name: 'Rita' }
  type Page = { page: { revision: number; unreviewed: boolean } }
  const mark = (b: Record<string, unknown>) => ({
    revision: (b as Page).page.revision,
    unreviewed: (b as Page).page.unreviewed,
  })
  const page = async (address: string) =>
    ((await call(rita, 'GET', `/v1/brains/demo/pages/${address}`, undefined, mark)).body as Page).page

  const e = await call(cole, 'POST', '/v1/brains/demo/entries', {
    type: 'learning',
    title: 'Pangolite',
    content: 'Pangolite facts.',
  })
  const source = (e.body.receipt as { entryId: string }).entryId
  await call(web, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'overview',
    type: 'topic',
    title: 'Overview',
    summary: 'All of it.',
    body: 'Overview.',
  })
  const r = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    {
      title: 'Pangolite page',
      ops: [
        {
          op: 'create',
          address: 'pangolite',
          type: 'topic',
          title: 'Pangolite',
          summary: 'What we know.',
          body: 'Pangolite is what we use.',
          sources: [{ entryId: source }],
          links: [{ kind: 'related', to: 'overview' }],
          reason: 'From the journal.',
        },
      ],
    },
    (b) => ({ status: b.status, review: b.review, undo: b.undo }),
  )
  check(
    'the applied proposal says «pending-review» and how to undo it',
    r.body.review === 'pending-review' && /^chg_/.test(String(r.body.undo)),
  )
  check('CA-A9: the page reads «unreviewed»', (await page('pangolite')).unreviewed === true)
  check('the curator’s page does not', (await page('overview')).unreviewed === false)
  const s = await call(rita, 'GET', '/v1/search?q=pangolite&brains=demo&in=pages', undefined, (b) =>
    (b.items as Array<{ address: string; unreviewed: boolean }>).map(
      (h) => `${h.address} unreviewed=${h.unreviewed}`,
    ),
  )
  check(
    'CA-A9: search marks it',
    (s.body.items as Array<{ address: string; unreviewed: boolean }>).some(
      (h) => h.address === 'pangolite' && h.unreviewed,
    ),
  )
  const n = await call(
    rita,
    'GET',
    '/v1/search?q=overview&brains=demo&in=pages&neighbours=1',
    undefined,
    (b) =>
      (b.neighbours as Array<{ address: string; unreviewed: boolean }>).map(
        (h) => `${h.address} unreviewed=${h.unreviewed}`,
      ),
  )
  check(
    'CA-A9: as a neighbour too',
    (n.body.neighbours as Array<{ address: string; unreviewed: boolean }>).some(
      (h) => h.address === 'pangolite' && h.unreviewed,
    ),
  )
  const c = await call(cole, 'GET', '/v1/brains/demo/context?task=pangolite', undefined, (b) => ({
    head: /<<<page address=pangolite[^>]*>>>/.exec(String(b.text))?.[0],
    item: (b.items as Array<{ address?: string; unreviewed?: boolean }>).find(
      (i) => i.address === 'pangolite',
    ),
  }))
  check(
    'CA-A9: the context gives it with reviewed=no',
    /<<<page address=pangolite [^>]*reviewed=no/.test(String(c.body.text)),
  )

  // A key with the permission, writing directly.
  const t = await call(coleWeb, 'POST', '/v1/me/tokens', {
    name: 'Cole writer',
    perm: 'write',
    brains: ['demo'],
    days: 30,
  })
  const tok = t.body.token as { id: string; secret: string }
  await call(web, 'PUT', `/v1/brains/demo/wiki/writers/${tok.id}`)
  await call(web, 'PUT', '/v1/brains/demo/protection/overview', { protected: true })
  const wr = await call(
    { token: tok.secret, name: 'Cole writer' },
    'POST',
    '/v1/brains/demo/wiki/write',
    {
      title: 'Overview by the writer',
      ops: [
        { op: 'edit', address: 'overview', baseRevision: 1, body: 'Overview, written.', reason: 'Direct.' },
      ],
    },
    (b) => ({ applied: b.applied, undo: b.undo }),
  )
  check(
    'CA-A17: the direct write on the protected page applies and enters «Review later»; the page is marked',
    wr.status === 201 && /^chg_/.test(String(wr.body.undo)) && (await page('overview')).unreviewed === true,
  )

  const p = await page('pangolite')
  await call(
    web,
    'PATCH',
    '/v1/brains/demo/pages/pangolite',
    { baseRevision: p.revision, body: 'Edited by Cora.' },
    mark,
  )
  check(
    'CA-A9: the curator’s edit by hand takes the mark off',
    (await page('pangolite')).unreviewed === false,
  )
} finally {
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
