// B6 PR25a: what the web's brain settings and the administration of people and service accounts read
// from v1. G11: the settings of a brain's wiki, with their defaults and a revision, so two curators
// editing at once do not overwrite each other. The administration's list of people names each one's
// role in each brain; a main key says which references its live short keys carry.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DEFAULT_GUIDE } from '../../src/domain/wiki/pages.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('brain settings and the administration (PR25a)', { skip: skipPg }, () => {
  let w: World
  let cura: { id: string; key: string }
  let rita: { id: string; key: string }
  let out: { id: string; key: string }
  let admin: { id: string; key: string }
  let curaWeb: string
  let adminWeb: string

  before(async () => {
    w = await world()
    cura = await w.person('Cura')
    rita = await w.person('Rita')
    out = await w.person('Outsider')
    admin = await w.person('Admin', { isAdmin: true })
    curaWeb = await w.web(cura.id)
    adminWeb = await w.web(admin.id)
    await w.call(cura.key, 'POST', '/v1/brains', { slug: 'set', name: 'Settings', purpose: 'Settings.' })
    await w.member('set', rita.id, 'reader')
  })
  after(async () => w.close())

  describe('G11: GET /v1/brains/{slug}/wiki/settings', () => {
    it('gives the settings with the default texts and a revision', async () => {
      const r = await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.guide, DEFAULT_GUIDE)
      assert.equal(r.body.guideDefault, DEFAULT_GUIDE)
      assert.equal(r.body.customGuide, false)
      assert.equal(r.body.usageNote, '')
      assert.equal(r.body.usageNoteDefault, '')
      assert.equal(r.body.meaningExcluded, false)
      assert.deepEqual([r.body.staleDays, r.body.longChars, r.body.maintenanceEvery], [90, 20000, 20])
      assert.match(String(r.body.revision), /^[0-9a-f]{16,}$/)
    })

    it('any member reads them (the guide is already theirs to read); a stranger gets the 404 of a missing brain', async () => {
      assert.equal((await w.call(rita.key, 'GET', '/v1/brains/set/wiki/settings')).status, 200)
      const stranger = await w.call(out.key, 'GET', '/v1/brains/set/wiki/settings')
      const missing = await w.call(out.key, 'GET', '/v1/brains/nowhere/wiki/settings')
      assert.deepEqual([stranger.status, stranger.body.error?.code], [404, 'brain_not_found'])
      assert.deepEqual(stranger.body, missing.body)
    })

    it('a save on the revision read moves it on; a save on an older one is refused and changes nothing', async () => {
      const first = await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')
      const rev = String(first.body.revision)
      const saved = await w.callWeb(curaWeb, 'PUT', '/v1/brains/set/wiki/settings', {
        guide: 'Our guide.',
        revision: rev,
      })
      assert.equal(saved.status, 200, saved.text)
      assert.equal(saved.body.guide, 'Our guide.')
      assert.equal(saved.body.customGuide, true)
      assert.equal(saved.body.guideDefault, DEFAULT_GUIDE)
      assert.notEqual(saved.body.revision, rev)
      // The second curator saves on what they read before.
      const late = await w.callWeb(curaWeb, 'PUT', '/v1/brains/set/wiki/settings', {
        usageNote: 'Late note.',
        revision: rev,
      })
      assert.deepEqual([late.status, late.body.error?.code], [409, 'settings_changed'])
      assert.match(String(late.body.error?.howToProceed), /again/i)
      const now = await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')
      assert.equal(now.body.usageNote, '')
      assert.equal(now.body.revision, saved.body.revision)
      // Without a revision, a program saves as before.
      const plain = await w.callWeb(curaWeb, 'PUT', '/v1/brains/set/wiki/settings', { staleDays: 30 })
      assert.equal(plain.status, 200, plain.text)
      // Back to the default text.
      const reset = await w.callWeb(curaWeb, 'PUT', '/v1/brains/set/wiki/settings', {
        guide: null,
        revision: plain.body.revision,
      })
      assert.equal(reset.status, 200, reset.text)
      assert.equal(reset.body.guide, DEFAULT_GUIDE)
      assert.equal(reset.body.customGuide, false)
    })

    it('a revision that is not text is refused as a bad request', async () => {
      const r = await w.callWeb(curaWeb, 'PUT', '/v1/brains/set/wiki/settings', {
        staleDays: 31,
        revision: 7,
      })
      assert.deepEqual([r.status, r.body.error?.code], [400, 'invalid_request'])
    })

    it('approvals counting and asking for maintenance do not move the revision (not settings a person edits)', async () => {
      const before = String((await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')).body.revision)
      // Approvals count by themselves; asking for maintenance starts the count again.
      await w.db.query(
        "UPDATE wiki_settings SET approvals_since = 7 WHERE brain_id = (SELECT id FROM brains WHERE slug = 'set')",
      )
      const counted = String((await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')).body.revision)
      assert.equal(counted, before)
      await w.callWeb(curaWeb, 'POST', '/v1/brains/set/wiki/maintenance-asked')
      const after = String((await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')).body.revision)
      assert.equal(after, before)
    })
  })

  describe('the administration', () => {
    it('lists each person with their role in each brain', async () => {
      const r = await w.callWeb(adminWeb, 'GET', '/v1/admin/accounts')
      assert.equal(r.status, 200, r.text)
      const accounts = r.body.accounts as Json[]
      const c = accounts.find((a) => a.id === cura.id) as Json
      assert.deepEqual(c.roles, [{ slug: 'set', name: 'Settings', role: 'curator' }])
      const x = accounts.find((a) => a.id === out.id) as Json
      assert.deepEqual(x.roles, [])
    })

    it('a main key says how many short keys are live and which references they carry; ended ones do not count', async () => {
      const svc = await w.service('Runner')
      await w.member('set', svc.id, 'contributor')
      const mint = (ref: string, ttlMinutes = 30) =>
        w.call(svc.key, 'POST', '/v1/keys/short', { writeBrain: 'set', perm: 'write', ref, ttlMinutes })
      await mint('run r_one, step 1')
      await mint('run r_one, step 1')
      await mint('run r_two')
      const gone = await mint('run r_gone')
      await w.call(svc.key, 'DELETE', `/v1/keys/${(gone.body.key as Json).id}`)
      await mint('run r_old', 1)
      w.advance(2 * 60_000)
      const keys = await w.callWeb(adminWeb, 'GET', `/v1/admin/accounts/${svc.id}/keys`)
      assert.equal(keys.status, 200, keys.text)
      const main = (keys.body.keys as Json[]).find((k) => k.kind === 'main') as Json
      assert.equal(main.liveShortKeys, 3)
      assert.deepEqual(main.liveShortRefs, ['run r_one, step 1', 'run r_two'])
      // Never a secret in what the administration reads.
      assert.ok(!/rscb_/.test(keys.text))
    })
  })
})
