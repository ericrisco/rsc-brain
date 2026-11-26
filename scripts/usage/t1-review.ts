// Usage of T007 (spec learning-memory A2: CA-A9 Keep, A18): the «Review later» tray on a clean installation, over HTTP.
//   - oldest first, with who, which key and the difference of each part;
//   - Keep, by the curator in the web, takes the mark off; a key cannot keep (403);
//   - a part that waits (protected page) is decided by a key with the permission: it applies and enters the tray;
//     a key without it is refused (403); approving a part that applied already: not_held.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-review.ts [--no-build]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { api, cleanInstall, ROOT, say } from './clean-install.ts'

const run = promisify(execFile)
let failed = 0
const check = (what: string, ok: boolean) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
const pause = () => new Promise((r) => setTimeout(r, 20))

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-review ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
try {
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const coraKey = { token: inst.curator.token, name: 'Cora' }
  const cole = { token: inst.contributor.token, name: 'Cole' }
  const coleWeb = { cookie: inst.contributor.cookie, name: 'Cole' }
  const rita = { token: inst.reader.token, name: 'Rita' }
  type Item = {
    id: string
    actor: { name: string }
    keyName: string | null
    ref: string | null
    title: string
    parts: number
  }
  const rows = (b: Record<string, unknown>) =>
    (b.items as Item[]).map(
      (i) => `${i.title} · by ${i.actor.name} · key ${i.keyName} · ref ${i.ref} · ${i.parts} part(s)`,
    )
  const unreviewed = async (address: string) =>
    (
      (
        await call(rita, 'GET', `/v1/brains/demo/pages/${address}`, undefined, (b) => ({
          unreviewed: (b.page as { unreviewed: boolean }).unreviewed,
        }))
      ).body.page as { unreviewed: boolean }
    ).unreviewed

  const e = await call(cole, 'POST', '/v1/brains/demo/entries', {
    type: 'learning',
    title: 'Hooks',
    content: 'Hooks.',
  })
  const source = (e.body.receipt as { entryId: string }).entryId
  const a = await call(cole, 'POST', '/v1/brains/demo/proposals', {
    title: 'Hooks page',
    ops: [
      {
        op: 'create',
        address: 'hooks',
        type: 'topic',
        title: 'Hooks',
        summary: 'Hooks.',
        body: 'Hooks in 30 seconds.',
        sources: [{ entryId: source }],
        reason: 'From the journal.',
      },
    ],
  })
  await pause()
  const t = await call(coleWeb, 'POST', '/v1/me/tokens', {
    name: 'Cole writer',
    perm: 'write',
    brains: ['demo'],
    days: 30,
  })
  const tok = t.body.token as { id: string; secret: string }
  const writer = { token: tok.secret, name: 'Cole writer' }
  await call(web, 'PUT', `/v1/brains/demo/wiki/writers/${tok.id}`)
  const b = await call(writer, 'POST', '/v1/brains/demo/wiki/write', {
    title: 'Hooks, better',
    ops: [
      { op: 'edit', address: 'hooks', baseRevision: 1, body: 'Hooks in 20 seconds.', reason: 'Tighter.' },
    ],
  })
  const tray = await call(web, 'GET', '/v1/brains/demo/wiki/changes', undefined, rows)
  const ids = (tray.body.items as Item[]).map((i) => i.id)
  check(
    'the tray lists both changes, oldest first, with who and which key',
    ids.join() === [a.body.undo, b.body.undo].join() &&
      (tray.body.items as Item[])[0]?.actor.name === 'Cole' &&
      (tray.body.items as Item[])[1]?.keyName === 'Cole writer',
  )
  const d = await call(web, 'GET', `/v1/wiki/changes/${b.body.undo}`, undefined, (x) =>
    (x.parts as Array<{ address: string; revisionBefore: number; revisionAfter: number; diff: string }>).map(
      (p) => `${p.address} ${p.revisionBefore}→${p.revisionAfter}\n${p.diff}`,
    ),
  )
  const diff = (d.body.parts as Array<{ diff: string }>)[0]?.diff ?? ''
  check(
    'the detail shows the difference of the part',
    /-Hooks in 30 seconds\./.test(diff) && /\+Hooks in 20 seconds\./.test(diff),
  )
  const byKey = await call(coraKey, 'POST', `/v1/wiki/changes/${a.body.undo}/keep`)
  check('a key cannot keep, a curator’s neither (403)', byKey.status === 403)
  check('the page is marked before Keep', (await unreviewed('hooks')) === true)
  await call(
    web,
    'POST',
    `/v1/wiki/changes/${a.body.undo}/keep`,
    undefined,
    (x) => (x.change as { state: string }).state,
  )
  await call(
    web,
    'POST',
    `/v1/wiki/changes/${b.body.undo}/keep`,
    undefined,
    (x) => (x.change as { state: string }).state,
  )
  check('CA-A9: after Keep on both, the page is not marked', (await unreviewed('hooks')) === false)

  // A part that waits.
  await call(web, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'runbook',
    type: 'guide',
    title: 'Runbook',
    summary: 'Steps.',
    body: 'Steps.',
  })
  await call(web, 'PUT', '/v1/brains/demo/protection/runbook', { protected: true })
  const p = await call(
    cole,
    'POST',
    '/v1/brains/demo/proposals',
    {
      title: 'Runbook and tips',
      ops: [
        { op: 'edit', address: 'runbook', baseRevision: 1, body: 'By an agent.', reason: 'Better.' },
        {
          op: 'create',
          address: 'tips',
          type: 'topic',
          title: 'Tips',
          summary: 'Tips.',
          body: 'Tips.',
          sources: [{ entryId: source }],
          reason: 'From the journal.',
        },
      ],
    },
    (x) => ({ status: x.status, held: x.held }),
  )
  const id = (p.body.proposal as { id: string }).id
  const review = await call(writer, 'GET', `/v1/proposals/${id}/review`)
  const fp = review.body.fingerprint
  const no = await call(cole, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
  check('CA-A18: a key without the permission cannot decide (403)', no.status === 403)
  const applied = await call(writer, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp, approve: [1] })
  check(
    'approving the part that applied already: 400 not_held',
    applied.status === 400 && (applied.body.error as { code: string }).code === 'not_held',
  )
  const ok = await call(writer, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp }, (x) => ({
    status: (x.proposal as { status: string }).status,
    undo: x.undo,
  }))
  const now = await call(web, 'GET', '/v1/brains/demo/wiki/changes', undefined, rows)
  check(
    'CA-A18: the key with the permission approves the part that waits: it applies and enters the tray',
    ok.status === 200 &&
      (now.body.items as Item[]).some((i) => i.id === ok.body.undo) &&
      (await unreviewed('runbook')) === true,
  )
  const reader = await call(rita, 'GET', '/v1/brains/demo/wiki/changes')
  check('a reader does not see the tray (403)', reader.status === 403)
} finally {
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
