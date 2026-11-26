// Spec learning-memory B2 (plan §2.7): each type of entry lasts so long without use, counted from when it was written
// (or its topic last revised; for what existed, from the upgrade), computed when read. A date set by hand wins. Pinned
// entries and entries cited by a current page do not lapse. Lapsed is not deleted: search can still ask for it.
// CA-B6, B8, B9, B10, B14 (pinned and cited), U1. «Using renews» is tranche 2.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { lapsesAt as lapsesAtSql, notLapsed } from '../../src/domain/lapse.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const DAY = 86_400_000

describe('per-type expiry, computed when read', { skip: skipPg }, () => {
  let w: World
  let cur: { id: string; key: string }
  let con: { id: string; key: string }
  before(async () => {
    w = await world()
    cur = await w.person('Cora')
    con = await w.person('Cole')
    await w.call(cur.key, 'POST', '/v1/brains', { slug: 'ops', purpose: 'Operations.' })
    await w.member('ops', con.id, 'contributor')
  })
  // The clock moves by a year here: keys of today, whatever it says.
  const freshKeys = async () => {
    cur.key = await w.token(cur.id, { days: 365 })
    con.key = await w.token(con.id, { days: 365 })
  }
  // A web session of today, whatever the clock says.
  const asCurator = async () => w.web(cur.id)
  after(async () => w.close())

  const save = async (body: Record<string, unknown>) => {
    const r = await w.call(con.key, 'POST', '/v1/brains/ops/entries', body)
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as { entryId: string }).entryId
  }
  const found = async (word: string, id: string, include = '') => {
    const r = await w.call(
      con.key,
      'GET',
      `/v1/search?q=${word}&brains=ops&in=entries${include ? `&include=${include}` : ''}`,
    )
    assert.equal(r.status, 200, r.text)
    return (r.body.items as Array<{ id: string; state: string }>).find((i) => i.id === id)
  }
  const inContext = async (task: string, id: string) => {
    const r = await w.call(con.key, 'GET', `/v1/brains/ops/context?task=${task}`)
    assert.equal(r.status, 200, r.text)
    return String(r.body.text).includes(id)
  }
  const lapsesAt = async (id: string) =>
    ((await w.call(con.key, 'GET', `/v1/entries/${id}`)).body.entry as { lapsesAt: string | null }).lapsesAt

  it('CA-B6: a step leaves search and context after 7 days, and can be asked for', async () => {
    const id = await save({
      type: 'step',
      title: 'Rotated zebracorn keys',
      content: 'Rotated the zebracorn keys.',
    })
    assert.equal(await lapsesAt(id), new Date(w.now.getTime() + 7 * DAY).toISOString())
    w.advance(6 * DAY)
    assert.ok(await found('zebracorn', id), 'day 6: found')
    assert.ok(await inContext('zebracorn', id), 'day 6: in context')
    w.advance(2 * DAY)
    assert.equal(await found('zebracorn', id), undefined, 'day 8: gone from search')
    assert.equal(await inContext('zebracorn', id), false, 'day 8: gone from context')
    assert.equal((await found('zebracorn', id, 'expired'))?.state, 'expired', 'day 8: asked for, it is there')
  })

  it('CA-B8: a decision still comes out after a year; its lapse date is none', async () => {
    const id = await save({ type: 'decision', title: 'Quokkabase is primary', content: 'We use quokkabase.' })
    assert.equal(await lapsesAt(id), null)
    w.advance(366 * DAY)
    await freshKeys()
    assert.ok(await found('quokkabase', id))
    assert.ok(await inContext('quokkabase', id))
  })

  it('CA-B9: a date set by hand wins over the type, longer or shorter, decisions included', async () => {
    const at = new Date(w.now.getTime() + 3 * DAY).toISOString()
    const note = await save({
      type: 'note',
      title: 'Narwhalfish note',
      content: 'Narwhalfish.',
      expiresAt: at,
    })
    const dec = await save({
      type: 'decision',
      title: 'Narwhalfish rule',
      content: 'Narwhalfish rule.',
      expiresAt: at,
    })
    assert.equal(await lapsesAt(dec), at)
    w.advance(2 * DAY)
    assert.ok(await found('narwhalfish', note))
    assert.ok(await found('narwhalfish', dec))
    w.advance(2 * DAY)
    assert.equal(await found('narwhalfish', note), undefined)
    assert.equal(await found('narwhalfish', dec), undefined, 'a decision with a date lapses on it')
  })

  it('CA-B10: a curator sets notes to 90 days: a new note lasts 90 days', async () => {
    const put = await w.callWeb(await asCurator(), 'PUT', '/v1/brains/ops/wiki/settings', {
      entryLifetimes: { note: 90 },
    })
    assert.equal(put.status, 200, put.text)
    assert.equal((put.body.entryLifetimes as Record<string, number | null>).note, 90)
    const id = await save({ type: 'note', title: 'Axolotlix note', content: 'Axolotlix.' })
    assert.equal(await lapsesAt(id), new Date(w.now.getTime() + 90 * DAY).toISOString())
    w.advance(60 * DAY)
    assert.ok(await found('axolotlix', id), 'day 60: a 30-day note would be gone; this one is not')
    w.advance(31 * DAY)
    assert.equal(await found('axolotlix', id), undefined, 'day 91: gone')
    const back = await w.callWeb(await asCurator(), 'PUT', '/v1/brains/ops/wiki/settings', {
      entryLifetimes: { note: 30 },
    })
    assert.equal(back.status, 200, back.text)
  })

  it('CA-B14: a pinned step and a step cited by a current page still come out after 30 days', async () => {
    const pinned = await save({ type: 'step', title: 'Pinned wombatite step', content: 'Wombatite pinned.' })
    const cited = await save({ type: 'step', title: 'Cited wombatite step', content: 'Wombatite cited.' })
    const plain = await save({ type: 'step', title: 'Plain wombatite step', content: 'Wombatite plain.' })
    const pin = await w.call(cur.key, 'POST', `/v1/entries/${pinned}/pin`)
    assert.equal(pin.status, 200, pin.text)
    const page = await w.callWeb(await asCurator(), 'POST', '/v1/brains/ops/wiki/changes', {
      op: 'create',
      address: 'wombatite',
      type: 'topic',
      title: 'Wombatite',
      summary: 'What we know.',
      body: 'Cited.',
      sources: [{ entryId: cited }],
    })
    assert.equal(page.status, 201, page.text)
    assert.equal(await lapsesAt(pinned), null)
    assert.equal(await lapsesAt(cited), null)
    w.advance(30 * DAY)
    assert.ok(await found('wombatite', pinned), 'pinned')
    assert.ok(await found('wombatite', cited), 'cited by a current page')
    assert.equal(await found('wombatite', plain), undefined, 'neither: gone')
    // A retired page no longer keeps its sources.
    const retire = await w.callWeb(await asCurator(), 'POST', '/v1/brains/ops/wiki/changes', {
      op: 'status',
      address: 'wombatite',
      status: 'retired',
      reason: 'Old.',
    })
    assert.ok(retire.status < 300, retire.text)
    assert.equal(await found('wombatite', cited), undefined, 'cited by a retired page')
  })

  it('a new revision of a topic starts the count again', async () => {
    const id = await save({
      type: 'step',
      topic: 'deploys/gnu',
      title: 'Gnuflow v1',
      content: 'Gnuflow one.',
    })
    w.advance(6 * DAY)
    const again = await save({
      type: 'step',
      topic: 'deploys/gnu',
      title: 'Gnuflow v2',
      content: 'Gnuflow two.',
    })
    assert.equal(again, id)
    w.advance(6 * DAY)
    assert.ok(await found('gnuflow', id), '12 days after it was written, 6 after its revision')
  })

  it('CA-U1: what existed counts from the upgrade, not from its creation', async () => {
    const id = await save({ type: 'step', title: 'Old capybarix step', content: 'Capybarix.' })
    // As 0032 leaves it: written 30 days before, counting from the upgrade (now).
    await w.db.query('UPDATE entries SET created_at = $2, lapse_from = $3 WHERE id = $1', [
      id,
      new Date(w.now.getTime() - 30 * DAY),
      w.now,
    ])
    assert.ok(await found('capybarix', id), 'still out after the upgrade')
    w.advance(8 * DAY)
    assert.equal(await found('capybarix', id), undefined, '7 days after the upgrade, gone')
  })
})

describe('the lifetimes in the wiki settings', { skip: skipPg }, () => {
  let w: World
  let cur: { id: string; key: string }
  let reader: { id: string; key: string }
  let web: string
  before(async () => {
    w = await world()
    cur = await w.person('Cora')
    reader = await w.person('Rita')
    await w.call(cur.key, 'POST', '/v1/brains', { slug: 'ops' })
    await w.member('ops', reader.id, 'reader')
    web = await w.web(cur.id)
  })
  after(async () => w.close())

  const DEFAULTS = {
    step: 7,
    attempt: 14,
    summary: 30,
    note: 30,
    learning: 60,
    decision: null,
    fact: null,
    preference: null,
    correction: null,
  }

  it('members read the lifetimes in force and the defaults', async () => {
    const r = await w.call(reader.key, 'GET', '/v1/brains/ops/wiki/settings')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.entryLifetimes, DEFAULTS)
    assert.deepEqual(r.body.entryLifetimesDefault, DEFAULTS)
  })

  it('a curator in the web changes some types, «never» included; the others keep their default', async () => {
    const r = await w.callWeb(web, 'PUT', '/v1/brains/ops/wiki/settings', {
      entryLifetimes: { step: 14, learning: null, decision: 365 },
    })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.entryLifetimes, { ...DEFAULTS, step: 14, learning: null, decision: 365 })
    assert.deepEqual(r.body.entryLifetimesDefault, DEFAULTS)
    const again = await w.callWeb(web, 'PUT', '/v1/brains/ops/wiki/settings', { entryLifetimes: { step: 7 } })
    assert.deepEqual(again.body.entryLifetimes, { ...DEFAULTS, learning: null, decision: 365 })
  })

  it('refuses a type that does not exist and days out of 1–3650; a key and a reader cannot change them', async () => {
    for (const bad of [{ nope: 3 }, { step: 0 }, { step: 3651 }, { step: 2.5 }, { step: '7' }, [7], 'x']) {
      const r = await w.callWeb(web, 'PUT', '/v1/brains/ops/wiki/settings', { entryLifetimes: bad })
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`)
    }
    const key = await w.call(cur.key, 'PUT', '/v1/brains/ops/wiki/settings', { entryLifetimes: { step: 3 } })
    assert.equal(key.status, 403, key.text)
    const rweb = await w.web(reader.id)
    const rr = await w.callWeb(rweb, 'PUT', '/v1/brains/ops/wiki/settings', { entryLifetimes: { step: 3 } })
    assert.equal(rr.status, 403, rr.text)
  })

  it('with a base, a change made meanwhile is refused (per-field compare, as the other settings)', async () => {
    const now = (await w.call(reader.key, 'GET', '/v1/brains/ops/wiki/settings')).body.entryLifetimes
    const ok = await w.callWeb(web, 'PUT', '/v1/brains/ops/wiki/settings', {
      base: { entryLifetimes: now },
      entryLifetimes: { attempt: 20 },
    })
    assert.equal(ok.status, 200, ok.text)
    const stale = await w.callWeb(web, 'PUT', '/v1/brains/ops/wiki/settings', {
      base: { entryLifetimes: now },
      entryLifetimes: { attempt: 21 },
    })
    assert.equal(stale.status, 409, stale.text)
    assert.equal((stale.body.error as { code: string }).code, 'settings_changed')
  })
})

// Review round 1 of T002: the same arithmetic on every path (fixed 24-hour days), the edges of a lifetime, and the
// exemptions and per-brain lifetimes along each path (search, context, several brains, the state label).
describe('expiry on every path, at its edges', { skip: skipPg }, () => {
  let w: World
  let cur: { id: string; key: string }
  let con: { id: string; key: string }
  before(async () => {
    w = await world()
    cur = await w.person('Cora')
    con = await w.person('Cole')
    for (const slug of ['ops', 'dev']) {
      await w.call(cur.key, 'POST', '/v1/brains', { slug, purpose: slug })
      await w.member(slug, con.id, 'contributor')
    }
    const web = await w.web(cur.id)
    const put = await w.callWeb(web, 'PUT', '/v1/brains/ops/wiki/settings', { entryLifetimes: { note: 90 } })
    assert.equal(put.status, 200, put.text)
  })
  after(async () => w.close())
  const fresh = async () => {
    cur.key = await w.token(cur.id, { days: 365 })
    con.key = await w.token(con.id, { days: 365 })
  }
  const save = async (slug: string, body: Record<string, unknown>) => {
    const r = await w.call(con.key, 'POST', `/v1/brains/${slug}/entries`, body)
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as { entryId: string }).entryId
  }
  const search = async (word: string, brains: string, include = '') => {
    const r = await w.call(
      con.key,
      'GET',
      `/v1/search?q=${word}&brains=${brains}&in=entries${include ? `&include=${include}` : ''}`,
    )
    assert.equal(r.status, 200, r.text)
    return r.body.items as Array<{ id: string; state: string }>
  }
  const inContext = async (slug: string, task: string, id: string) => {
    const r = await w.call(con.key, 'GET', `/v1/brains/${slug}/context?task=${task}`)
    assert.equal(r.status, 200, r.text)
    return String(r.body.text).includes(id)
  }
  const lapses = async (id: string) =>
    ((await w.call(con.key, 'GET', `/v1/entries/${id}`)).body.entry as { lapsesAt: string | null }).lapsesAt

  it('a step is there 7 days less an hour after, gone 7 days and an hour after; its lapse date says when', async () => {
    const id = await save('dev', { type: 'step', title: 'Edge quetzalite', content: 'Quetzalite.' })
    const at = await lapses(id)
    assert.equal(at, new Date(w.now.getTime() + 7 * DAY).toISOString())
    w.advance(7 * DAY - 3_600_000)
    assert.ok(
      (await search('quetzalite', 'dev')).some((i) => i.id === id),
      'an hour before',
    )
    assert.ok(await inContext('dev', 'quetzalite', id), 'an hour before, in context')
    w.advance(2 * 3_600_000)
    assert.equal(
      (await search('quetzalite', 'dev')).find((i) => i.id === id),
      undefined,
      'an hour after',
    )
    assert.equal(await inContext('dev', 'quetzalite', id), false, 'an hour after, not in context')
  })

  it('a date set by hand and its lapse date agree, to the hour', async () => {
    const at = new Date(w.now.getTime() + 5 * DAY + 7_200_000)
    const id = await save('dev', {
      type: 'decision',
      title: 'Hand tamarinix',
      content: 'Tamarinix.',
      expiresAt: at.toISOString(),
    })
    assert.equal(await lapses(id), at.toISOString())
    w.advance(5 * DAY + 3_600_000)
    assert.ok((await search('tamarinix', 'dev')).some((i) => i.id === id))
    w.advance(2 * 3_600_000)
    assert.equal(
      (await search('tamarinix', 'dev')).find((i) => i.id === id),
      undefined,
    )
  })

  it('fixed 24-hour days across a change of summer time, whatever the session time zone', async () => {
    const id = await save('dev', { type: 'step', title: 'Dst ocelotix', content: 'Ocelotix.' })
    // Seven days that cross the end of summer time in Madrid (25 October 2026).
    const from = new Date('2026-10-20T10:00:00.000Z')
    await w.db.query('UPDATE entries SET lapse_from = $2 WHERE id = $1', [id, from])
    const seen = await w.db.tx(async (db) => {
      await db.query("SET LOCAL TIME ZONE 'Europe/Madrid'")
      return db.one<{ at: Date; before: boolean; after: boolean }>(
        `SELECT ${lapsesAtSql('e')} AS at, ${notLapsed('e', '$2::timestamptz')} AS before,
                ${notLapsed('e', '$3::timestamptz')} AS after FROM entries e WHERE e.id = $1`,
        [id, new Date(from.getTime() + 7 * DAY - 60_000), new Date(from.getTime() + 7 * DAY + 60_000)],
      )
    })
    assert.equal(seen?.at.toISOString(), new Date(from.getTime() + 7 * DAY).toISOString())
    assert.deepEqual([seen?.before, seen?.after], [true, false])
  })

  it('per-brain lifetimes, in context and across brains: a note of day 60 is there in ops (90 days), not in dev', async () => {
    const ops = await save('ops', { type: 'note', title: 'Multi kinkajou', content: 'Kinkajou ops.' })
    const dev = await save('dev', { type: 'note', title: 'Multi kinkajou', content: 'Kinkajou dev.' })
    w.advance(60 * DAY)
    await fresh()
    const items = await search('kinkajou', 'ops,dev')
    assert.ok(
      items.some((i) => i.id === ops),
      'ops keeps notes 90 days',
    )
    assert.equal(
      items.find((i) => i.id === dev),
      undefined,
      'dev keeps them 30',
    )
    assert.ok(await inContext('ops', 'kinkajou', ops), 'in the context of ops')
    assert.equal(await inContext('dev', 'kinkajou', dev), false, 'not in the context of dev')
  })

  it('a pinned step and a cited step are in context after 30 days, and are not labelled expired', async () => {
    const pinned = await save('dev', {
      type: 'step',
      title: 'Pinned dugongite',
      content: 'Dugongite pinned.',
    })
    const cited = await save('dev', { type: 'step', title: 'Cited dugongite', content: 'Dugongite cited.' })
    const plain = await save('dev', { type: 'step', title: 'Plain dugongite', content: 'Dugongite plain.' })
    assert.equal((await w.call(cur.key, 'POST', `/v1/entries/${pinned}/pin`)).status, 200)
    const page = await w.callWeb(await w.web(cur.id), 'POST', '/v1/brains/dev/wiki/changes', {
      op: 'create',
      address: 'dugongite',
      type: 'topic',
      title: 'Dugongite',
      summary: 'Known.',
      body: 'Cited.',
      sources: [{ entryId: cited }],
    })
    assert.equal(page.status, 201, page.text)
    w.advance(30 * DAY)
    await fresh()
    assert.ok(await inContext('dev', 'dugongite', pinned), 'pinned, in context')
    assert.ok(await inContext('dev', 'dugongite', cited), 'cited, in context')
    assert.equal(await inContext('dev', 'dugongite', plain), false, 'plain, not in context')
    const all = await search('dugongite', 'dev', 'expired')
    const state = (id: string) => all.find((i) => i.id === id)?.state
    assert.deepEqual([state(pinned), state(cited), state(plain)], ['active', 'active', 'expired'])
  })
})
