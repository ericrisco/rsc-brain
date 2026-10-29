// CA19 and P4: a brain you cannot read answers exactly like one that does not exist — same status,
// same headers that matter, same body — on every route that names a brain. And bad input is a 400
// with a way out, never a 500.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('error answers', { skip: skipPg }, () => {
  let w: World
  let owner: { id: string; key: string }
  let other: { id: string; key: string }
  before(async () => {
    w = await world()
    owner = await w.person('Owner')
    other = await w.person('Other')
    await w.call(owner.key, 'POST', '/v1/brains', { slug: 'private-one' })
  })
  after(async () => w.close())

  const raw = async (key: string, method: string, path: string) => {
    const res = await fetch(`${w.base}${path}`, { method, headers: { authorization: `Bearer ${key}` } })
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      length: res.headers.get('content-length'),
      body: await res.text(),
    }
  }

  for (const [method, suffix] of [
    ['GET', ''],
    ['POST', '/archive'],
    ['POST', '/unarchive'],
  ] as const) {
    it(`${method} /v1/brains/:slug${suffix}: hidden and missing are indistinguishable`, async () => {
      const hidden = await raw(other.key, method, `/v1/brains/private-one${suffix}`)
      const missing = await raw(other.key, method, `/v1/brains/does-not-exist${suffix}`)
      assert.equal(hidden.status, 404)
      assert.deepEqual(hidden, missing)
    })
  }

  it('a NUL byte in the path or the body is a 400, not a 500', async () => {
    const p = await w.call(owner.key, 'GET', '/v1/brains/%00')
    assert.equal(p.status, 400)
    const b = await w.call(owner.key, 'POST', '/v1/brains', { slug: 'nul-test', name: 'a\u0000b' })
    assert.equal(b.status, 400)
    assert.match(b.body.error?.message ?? '', /NUL/)
  })

  it('malformed percent-encoding is a 400', async () => {
    assert.equal((await w.call(owner.key, 'GET', '/v1/brains/%E0%A4%A')).status, 400)
  })

  it('HEAD /v1/health answers', async () => {
    const res = await fetch(`${w.base}/v1/health`, { method: 'HEAD' })
    assert.equal(res.status, 200)
  })
})
