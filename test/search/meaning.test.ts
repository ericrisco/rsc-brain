// Spec B3 «Búsqueda por significado»: off by default; on only by the administration in the web with the
// warning accepted; found by meaning with its reason; a provider down never fails a search; a brain
// excluded by its curator loses its vectors and sends nothing more.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { embedPending } from '../../src/domain/meaning.ts'
import { type FakeProvider, fakeProvider } from '../helpers/meaning.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Hit = { kind: string; id: string; address?: string; why: string; reason: string; brain: string }
type Found = { items: Hit[]; note?: string; meaning?: string }

describe('search by meaning', { skip: skipPg }, () => {
  let w: World
  let test: FakeProvider
  let other: FakeProvider
  let eric: { id: string; key: string }
  let admin: { id: string; key: string }
  let ericWeb: string
  let adminWeb: string
  let retention: string

  const find = async (query: string) => {
    const r = await w.call(eric.key, 'GET', `/v1/search?${query}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as Found
  }
  const q = (text: string) => `q=${encodeURIComponent(text)}`
  const page = async (slug: string, address: string, title: string, body: string) => {
    const r = await w.callWeb(ericWeb, 'POST', `/v1/brains/${slug}/wiki/changes`, {
      op: 'create',
      address,
      type: 'topic',
      title,
      summary: '',
      body,
    })
    assert.equal(r.status, 201, r.text)
    return (
      (await w.call(eric.key, 'GET', `/v1/brains/${slug}/pages/${address}`)).body.page as { id: string }
    ).id
  }
  const process = async () => {
    let n = 0
    for (let i = 0; i < 50; i++) {
      const k = await embedPending(w.db, { test, other }, w.clock())
      n += k
      if (k === 0) break
    }
    return n
  }

  before(async () => {
    test = fakeProvider('test', 'fake-1')
    other = fakeProvider('other', 'fake-2')
    w = await world({ meaning: { test, other } })
    eric = await w.person('Eric')
    admin = await w.person('Admin', { isAdmin: true })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Videos.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'private', purpose: 'Private.' })
    ericWeb = await w.web(eric.id)
    adminWeb = await w.web(admin.id)
    retention = await page('yt', 'retention', 'Retention', 'How viewers stay to the end of a video.')
    await page('yt', 'voces', 'Claridad', 'retenemos al público con voces claras')
    await page('yt', 'cameras', 'Cameras', 'Which lens to buy.')
  })
  after(async () => w.close())

  it('CA6: off by default, search works by words and says nothing about meaning', async () => {
    const f = await find(q('audience drop-off'))
    assert.deepEqual(f.items, [])
    assert.equal(f.meaning, undefined)
    assert.equal(await process(), 0)
    assert.deepEqual(test.sent, [])
  })

  it('CA7: only the administration, in the web, and only with the warning accepted, turns it on', async () => {
    const get = await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')
    assert.equal(get.status, 200, get.text)
    assert.deepEqual([get.body.enabled, get.body.available], [false, ['test', 'other']])
    assert.match(String(get.body.warning), /will be sent to this provider.*cannot be taken back/)
    const noAccept = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'test' })
    assert.equal(noAccept.status, 400)
    assert.match(JSON.stringify(noAccept.body), /cannot be taken back/)
    assert.equal((await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')).body.enabled, false)
    assert.equal(
      (await w.callWeb(ericWeb, 'PUT', '/v1/admin/meaning', { provider: 'test', accept: true })).status,
      403,
    )
    assert.equal(
      (await w.call(admin.key, 'PUT', '/v1/admin/meaning', { provider: 'test', accept: true })).status,
      403,
    )
    assert.equal(
      (await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'nope', accept: true })).status,
      400,
    )
    const on = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'test', accept: true })
    assert.equal(on.status, 200, on.text)
    assert.deepEqual([on.body.enabled, on.body.provider, on.body.acceptedBy], [true, 'test', admin.id])
    const audit = await w.db.one("SELECT detail FROM audit WHERE action = 'meaning.enable'")
    assert.match(String(audit?.detail), /warning accepted/)
  })

  it('progress shows what is processed; what is not yet is still found by words', async () => {
    const before = (await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')).body.progress as {
      done: number
      total: number
    }
    assert.equal(before.done, 0)
    assert.ok(before.total >= 3)
    assert.equal((await find(q('retention'))).items[0]?.id, retention)
    await process()
    const now = (await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')).body.progress as {
      done: number
      total: number
    }
    assert.equal(now.done, now.total)
  })

  it('CA4 (and CA2 "voice"): found by meaning, with the reason', async () => {
    const f = await find(q('audience drop-off'))
    assert.equal(f.meaning, 'on')
    const hit = f.items.find((h) => h.id === retention)
    assert.deepEqual([hit?.why, hit?.reason], ['meaning', 'matched by meaning'])
    assert.ok(!f.items.some((h) => h.address === 'cameras'))
    const voice = await find(q('voice'))
    assert.ok(voice.items.some((h) => h.address === 'voces' && h.why === 'meaning'))
    // Words still win where they match.
    assert.equal((await find(q('retention'))).items[0]?.why, 'words')
  })

  it('CA5: with the provider down, results by words and a note, never an error', async () => {
    test.failing = true
    const f = await find(q('retention'))
    assert.equal(f.items[0]?.id, retention)
    assert.equal(f.meaning, 'unavailable')
    assert.match(f.note ?? '', /Meaning search unavailable/)
    test.failing = false
  })

  it('an edited page is not found by its old meaning before it is processed again', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/yt/pages/cameras')
    const rev = (r.body.page as { revision: number }).revision
    const e = await w.callWeb(ericWeb, 'PATCH', '/v1/brains/yt/pages/cameras', {
      baseRevision: rev,
      body: 'Which lens to buy for the narrator voice.',
    })
    assert.equal(e.status, 200, e.text)
    assert.ok(!(await find(q('audience drop-off'))).items.some((h) => h.address === 'cameras'))
    await process()
    assert.ok((await find(q('voice'))).items.some((h) => h.address === 'cameras'))
  })

  it('CA8: a brain excluded by its curator loses its vectors, sends nothing more, and is not found by meaning', async () => {
    await page('private', 'secret', 'Secret', 'Our audience retention numbers.')
    await process()
    const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'private'")
    const count = async () =>
      (
        await w.db.one<{ n: number }>('SELECT count(*)::int AS n FROM meaning_vectors WHERE brain_id = $1', [
          b?.id,
        ])
      )?.n
    assert.ok(((await count()) ?? 0) > 0)
    const ex = await w.callWeb(ericWeb, 'PUT', '/v1/brains/private/wiki/settings', { meaningExcluded: true })
    assert.equal(ex.status, 200, ex.text)
    assert.equal(ex.body.meaningExcluded, true)
    assert.equal(await count(), 0)
    test.sent = []
    await page('private', 'secret2', 'More', 'viewers stay longer with captions')
    await process()
    assert.ok(!test.sent.some((t) => t.includes('captions') || t.includes('Our audience')))
    assert.equal(await count(), 0)
    const f = await find(`${q('audience drop-off')}&brains=private`)
    assert.ok(!f.items.some((h) => h.why === 'meaning'))
    // A contributor cannot exclude a brain.
    const ana = await w.person('Ana')
    await w.member('yt', ana.id, 'contributor')
    const no = await w.callWeb(await w.web(ana.id), 'PUT', '/v1/brains/yt/wiki/settings', {
      meaningExcluded: true,
    })
    assert.equal(no.status, 403)
  })

  it('changing provider processes everything again with the new one', async () => {
    const on = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'other', accept: true })
    assert.equal(on.status, 200, on.text)
    assert.equal(
      (
        await w.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM meaning_vectors WHERE provider = 'test'",
        )
      )?.n,
      0,
    )
    const p = (await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')).body.progress as { done: number }
    assert.equal(p.done, 0)
    await process()
    assert.ok(other.sent.length > 0)
    assert.ok((await find(q('audience drop-off'))).items.some((h) => h.id === retention))
  })

  it('a purged entry loses its vector; turning it off stops meaning search', async () => {
    const r = await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
      type: 'fact',
      title: 'Brand',
      content: 'the logo is blue',
    })
    const id = (r.body.receipt as { entryId: string }).entryId
    await process()
    const has = async () =>
      (
        await w.db.one<{ n: number }>('SELECT count(*)::int AS n FROM meaning_vectors WHERE target_id = $1', [
          id,
        ])
      )?.n
    assert.equal(await has(), 1)
    assert.equal((await w.call(admin.key, 'POST', `/v1/entries/${id}/purge`, { reason: 'x' })).status, 200)
    assert.equal(await has(), 0)
    const off = await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning')
    assert.equal(off.status, 200, off.text)
    const f = await find(q('audience drop-off'))
    assert.equal(f.meaning, undefined)
    assert.ok(!f.items.some((h) => h.why === 'meaning'))
  })
})
