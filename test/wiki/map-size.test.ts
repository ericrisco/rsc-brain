import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { MapGroup } from '../../src/domain/wiki/pages.ts'
import { MAX_REPLY_CHARS } from '../../src/http/bounds.ts'
import { createClient } from '../../web/src/api/client.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('loading a large wiki map (#55)', { skip: skipPg }, () => {
  let w: World
  let session: string
  const path = '/v1/brains/sample/wiki/map'
  const get = (q: string) => w.callWeb(session, 'GET', path + q)
  before(async () => {
    w = await world()
    const curator = await w.person('Curator')
    assert.equal((await w.call(curator.key, 'POST', '/v1/brains', { slug: 'sample' })).status, 201)
    session = await w.web(curator.id)
    await w.db.query(`INSERT INTO pages
      (id,brain_id,address,type,title,summary,tags,status,created_at,updated_at)
      SELECT i::text,b.id,'area'||(i%19)||'/page-'||i,'topic','Page '||i,repeat('😀"',95),
        ARRAY['sample'],CASE WHEN i=588 THEN 'retired' ELSE 'current' END,now(),now()
      FROM brains b CROSS JOIN generate_series(1,588) i WHERE b.slug='sample'`)
  })
  after(async () => w?.close())

  it('returns all groups and summaries through the web client, preserving the status filter in every part', async () => {
    const urls: string[] = []
    const c = createClient({
      here: () => '/b/sample/wiki',
      onSignedOut: () => assert.fail('unexpected sign out'),
      transport: async (url) => {
        urls.push(url)
        const r = await w.callWeb(session, 'GET', url)
        assert.ok(r.text.length <= MAX_REPLY_CHARS)
        return { status: r.status, text: async () => r.text }
      },
    })
    for (const all of [true, false]) {
      urls.length = 0
      const map = await c.call<{ count: number; groups: MapGroup[] }>('wikiMap', {
        path: { slug: 'sample' },
        query: all ? { status: 'all' } : {},
      })
      assert.ok(urls.length > 1)
      assert.equal(map.groups.length, 19)
      assert.equal(map.count, all ? 588 : 587)
      const pages = map.groups.flatMap((g) => g.pages)
      assert.equal(new Set(pages.map((p) => p.address)).size, map.count)
      assert.equal(pages.length, map.count)
      assert.ok(pages.every((p) => p.summary === '😀"'.repeat(95) && p.tags[0] === 'sample'))
      assert.equal(pages.filter((p) => p.status === 'retired').length, all ? 1 : 0)
    }
  })

  it('rejects continuation after a map edit', async () => {
    const first = await get('?status=all')
    const part = first.body.mapChunk as { snapshot: string; next: number }
    assert.ok(part?.next)
    await w.db.query("UPDATE pages SET title='Changed' WHERE id='1'")
    const next = await get(`?status=all&snapshot=${part.snapshot}&offset=${part.next}`)
    assert.equal(next.status, 409)
    assert.equal(next.body.error?.code, 'map_changed')
    assert.equal((await get('?offset=1')).status, 400)
  })
})
