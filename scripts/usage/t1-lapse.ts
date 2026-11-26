// Usage of T002 (spec learning-memory B2: CA-B6, B8, B9, B10, B14 pinned and cited): per-type expiry on a clean
// installation, seen as a client sees it. A server runs on the real clock and no client can wait a week, so the one
// step not over HTTP moves entries back in time in the database («aged N days»: their creation and the moment their
// count starts, as N days of waiting would). Everything else is HTTP: saving, pinning, the curator's settings in the
// web, a page citing an entry, search, include=expired, the start context and the entry's lapsesAt.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-lapse.ts [--no-build]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'
import { api, cleanInstall, ROOT, say } from './clean-install.ts'

const run = promisify(execFile)
let failed = 0
const check = (what: string, ok: boolean) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-lapse ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
const db = new pg.Client({ connectionString: inst.dbUrl })
await db.connect()
try {
  const cole = { token: inst.contributor.token, name: 'Cole' }
  const cora = { token: inst.curator.token, name: 'Cora' }
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const save = async (body: Record<string, unknown>) => {
    const r = await call(cole, 'POST', '/v1/brains/demo/entries', body, (b) => ({
      entryId: (b.receipt as { entryId: string }).entryId,
    }))
    return (r.body.receipt as { entryId: string }).entryId
  }
  const age = async (days: number, ids: string[]) => {
    await db.query(
      `UPDATE entries SET created_at = created_at - make_interval(days => $2),
                          lapse_from = lapse_from - make_interval(days => $2) WHERE id = ANY($1)`,
      [ids, days],
    )
    say(`$ psql: aged ${ids.join(', ')} by ${days} days`)
  }
  const search = async (q: string, include = '') =>
    (
      await call(
        cole,
        'GET',
        `/v1/search?q=${q}&brains=demo&in=entries${include ? `&include=${include}` : ''}`,
        undefined,
        (b) =>
          (b.items as Array<{ id: string; type: string; state: string }>).map(
            (i) => `${i.type}:${i.id}:${i.state}`,
          ),
      )
    ).body.items as Array<{ id: string; state: string }>
  const has = (items: Array<{ id: string }>, id: string) => items.some((i) => i.id === id)

  // The defaults, as members read them.
  await call(cole, 'GET', '/v1/brains/demo/wiki/settings', undefined, (b) => b.entryLifetimes)

  // CA-B6: steps of 6 and 8 days.
  const six = await save({ type: 'step', title: 'Ran the kiwiloom backup', content: 'Kiwiloom backup ran.' })
  const eight = await save({
    type: 'step',
    title: 'Ran the kiwiloom restore',
    content: 'Kiwiloom restore ran.',
  })
  await call(cole, 'GET', `/v1/entries/${six}`, undefined, (b) => ({
    createdAt: (b.entry as { createdAt: string }).createdAt,
    lapsesAt: (b.entry as { lapsesAt: string }).lapsesAt,
  }))
  await age(6, [six])
  await age(8, [eight])
  let items = await search('kiwiloom')
  check('CA-B6: a step of 6 days is found', has(items, six))
  check('CA-B6: a step of 8 days is not', !has(items, eight))
  items = await search('kiwiloom', 'expired')
  check(
    'CA-B6: asked for with include=expired, the step of 8 days is there, marked expired',
    items.some((i) => i.id === eight && i.state === 'expired'),
  )
  const ctx = await call(cole, 'GET', '/v1/brains/demo/context?task=kiwiloom', undefined, (b) => ({
    chars: b.chars,
  }))
  check(
    'CA-B6: the start context has the step of 6 days and not the one of 8',
    String(ctx.body.text).includes(six) && !String(ctx.body.text).includes(eight),
  )

  // CA-B8: a decision a year old.
  const dec = await save({ type: 'decision', title: 'Lemurlake is the store', content: 'We keep lemurlake.' })
  await age(366, [dec])
  check('CA-B8: a decision of a year is found', has(await search('lemurlake'), dec))

  // CA-B9: a date by hand wins, on a type that never lapses.
  const dated = await save({
    type: 'decision',
    title: 'Pandapier freeze',
    content: 'Pandapier frozen until further notice.',
    expiresAt: new Date(Date.now() + 2000).toISOString(),
  })
  check('CA-B9: before its date, the dated decision is found', has(await search('pandapier'), dated))
  await new Promise((r) => setTimeout(r, 2500))
  say('$ waited 2.5 s (real time) past its date')
  check('CA-B9: after its date, the dated decision is not', !has(await search('pandapier'), dated))

  // CA-B10: the curator sets notes to 90 days in the web.
  await call(web, 'PUT', '/v1/brains/demo/wiki/settings', { entryLifetimes: { note: 90 } }, (b) => ({
    note: (b.entryLifetimes as { note: number }).note,
  }))
  const note = await save({ type: 'note', title: 'Otterfold idea', content: 'Otterfold, later.' })
  await call(cole, 'GET', `/v1/entries/${note}`, undefined, (b) => ({
    lapsesAt: (b.entry as { lapsesAt: string }).lapsesAt,
  }))
  await age(60, [note])
  check('CA-B10: a note of 60 days is found (notes last 90 here)', has(await search('otterfold'), note))
  await age(31, [note])
  check('CA-B10: at 91 days it is not', !has(await search('otterfold'), note))

  // CA-B14: pinned and cited steps stay; a plain one does not.
  const pinned = await save({ type: 'step', title: 'Pinned yakbridge step', content: 'Yakbridge pinned.' })
  const cited = await save({ type: 'step', title: 'Cited yakbridge step', content: 'Yakbridge cited.' })
  const plain = await save({ type: 'step', title: 'Plain yakbridge step', content: 'Yakbridge plain.' })
  await call(cora, 'POST', `/v1/entries/${pinned}/pin`, undefined, () => 'pinned')
  await call(
    web,
    'POST',
    '/v1/brains/demo/wiki/changes',
    {
      op: 'create',
      address: 'yakbridge',
      type: 'topic',
      title: 'Yakbridge',
      summary: 'What we know.',
      body: 'From a step.',
      sources: [{ entryId: cited }],
    },
    (b) => ({ address: (b.page as { page: { address: string } }).page.address }),
  )
  await age(30, [pinned, cited, plain])
  items = await search('yakbridge')
  check('CA-B14: a pinned step of 30 days is found', has(items, pinned))
  check('CA-B14: a step of 30 days cited by a current page is found', has(items, cited))
  check('a plain step of 30 days is not', !has(items, plain))
} finally {
  await db.end()
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
