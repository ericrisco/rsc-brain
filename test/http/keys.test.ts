import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('keys over HTTP', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string; email: string }
  let ana: { id: string; key: string; email: string }
  let factory: { id: string; key: string }
  const emailOf = async (id: string) =>
    (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [id]))?.email as string

  before(async () => {
    w = await world()
    const e = await w.person('Eric', { isAdmin: true })
    eric = { ...e, email: await emailOf(e.id) }
    const a = await w.person('Ana')
    ana = { ...a, email: await emailOf(a.id) }
    factory = await w.service('RSC Factory')
    for (const slug of ['project', 'company', 'sales']) {
      await w.call(eric.key, 'POST', '/v1/brains', { slug })
    }
    await w.member('project', factory.id, 'contributor')
    await w.member('company', factory.id, 'reader')
    await w.member('company', ana.id, 'reader')
  })
  after(async () => w.close())

  const mint = (body: Record<string, unknown>, key = factory.key) =>
    w.call(key, 'POST', '/v1/keys/short', body)

  it('CA16: a short key writes its brain, reads its read brains, nothing else, until it expires', async () => {
    const r = await mint({
      writeBrain: 'project',
      readBrains: ['company'],
      ref: 'run r_x, step 3',
      agent: 'narrator',
      onBehalf: eric.email,
      ttlMinutes: 60,
    })
    assert.equal(r.status, 201)
    const k = (r.body.key as { secret: string }).secret
    const me = await w.call(k, 'GET', '/v1/me')
    assert.deepEqual(me.body.key, {
      id: (r.body.key as { id: string }).id,
      kind: 'short',
      perm: 'write',
      ref: 'run r_x, step 3',
      agent: 'narrator',
    })
    const brains = await w.call(k, 'GET', '/v1/brains')
    assert.deepEqual(
      (brains.body.brains as { slug: string; role: string }[]).map((b) => [b.slug, b.role]),
      [
        ['company', 'reader'],
        ['project', 'contributor'],
      ],
    )
    assert.equal((await w.call(k, 'GET', '/v1/brains/sales')).status, 404)
    w.advance(61 * 60_000)
    const late = await w.call(k, 'GET', '/v1/brains/project')
    assert.equal(late.status, 401)
    assert.equal(late.body.error?.code, 'key_expired')
  })

  it('CA20b: a read-only brain is read only while the person it speaks for can read it', async () => {
    const forAna = await mint({
      writeBrain: 'project',
      readBrains: ['company'],
      ref: 'run r_y',
      onBehalf: ana.email,
      ttlMinutes: 10,
    })
    const k = (forAna.body.key as { secret: string }).secret
    assert.equal((await w.call(k, 'GET', '/v1/brains/company')).status, 200)
    await w.db.query(
      "DELETE FROM memberships WHERE account_id = $1 AND brain_id = (SELECT id FROM brains WHERE slug = 'company')",
      [ana.id],
    )
    assert.equal((await w.call(k, 'GET', '/v1/brains/company')).status, 404)
  })

  it('CA20c: no short key on behalf of an invented account, nor read brains without onBehalf', async () => {
    const invented = await mint({
      writeBrain: 'project',
      ref: 'x',
      onBehalf: 'ghost@example.com',
      ttlMinutes: 5,
    })
    assert.equal(invented.status, 400)
    const missing = await mint({ writeBrain: 'project', readBrains: ['company'], ref: 'x', ttlMinutes: 5 })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error?.howToProceed ?? '', /onBehalf/)
  })

  it('CA17: a short key is never wider than the service account', async () => {
    const r = await mint({ writeBrain: 'company', ref: 'x', ttlMinutes: 5 })
    assert.equal(r.status, 403)
    assert.match(r.body.error?.message ?? '', /reader/)
    const notMember = await mint({ writeBrain: 'sales', ref: 'x', ttlMinutes: 5 })
    assert.equal(notMember.status, 404)
    const tooLong = await mint({ writeBrain: 'project', ref: 'x', ttlMinutes: 24 * 60 + 1 })
    assert.equal(tooLong.status, 400)
  })

  it('only a service main key mints short keys', async () => {
    assert.equal((await mint({ writeBrain: 'project', ref: 'x', ttlMinutes: 5 }, eric.key)).status, 403)
    const k = (
      (await mint({ writeBrain: 'project', ref: 'x', ttlMinutes: 5 })).body.key as { secret: string }
    ).secret
    assert.equal((await mint({ writeBrain: 'project', ref: 'y', ttlMinutes: 5 }, k)).status, 403)
  })

  it('CA26 and CA18: revoke one short key alone; revoking the main key revokes all it minted', async () => {
    const k1 = (await mint({ writeBrain: 'project', ref: 'a', ttlMinutes: 30 })).body.key as {
      id: string
      secret: string
    }
    const k2 = (await mint({ writeBrain: 'project', ref: 'b', ttlMinutes: 30 })).body.key as {
      id: string
      secret: string
    }
    assert.equal((await w.call(factory.key, 'DELETE', `/v1/keys/${k1.id}`)).status, 200)
    const gone = await w.call(k1.secret, 'GET', '/v1/me')
    assert.equal(gone.body.error?.code, 'key_revoked')
    assert.equal((await w.call(k2.secret, 'GET', '/v1/me')).status, 200)
    const main = await w.db.one<{ id: string }>(
      "SELECT id FROM credentials WHERE account_id = $1 AND kind = 'main'",
      [factory.id],
    )
    assert.equal((await w.call(eric.key, 'DELETE', `/v1/keys/${main?.id}`)).status, 200)
    assert.equal((await w.call(k2.secret, 'GET', '/v1/me')).body.error?.code, 'key_revoked')
    assert.equal((await w.call(factory.key, 'GET', '/v1/me')).body.error?.code, 'key_revoked')
  })

  it('someone else cannot revoke my key, and is told it does not exist', async () => {
    const t = await w.db.one<{ id: string }>(
      "SELECT id FROM credentials WHERE account_id = $1 AND kind = 'token'",
      [eric.id],
    )
    const r = await w.call(ana.key, 'DELETE', `/v1/keys/${t?.id}`)
    assert.equal(r.status, 404)
  })

  it('a removed account stops working at the next request', async () => {
    const bob = await w.person('Bob')
    assert.equal((await w.call(bob.key, 'GET', '/v1/me')).status, 200)
    await w.db.query("UPDATE accounts SET status = 'removed' WHERE id = $1", [bob.id])
    assert.equal((await w.call(bob.key, 'GET', '/v1/me')).body.error?.code, 'account_removed')
  })

  it('a token past its days is refused', async () => {
    const t = await w.token(eric.id, { days: 1 })
    w.advance(86_400_000 + 1)
    assert.equal((await w.call(t, 'GET', '/v1/me')).body.error?.code, 'key_expired')
  })

  it('keys are stored only as hashes', async () => {
    const rows = await w.db.query<{ secret_hash: string; last4: string }>(
      'SELECT secret_hash, last4 FROM credentials',
    )
    for (const r of rows) {
      assert.match(r.secret_hash, /^[0-9a-f]{64}$/)
      assert.equal(r.last4.length, 4)
    }
    const dump = JSON.stringify(await w.db.query('SELECT * FROM credentials'))
    assert.ok(!dump.includes(eric.key))
  })

  it('a short key revokes only itself, never its main key or a sibling', async () => {
    const svc = await w.service('Isolated')
    await w.member('project', svc.id, 'contributor')
    const a = (await mint({ writeBrain: 'project', ref: 'a', ttlMinutes: 30 }, svc.key)).body.key as {
      id: string
      secret: string
    }
    const b = (await mint({ writeBrain: 'project', ref: 'b', ttlMinutes: 30 }, svc.key)).body.key as {
      id: string
      secret: string
    }
    const main = await w.db.one<{ id: string }>(
      "SELECT id FROM credentials WHERE account_id = $1 AND kind = 'main'",
      [svc.id],
    )
    assert.equal((await w.call(a.secret, 'DELETE', `/v1/keys/${main?.id}`)).status, 404)
    assert.equal((await w.call(a.secret, 'DELETE', `/v1/keys/${b.id}`)).status, 404)
    assert.equal((await w.call(svc.key, 'GET', '/v1/me')).status, 200)
    assert.equal((await w.call(b.secret, 'GET', '/v1/me')).status, 200)
    assert.equal((await w.call(a.secret, 'DELETE', `/v1/keys/${a.id}`)).status, 200)
    assert.equal((await w.call(a.secret, 'GET', '/v1/me')).body.error?.code, 'key_revoked')
  })
})
