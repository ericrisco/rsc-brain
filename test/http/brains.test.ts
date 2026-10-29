import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('brains over HTTP', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    ana = await w.person('Ana', { canCreateBrains: false })
  })
  after(async () => w.close())

  it('health answers without a key', async () => {
    const r = await w.call(null, 'GET', '/v1/health')
    assert.equal(r.status, 200)
  })

  it('a request without a key, or with an unknown one, is refused with the way out', async () => {
    for (const key of [null, 'rscb_unknownunknownunknownunknownunknownunknow1']) {
      const r = await w.call(key, 'GET', '/v1/brains')
      assert.equal(r.status, 401)
      assert.equal(r.body.error?.code, 'unauthorized')
      assert.match(r.body.error?.howToProceed ?? '', /Bearer/)
    }
  })

  it('a person creates a brain and becomes its curator', async () => {
    const r = await w.call(eric.key, 'POST', '/v1/brains', {
      slug: 'youtube-channel',
      name: 'YouTube channel',
      purpose: 'What we learn making videos.',
    })
    assert.equal(r.status, 201)
    const list = await w.call(eric.key, 'GET', '/v1/brains')
    const brains = list.body.brains as { slug: string; role: string }[]
    assert.deepEqual(
      brains.map((b) => [b.slug, b.role]),
      [['youtube-channel', 'curator']],
    )
  })

  it('names are checked and unique', async () => {
    const bad = await w.call(eric.key, 'POST', '/v1/brains', { slug: 'Not A Slug' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error?.howToProceed ?? '', /youtube-channel/)
    const dup = await w.call(eric.key, 'POST', '/v1/brains', { slug: 'youtube-channel' })
    assert.equal(dup.status, 409)
  })

  it('creating needs the permission', async () => {
    const r = await w.call(ana.key, 'POST', '/v1/brains', { slug: 'anas' })
    assert.equal(r.status, 403)
    assert.match(r.body.error?.howToProceed ?? '', /administration/)
  })

  it('CA19: a brain I am not in answers exactly like one that does not exist', async () => {
    const hidden = await w.call(ana.key, 'GET', '/v1/brains/youtube-channel')
    const missing = await w.call(ana.key, 'GET', '/v1/brains/no-such-brain')
    assert.equal(hidden.status, 404)
    assert.equal(hidden.text, missing.text)
    const hiddenArchive = await w.call(ana.key, 'POST', '/v1/brains/youtube-channel/archive')
    const missingArchive = await w.call(ana.key, 'POST', '/v1/brains/no-such-brain/archive')
    assert.equal(hiddenArchive.text, missingArchive.text)
  })

  it('a reader reads but cannot archive', async () => {
    await w.member('youtube-channel', ana.id, 'reader')
    assert.equal((await w.call(ana.key, 'GET', '/v1/brains/youtube-channel')).status, 200)
    const r = await w.call(ana.key, 'POST', '/v1/brains/youtube-channel/archive')
    assert.equal(r.status, 403)
    assert.match(r.body.error?.message ?? '', /curator/)
  })

  it('CA18: a curator archives and unarchives; archived brains stay readable', async () => {
    const a = await w.call(eric.key, 'POST', '/v1/brains/youtube-channel/archive')
    assert.equal((a.body.brain as { status: string }).status, 'archived')
    assert.equal((await w.call(ana.key, 'GET', '/v1/brains/youtube-channel')).status, 200)
    const u = await w.call(eric.key, 'POST', '/v1/brains/youtube-channel/unarchive')
    assert.equal((u.body.brain as { status: string }).status, 'active')
  })

  it('a token limited to some brains does not see the others', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'company' })
    const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'company'")
    const narrow = await w.token(eric.id, { brainIds: [b?.id as string] })
    const list = await w.call(narrow, 'GET', '/v1/brains')
    assert.deepEqual(
      (list.body.brains as { slug: string }[]).map((x) => x.slug),
      ['company'],
    )
    assert.equal((await w.call(narrow, 'GET', '/v1/brains/youtube-channel')).status, 404)
  })

  it('a read-only token cannot change anything', async () => {
    const ro = await w.token(eric.id, { perm: 'read' })
    assert.equal((await w.call(ro, 'GET', '/v1/brains/company')).status, 200)
    const r = await w.call(ro, 'POST', '/v1/brains/company/archive')
    assert.equal(r.status, 403)
    assert.match(r.body.error?.message ?? '', /read-only/)
  })

  it('only the administration deletes, typing the name', async () => {
    await w.member('company', ana.id, 'curator')
    assert.equal((await w.call(ana.key, 'DELETE', '/v1/brains/company', { confirm: 'company' })).status, 403)
    const noConfirm = await w.call(eric.key, 'DELETE', '/v1/brains/company', {})
    assert.equal(noConfirm.status, 400)
    assert.match(noConfirm.body.error?.howToProceed ?? '', /"confirm": "company"/)
    assert.equal((await w.call(eric.key, 'DELETE', '/v1/brains/company', { confirm: 'company' })).status, 200)
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/company')).status, 404)
    const trail = await w.db.query("SELECT action, outcome FROM audit WHERE target = 'company' ORDER BY id")
    assert.ok(trail.some((r) => r.action === 'brain.delete' && r.outcome === 'ok'))
  })

  it('a service account must name an active person as first curator', async () => {
    const factory = await w.service('RSC Factory')
    const none = await w.call(factory.key, 'POST', '/v1/brains', { slug: 'proj-a' })
    assert.equal(none.status, 400)
    const unknown = await w.call(factory.key, 'POST', '/v1/brains', {
      slug: 'proj-a',
      firstCurator: 'nobody@example.com',
    })
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error?.howToProceed ?? '', /may not invite/)
    const okr = await w.call(factory.key, 'POST', '/v1/brains', {
      slug: 'proj-a',
      firstCurator: (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [eric.id]))
        ?.email,
    })
    assert.equal(okr.status, 201)
    const roles = await w.db.query(
      "SELECT account_id, role FROM memberships m JOIN brains b ON b.id = m.brain_id WHERE b.slug = 'proj-a' ORDER BY role",
    )
    const got = new Set(roles.map((r) => `${r.account_id}:${r.role}`))
    assert.deepEqual(got, new Set([`${factory.id}:contributor`, `${eric.id}:curator`]))
  })

  it('a service that may invite leaves a pending curator', async () => {
    const svc = await w.service('Inviter', { canInvite: true })
    const r = await w.call(svc.key, 'POST', '/v1/brains', { slug: 'proj-b', firstCurator: 'New@Example.com' })
    assert.equal(r.status, 201)
    assert.equal((r.body.brain as { pendingCuratorEmail: string }).pendingCuratorEmail, 'new@example.com')
  })

  it('bad JSON and unknown routes say so', async () => {
    const r = await w.call(eric.key, 'POST', '/v1/brains', '{nope')
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'invalid_request')
    assert.equal((await w.call(eric.key, 'GET', '/v1/nothing')).status, 404)
    assert.equal((await w.call(eric.key, 'PUT', '/v1/brains')).status, 405)
  })

  it('concurrent archive and unarchive queue instead of deadlocking', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'race' })
    const calls = Array.from({ length: 20 }, (_, i) =>
      w.call(eric.key, 'POST', `/v1/brains/race/${i % 2 ? 'archive' : 'unarchive'}`),
    )
    const statuses = (await Promise.all(calls)).map((r) => r.status)
    assert.deepEqual([...new Set(statuses)], [200])
  })

  it('a refused archive is in the audit', async () => {
    await w.member('race', ana.id, 'reader')
    assert.equal((await w.call(ana.key, 'POST', '/v1/brains/race/archive')).status, 403)
    const rows = await w.db.query(
      `SELECT action FROM audit WHERE actor_id = $1 AND outcome = 'denied' AND action = 'brain.archive'
         AND brain_id = (SELECT id FROM brains WHERE slug = 'race')`,
      [ana.id],
    )
    assert.equal(rows.length, 1)
  })

  it('a service account is never curator, even if its membership row says so', async () => {
    const svc = await w.service('Bot')
    await assert.rejects(() => w.member('race', svc.id, 'curator'), /never a curator/)
    await w.db.query(
      "INSERT INTO memberships (brain_id, account_id, role, created_at) SELECT id, $1, 'curator', now() FROM brains WHERE slug = 'race'",
      [svc.id],
    )
    const got = await w.call(svc.key, 'GET', '/v1/brains/race')
    assert.equal((got.body.brain as { role: string }).role, 'contributor')
    assert.equal((await w.call(svc.key, 'POST', '/v1/brains/race/archive')).status, 403)
  })

  it('deleting a brain revokes its short keys instead of erasing them', async () => {
    const svc = await w.service('Runner')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'doomed' })
    await w.member('doomed', svc.id, 'contributor')
    const k = (
      await w.call(svc.key, 'POST', '/v1/keys/short', { writeBrain: 'doomed', ref: 'r', ttlMinutes: 30 })
    ).body.key as { id: string; secret: string }
    assert.equal((await w.call(eric.key, 'DELETE', '/v1/brains/doomed', { confirm: 'doomed' })).status, 200)
    assert.equal((await w.call(k.secret, 'GET', '/v1/me')).body.error?.code, 'key_revoked')
  })
})
