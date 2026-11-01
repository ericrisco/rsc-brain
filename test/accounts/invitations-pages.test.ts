// PR26 review: the invitations come by pages from the server (spec B6 «Mucho dato»), filtered by status
// on the server, with the same reach as before (the administration sees all; a curator, the ones they
// could still make), and in a fixed number of queries whatever the page holds (no query per row).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Inv = { id: string; email: string; status: string; brains: Array<{ slug: string; role: string }> }
type PageOf = { invitations: Inv[]; next: string | null }

describe('invitations by pages', { skip: skipPg }, () => {
  let w: World
  let adminWeb: string
  let anaWeb: string
  let admin: { id: string; key: string }
  let ana: { id: string; key: string }
  const get = async (web: string, q = '') => {
    const r = await w.callWeb(web, 'GET', `/v1/invitations${q}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as PageOf
  }
  const all = async (web: string, q = '') => {
    const out: Inv[] = []
    let cursor = ''
    for (let i = 0; i < 50; i++) {
      const p = await get(web, `?limit=7${q}${cursor ? `&cursor=${cursor}` : ''}`)
      assert.ok(p.invitations.length <= 7)
      out.push(...p.invitations)
      if (!p.next) return out
      cursor = encodeURIComponent(p.next)
    }
    throw new Error('never ended')
  }

  before(async () => {
    w = await world()
    admin = await w.person('Admin', { isAdmin: true })
    ana = await w.person('Ana')
    adminWeb = await w.web(admin.id)
    anaWeb = await w.web(ana.id)
    await w.call(ana.key, 'POST', '/v1/brains', { slug: 'yt' })
    await w.call(admin.key, 'POST', '/v1/brains', { slug: 'secret' })
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: true })
    // 30 by Ana to her brain, 12 by the administration to the secret brain; some used, some withdrawn.
    for (let i = 0; i < 30; i++)
      await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
        emails: [`a${i}@example.com`],
        brains: [{ slug: 'yt', role: 'reader' }],
      })
    for (let i = 0; i < 12; i++)
      await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
        emails: [`s${i}@example.com`],
        brains: [{ slug: 'secret', role: 'curator' }],
      })
    await w.db.query(`UPDATE invitations SET used_at = now() WHERE email LIKE 'a1%'`)
    await w.db.query(
      `UPDATE invitations SET revoked_at = now() WHERE email IN ('a2@example.com', 's3@example.com')`,
    )
    // Expired by the server's clock (the test clock), not the database's.
    await w.db.query(
      `UPDATE invitations SET expires_at = $1::timestamptz - interval '1 day' WHERE email = 'a4@example.com'`,
      [w.clock()],
    )
  })
  after(async () => w.close())

  it('pages with a cursor: every invitation once, newest first, and the last page says so', async () => {
    const got = await all(adminWeb)
    assert.equal(got.length, 42)
    assert.equal(new Set(got.map((i) => i.id)).size, 42)
    const first = await get(adminWeb, '?limit=7')
    assert.ok(first.next)
    assert.equal(first.invitations.length, 7)
  })

  it('without a limit, a page of 50 at most', async () => {
    const p = await get(adminWeb)
    assert.equal(p.invitations.length, 42)
    assert.equal(p.next, null)
  })

  it('the status is filtered on the server, across pages', async () => {
    const used = await all(adminWeb, '&status=used')
    // a1 and a10–a19.
    assert.equal(used.length, 11)
    assert.ok(used.every((i) => i.status === 'used'))
    assert.deepEqual((await all(adminWeb, '&status=revoked')).map((i) => i.email).sort(), [
      'a2@example.com',
      's3@example.com',
    ])
    assert.deepEqual(
      (await all(adminWeb, '&status=expired')).map((i) => i.email),
      ['a4@example.com'],
    )
    assert.equal((await all(adminWeb, '&status=pending')).length, 42 - 11 - 2 - 1)
    const bad = await w.callWeb(adminWeb, 'GET', '/v1/invitations?status=lost')
    assert.equal(bad.status, 400)
  })

  it('a curator sees only the ones she could still make, and pages count only those', async () => {
    const mine = await all(anaWeb)
    assert.equal(mine.length, 30)
    assert.ok(mine.every((i) => i.brains.every((b) => b.slug === 'yt')))
    // Ana is no longer a curator of yt: none of hers are in reach.
    await w.db.query(
      `UPDATE memberships SET role = 'contributor' WHERE account_id = $1 AND brain_id = (SELECT id FROM brains WHERE slug = 'yt')`,
      [ana.id],
    )
    try {
      assert.equal((await get(anaWeb)).invitations.length, 0)
    } finally {
      await w.db.query(
        `UPDATE memberships SET role = 'curator' WHERE account_id = $1 AND brain_id = (SELECT id FROM brains WHERE slug = 'yt')`,
        [ana.id],
      )
    }
  })

  it('a page of 50 is read in a fixed number of queries, not one or two per invitation', async () => {
    const count = async (limit: number) => {
      const q = w.db.query.bind(w.db)
      const one = w.db.one.bind(w.db)
      let n = 0
      w.db.query = (async (...a: Parameters<typeof q>) => {
        n += 1
        return q(...a)
      }) as typeof w.db.query
      w.db.one = (async (...a: Parameters<typeof one>) => {
        n += 1
        return one(...a)
      }) as typeof w.db.one
      try {
        await get(adminWeb, `?limit=${limit}`)
      } finally {
        w.db.query = q
        w.db.one = one
      }
      return n
    }
    const small = await count(2)
    const big = await count(40)
    assert.equal(big, small, `queries for 2 rows: ${small}; for 40 rows: ${big}`)
    // The session, the reach and one read of the page with its brains: a handful, never one per row.
    assert.ok(big <= 8, `${big} queries for a page of 40`)
  })

  it('a cursor that is not one is refused', async () => {
    assert.equal((await w.callWeb(adminWeb, 'GET', '/v1/invitations?cursor=nope')).status, 400)
  })
})
