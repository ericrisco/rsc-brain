// Usage of T008 (spec learning-memory A2, R7: CA-A2, A3, A10, A21, A25): undo on a clean installation, over HTTP.
//   - a created page, undone: retired, out of search and context; the log has the change and its undo;
//   - an edit with a later edit on top: 409 undo_conflict; with «overwrite», undone;
//   - twice: alreadyUndone; by parts with dependencies: missing_dependencies, then in order;
//   - a comment: a correction for whoever proposed.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-undo.ts [--no-build]
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
say(`# t1-undo ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
try {
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const cole = { token: inst.contributor.token, name: 'Cole' }
  const rita = { token: inst.reader.token, name: 'Rita' }
  const e = await call(cole, 'POST', '/v1/brains/demo/entries', {
    type: 'learning',
    title: 'Okapite',
    content: 'Okapite.',
  })
  const source = (e.body.receipt as { entryId: string }).entryId
  const create = (address: string) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Okapite on ${address}.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
  })
  const propose = async (title: string, ops: unknown[]) =>
    (
      await call(cole, 'POST', '/v1/brains/demo/proposals', { title, ops }, (b) => ({
        status: b.status,
        undo: b.undo,
      }))
    ).body as { undo: string; proposal: { id: string } }
  const undo = (id: string, body: unknown = {}) =>
    call(web, 'POST', `/v1/wiki/changes/${id}/undo`, body, (b) => ({
      state: (b.change as { state?: string } | undefined)?.state,
      undone: b.undone,
      alreadyUndone: b.alreadyUndone,
      correction: b.correction,
    }))
  const status = async (address: string) =>
    (
      await call(rita, 'GET', `/v1/brains/demo/pages/${address}`, undefined, (b) => ({
        status: (b.page as { status: string }).status,
      }))
    ).status

  const a = await propose('Okapite page', [create('okapite')])
  const u = await undo(a.undo)
  check('CA-A2, A3: the created page is undone', u.status === 200)
  check('the page is retired: its address leads nowhere now', (await status('okapite')) === 404)
  const s = await call(rita, 'GET', '/v1/search?q=okapite&brains=demo&in=pages', undefined, (b) =>
    (b.items as Array<{ address: string }>).map((h) => h.address),
  )
  check(
    'CA-A3: not in search',
    !(s.body.items as Array<{ address: string }>).some((h) => h.address === 'okapite'),
  )
  const c = await call(cole, 'GET', '/v1/brains/demo/context?task=okapite', undefined, () => 'context')
  check('CA-A3: not in the context', !/<<<page address=okapite /.test(String(c.body.text)))
  const log = await call(web, 'GET', '/v1/brains/demo/wiki/log', undefined, (b) =>
    (b.items as Array<{ kind: string; summary: string }>).map((l) => `${l.kind}: ${l.summary}`),
  )
  const lines = (log.body.items as Array<{ kind: string; summary: string }>).map(
    (l) => `${l.kind}: ${l.summary}`,
  )
  check(
    'R7: the log shows the change and its undo',
    lines.includes('proposal: Applied at once: Okapite page') && lines.includes('undo: Undone: Okapite page'),
  )
  const twice = await undo(a.undo)
  check(
    'CA-A21: undoing again: alreadyUndone, nothing changes',
    twice.status === 200 && twice.body.alreadyUndone === true,
  )

  await call(web, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'notes',
    type: 'topic',
    title: 'Notes',
    summary: 'Notes.',
    body: 'First.',
  })
  const first = await propose('Notes A', [
    { op: 'edit', address: 'notes', baseRevision: 1, body: 'A.', reason: 'A.' },
  ])
  await propose('Notes B', [{ op: 'edit', address: 'notes', baseRevision: 2, body: 'B.', reason: 'B.' }])
  const clash = await call(
    web,
    'POST',
    `/v1/wiki/changes/${first.undo}/undo`,
    {},
    (b) => (b.error as { pages?: unknown }).pages,
  )
  check('CA-A10: a later change on the page: 409 undo_conflict, nothing undone', clash.status === 409)
  const over = await undo(first.undo, { overwrite: ['notes'] })
  const body = (
    await call(rita, 'GET', '/v1/brains/demo/pages/notes', undefined, (b) => ({
      body: (b.page as { body: string }).body,
    }))
  ).body.page as { body: string }
  check(
    'with «overwrite», undone: the page is as before the change',
    over.status === 200 && body.body === 'First.',
  )

  await call(web, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'hub',
    type: 'topic',
    title: 'Hub',
    summary: 'Hub.',
    body: 'Hub.',
  })
  const two = await propose('Spoke and link', [
    create('spoke'),
    { op: 'link', address: 'hub', kind: 'related', to: 'spoke', reason: 'See.' },
  ])
  const d = await call(web, 'GET', `/v1/wiki/changes/${two.undo}`, undefined, (b) =>
    (b.parts as Array<{ part: number; address: string; dependsOn: number[] }>).map(
      (p) => `${p.part} ${p.address} needs [${p.dependsOn}]`,
    ),
  )
  const parts = d.body.parts as Array<{ part: number; address: string }>
  const spoke = parts.find((p) => p.address === 'spoke')?.part
  const hub = parts.find((p) => p.address === 'hub')?.part
  const bad = await call(web, 'POST', `/v1/wiki/changes/${two.undo}/undo`, { parts: [spoke] })
  check('by parts: the page another part that stays needs is not undone alone (400)', bad.status === 400)
  const p1 = await undo(two.undo, { parts: [hub] })
  const p2 = await undo(two.undo, { parts: [spoke] })
  check(
    'in order: first the part that needs it, then the other',
    p1.status === 200 && p2.status === 200 && (p2.body.change as { state: string }).state === 'undone',
  )

  const t = await propose('Taught page', [create('taught')])
  const taught = await undo(t.undo, { comment: 'Okapite pages need a source from this quarter.' })
  const entry = await call(rita, 'GET', `/v1/entries/${taught.body.correction}`, undefined, (b) => {
    const x = b.entry as { type: string; appliesTo: string; title: string }
    return { type: x.type, appliesTo: x.appliesTo, title: x.title }
  })
  const x = entry.body.entry as { type: string; appliesTo: string }
  check(
    'CA-A25: the comment is a correction for Cole, who proposed',
    x.type === 'correction' && x.appliesTo === 'Cole',
  )
} finally {
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
