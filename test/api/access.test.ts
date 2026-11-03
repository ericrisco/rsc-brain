// POST /v1/access (plan rsc-factory-brain §3.1, spec C21, CA21b, CA21c): a service account asks, with its
// main key, which role a person has in brains the service belongs to, without minting a key to find out.
// A brain the service is not in answers as if it did not exist (constitution P4): it is left out.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('POST /v1/access', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string; email: string }
  let ana: { id: string; key: string; email: string }
  let gone: { id: string; key: string; email: string }
  let factory: { id: string; key: string }
  const emailOf = async (id: string) =>
    (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [id]))?.email as string
  const ask = (body: unknown, key = factory.key) => w.call(key, 'POST', '/v1/access', body)

  before(async () => {
    w = await world()
    const e = await w.person('Eric', { isAdmin: true })
    eric = { ...e, email: await emailOf(e.id) }
    const a = await w.person('Ana')
    ana = { ...a, email: await emailOf(a.id) }
    const g = await w.person('Gone')
    gone = { ...g, email: await emailOf(g.id) }
    factory = await w.service('rsc-factory')
    for (const slug of ['project', 'company', 'sales', 'secret']) {
      await w.call(eric.key, 'POST', '/v1/brains', { slug })
    }
    await w.member('project', factory.id, 'contributor')
    await w.member('company', factory.id, 'reader')
    await w.member('sales', factory.id, 'contributor')
    await w.member('company', ana.id, 'reader')
    await w.member('project', ana.id, 'curator')
    await w.member('project', gone.id, 'contributor')
    await w.db.query("UPDATE accounts SET status = 'removed' WHERE id = $1", [gone.id])
  })
  after(async () => w.close())

  it('C21: the role of the person in each brain the service is in, in the order asked', async () => {
    const r = await ask({ person: ana.email, brains: ['sales', 'company', 'project'] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body, {
      person: { found: true },
      brains: [
        { slug: 'sales', serviceRole: 'contributor', personRole: null },
        { slug: 'company', serviceRole: 'reader', personRole: 'reader' },
        { slug: 'project', serviceRole: 'contributor', personRole: 'curator' },
      ],
    })
  })

  it('P4: a brain the service is not in, or one that does not exist, is left out like a missing one', async () => {
    const r = await ask({ person: eric.email, brains: ['secret', 'nowhere', 'project', 'project'] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.brains, [{ slug: 'project', serviceRole: 'contributor', personRole: 'curator' }])
  })

  it('the person by account id, or by email in any case', async () => {
    const byId = await ask({ person: ana.id, brains: ['project'] })
    assert.deepEqual((byId.body.brains as Json[])[0]?.personRole, 'curator')
    const upper = await ask({ person: `  ${ana.email.toUpperCase()} `, brains: ['project'] })
    assert.deepEqual(upper.body.person, { found: true })
    assert.deepEqual((upper.body.brains as Json[])[0]?.personRole, 'curator')
  })

  it('a person without an account, or removed, is not found and has no role anywhere', async () => {
    for (const person of ['nobody@example.com', gone.email, gone.id, factory.id]) {
      const r = await ask({ person, brains: ['project', 'company'] })
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.body, {
        person: { found: false },
        brains: [
          { slug: 'project', serviceRole: 'contributor', personRole: null },
          { slug: 'company', serviceRole: 'reader', personRole: null },
        ],
      })
    }
  })

  it('only the main key of a service account: any other key is refused with key_not_allowed', async () => {
    const short = await w.call(factory.key, 'POST', '/v1/keys/short', {
      writeBrain: 'project',
      ref: 'run r_0000aaaa step 1',
      ttlMinutes: 10,
    })
    const shortKey = String((short.body.key as Json).secret)
    const adminWeb = await w.web(eric.id)
    const refused = [
      await ask({ person: ana.email, brains: ['project'] }, eric.key),
      await ask({ person: ana.email, brains: ['project'] }, shortKey),
      await w.callWeb(adminWeb, 'POST', '/v1/access', { person: ana.email, brains: ['project'] }),
    ]
    for (const r of refused) {
      assert.equal(r.status, 403, r.text)
      assert.equal(r.body.error?.code, 'key_not_allowed')
      assert.ok(r.body.error?.howToProceed, 'it says how to proceed')
    }
    assert.equal((await ask({ person: ana.email, brains: ['project'] }, '')).status, 401)
  })

  it('a malformed request says what to fix', async () => {
    const bad: unknown[] = [
      { brains: ['project'] },
      { person: '', brains: ['project'] },
      { person: ana.email },
      { person: ana.email, brains: [] },
      { person: ana.email, brains: 'project' },
      { person: ana.email, brains: [1] },
      { person: ana.email, brains: Array.from({ length: 51 }, (_, i) => `b${i}`) },
      { person: 'x'.repeat(201), brains: ['project'] },
    ]
    for (const body of bad) {
      const r = await ask(body)
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)}: ${r.text}`)
      assert.equal(r.body.error?.code, 'invalid_request')
    }
    assert.equal(
      (await ask({ person: ana.email, brains: Array.from({ length: 50 }, () => 'x') })).status,
      200,
    )
  })

  it('audited as access.check with the person and the count, never a brain out of reach', async () => {
    const mark = await w.db.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM audit')
    await ask({ person: ana.email, brains: ['project', 'secret', 'company'] })
    const rows = await w.db.query(
      "SELECT actor_id, credential_id, brain_id, target, outcome, detail FROM audit WHERE action = 'access.check' AND id > $1",
      [mark?.id],
    )
    assert.equal(rows.length, 1)
    const row = rows[0] as Json
    assert.equal(row.actor_id, factory.id)
    assert.equal(row.outcome, 'ok')
    assert.equal(row.brain_id, null)
    assert.equal(row.target, ana.id)
    assert.match(String(row.detail), /\b2 brains\b/)
    const secret = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'secret'")
    assert.ok(!JSON.stringify(rows).includes('secret') && !JSON.stringify(rows).includes(String(secret?.id)))
  })
})
