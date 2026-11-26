// Spec learning-memory A3 and A4 (plan §2.6): a curator in the web protects and unprotects a page (no page is born
// protected; each change is a line in the wiki log, not a revision), and chooses per brain whether agents' changes
// apply at once («auto», the default) or wait («ask_first»); each change of mode is an audit line. CA-A19, U3.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('protected pages', { skip: skipPg }, () => {
  let w: World
  let cur: { id: string; key: string }
  let con: { id: string; key: string }
  let rea: { id: string; key: string }
  let out: { id: string; key: string }
  let web: string
  const page = async (address: string, key?: string) => {
    const r = await w.call(key ?? rea.key, 'GET', `/v1/brains/pp/pages/${address}`)
    assert.equal(r.status, 200, r.text)
    return r.body.page as { revision: number; protected: boolean }
  }
  const protect = (address: string, value: unknown, session?: string) =>
    w.callWeb(session ?? web, 'PUT', `/v1/brains/pp/protection/${address}`, { protected: value })
  const lines = async () => {
    const r = await w.call(cur.key, 'GET', '/v1/brains/pp/wiki/log?kind=protect')
    assert.equal(r.status, 200, r.text)
    return (r.body.items as Array<{ kind: string; summary: string; pages: string[]; actorId: string }>).map(
      (l) =>
        `${l.kind} ${l.summary} [${l.pages.join(',')}] ${l.actorId === cur.id ? 'by curator' : l.actorId}`,
    )
  }

  before(async () => {
    w = await world()
    cur = await w.person('Cora')
    con = await w.person('Cole')
    rea = await w.person('Rita')
    out = await w.person('Otto')
    await w.call(cur.key, 'POST', '/v1/brains', { slug: 'pp', purpose: 'Protection.' })
    await w.member('pp', con.id, 'contributor')
    await w.member('pp', rea.id, 'reader')
    web = await w.web(cur.id)
    for (const address of ['guide', 'notes']) {
      const r = await w.callWeb(web, 'POST', '/v1/brains/pp/wiki/changes', {
        op: 'create',
        address,
        type: 'guide',
        title: address,
        summary: `The ${address}.`,
        body: 'Text.',
      })
      assert.equal(r.status, 201, r.text)
    }
  })
  after(async () => w.close())

  it('CA-A19: in a new brain, no page is protected', async () => {
    assert.equal((await page('guide')).protected, false)
    assert.equal((await page('notes')).protected, false)
    assert.deepEqual(await lines(), [])
  })

  it('CA-A19: a curator in the web protects and unprotects; each change is a log line, never a revision', async () => {
    const r = await protect('guide', true)
    assert.equal(r.status, 200, r.text)
    assert.equal((r.body.page as { protected: boolean }).protected, true)
    const p = await page('guide')
    assert.equal(p.protected, true)
    assert.equal(p.revision, 1)
    // The same again changes nothing and writes no line.
    assert.equal((await protect('guide', true)).status, 200)
    assert.deepEqual(await lines(), ['protect Protected: guide [guide] by curator'])
    w.advance(60_000)
    const u = await protect('guide', false)
    assert.equal(u.status, 200, u.text)
    assert.equal((await page('guide')).protected, false)
    assert.equal((await page('guide')).revision, 1)
    assert.deepEqual(await lines(), [
      'protect Unprotected: guide [guide] by curator',
      'protect Protected: guide [guide] by curator',
    ])
  })

  it('a page is found by any address it had', async () => {
    const moved = await w.callWeb(web, 'POST', '/v1/brains/pp/wiki/changes', {
      op: 'move',
      address: 'notes',
      to: 'notes-v2',
      reason: 'Renamed.',
    })
    assert.ok(moved.status < 300, moved.text)
    const r = await protect('notes', true)
    assert.equal(r.status, 200, r.text)
    assert.equal((await page('notes-v2')).protected, true)
    assert.equal((await protect('notes-v2', false)).status, 200)
  })

  it('only a curator, only in the web: a key (a curator’s too), a contributor and a reader are refused', async () => {
    const key = await w.call(cur.key, 'PUT', '/v1/brains/pp/protection/guide', { protected: true })
    assert.equal(key.status, 403, key.text)
    assert.equal(key.body.error?.code, 'protect_web_only')
    assert.match(key.body.error?.howToProceed ?? '', /web/)
    const asContributor = await protect('guide', true, await w.web(con.id))
    assert.equal(asContributor.status, 403, asContributor.text)
    const asReader = await protect('guide', true, await w.web(rea.id))
    assert.equal(asReader.status, 403, asReader.text)
    assert.equal((await page('guide')).protected, false)
  })

  it('someone outside the brain sees no brain; a missing page is not found; the value is true or false', async () => {
    const outside = await protect('guide', true, await w.web(out.id))
    assert.equal(outside.status, 404, outside.text)
    const none = await protect('nowhere', true)
    assert.equal(none.status, 404, none.text)
    for (const bad of ['yes', 1, null]) {
      const r = await protect('guide', bad)
      assert.equal(r.status, 400, `${String(bad)}: ${r.text}`)
    }
  })
})

describe('the write mode of a wiki', { skip: skipPg }, () => {
  let w: World
  let cur: { id: string; key: string }
  let rea: { id: string; key: string }
  let web: string
  const audit = async () => {
    const r = await w.callWeb(web, 'GET', '/v1/brains/wm/audit')
    assert.equal(r.status, 200, r.text)
    return (r.body.items as Array<{ action: string; detail: string; actor: { id: string } | null }>)
      .filter((a) => a.action === 'wiki.mode')
      .map((a) => `${a.detail} ${a.actor?.id === cur.id ? 'by curator' : a.actor?.id}`)
  }

  before(async () => {
    w = await world()
    cur = await w.person('Cora')
    rea = await w.person('Rita')
    await w.call(cur.key, 'POST', '/v1/brains', { slug: 'wm' })
    await w.member('wm', rea.id, 'reader')
    web = await w.web(cur.id)
  })
  after(async () => w.close())

  it('a new brain applies at once; members read the mode', async () => {
    const r = await w.call(rea.key, 'GET', '/v1/brains/wm/wiki/settings')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.writeMode, 'auto')
  })

  it('CA-U3: a curator in the web goes to «Ask first» and back; each change is an audit line', async () => {
    const ask = await w.callWeb(web, 'PUT', '/v1/brains/wm/wiki/settings', { writeMode: 'ask_first' })
    assert.equal(ask.status, 200, ask.text)
    assert.equal(ask.body.writeMode, 'ask_first')
    assert.equal((await w.call(rea.key, 'GET', '/v1/brains/wm/wiki/settings')).body.writeMode, 'ask_first')
    // Saving the same mode again is no change: no line.
    const same = await w.callWeb(web, 'PUT', '/v1/brains/wm/wiki/settings', { writeMode: 'ask_first' })
    assert.equal(same.status, 200, same.text)
    const back = await w.callWeb(web, 'PUT', '/v1/brains/wm/wiki/settings', {
      base: { writeMode: 'ask_first' },
      writeMode: 'auto',
    })
    assert.equal(back.status, 200, back.text)
    assert.deepEqual(await audit(), ['auto by curator', 'ask_first by curator'])
  })

  it('refuses another value, a stale base, a key and a reader', async () => {
    const bad = await w.callWeb(web, 'PUT', '/v1/brains/wm/wiki/settings', { writeMode: 'sometimes' })
    assert.equal(bad.status, 400, bad.text)
    const stale = await w.callWeb(web, 'PUT', '/v1/brains/wm/wiki/settings', {
      base: { writeMode: 'ask_first' },
      writeMode: 'auto',
    })
    assert.equal(stale.status, 409, stale.text)
    const key = await w.call(cur.key, 'PUT', '/v1/brains/wm/wiki/settings', { writeMode: 'ask_first' })
    assert.equal(key.status, 403, key.text)
    const reader = await w.callWeb(await w.web(rea.id), 'PUT', '/v1/brains/wm/wiki/settings', {
      writeMode: 'ask_first',
    })
    assert.equal(reader.status, 403, reader.text)
    assert.equal((await w.call(rea.key, 'GET', '/v1/brains/wm/wiki/settings')).body.writeMode, 'auto')
  })
})
