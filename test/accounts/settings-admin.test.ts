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
    it('gives the settings with the default texts', async () => {
      const r = await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.guide, DEFAULT_GUIDE)
      assert.equal(r.body.guideDefault, DEFAULT_GUIDE)
      assert.equal(r.body.customGuide, false)
      assert.equal(r.body.usageNote, '')
      assert.equal(r.body.usageNoteDefault, '')
      assert.equal(r.body.meaningExcluded, false)
      assert.deepEqual([r.body.staleDays, r.body.longChars, r.body.maintenanceEvery], [90, 20000, 20])
    })

    it('any member reads them (the guide is already theirs to read); a stranger gets the 404 of a missing brain', async () => {
      assert.equal((await w.call(rita.key, 'GET', '/v1/brains/set/wiki/settings')).status, 200)
      const stranger = await w.call(out.key, 'GET', '/v1/brains/set/wiki/settings')
      const missing = await w.call(out.key, 'GET', '/v1/brains/nowhere/wiki/settings')
      assert.deepEqual([stranger.status, stranger.body.error?.code], [404, 'brain_not_found'])
      assert.deepEqual(stranger.body, missing.body)
    })
  })

  describe('a save checks each field it changes against the value it was based on (fix of PR25a)', () => {
    const put = (body: Json) => w.callWeb(curaWeb, 'PUT', '/v1/brains/set/wiki/settings', body)
    const read = async () => (await w.callWeb(curaWeb, 'GET', '/v1/brains/set/wiki/settings')).body

    it('saves on different fields never touch each other, whatever each one read', async () => {
      const note = await put({ usageNote: 'Name the ticket.', base: { usageNote: '' } })
      assert.equal(note.status, 200, note.text)
      // The other curator read the thresholds before the note was saved: their save goes on, the note stays.
      const days = await put({ staleDays: 45, base: { staleDays: 90 } })
      assert.equal(days.status, 200, days.text)
      const now = await read()
      assert.deepEqual([now.usageNote, now.staleDays], ['Name the ticket.', 45])
    })

    it('a save of a field someone changed since it was read is refused, says what is there now, and changes nothing', async () => {
      const late = await put({
        usageNote: 'Late note.',
        staleDays: 50,
        base: { usageNote: '', staleDays: 45 },
      })
      assert.deepEqual([late.status, late.body.error?.code], [409, 'settings_changed'])
      const current = (late.body.error as Json).current as Json
      assert.equal(current.usageNote, 'Name the ticket.')
      assert.match(String(late.body.error?.howToProceed), /again/i)
      const now = await read()
      assert.deepEqual([now.usageNote, now.staleDays], ['Name the ticket.', 45])
    })

    it('the guide is compared as stored: null while it is the default', async () => {
      const g = await put({ guide: 'Our guide.', base: { guide: null } })
      assert.equal(g.status, 200, g.text)
      assert.equal(g.body.customGuide, true)
      const stale = await put({ guide: 'Another.', base: { guide: null } })
      assert.equal(stale.body.error?.code, 'settings_changed')
      // The default text itself is stored as the default (null), never as a copy of it.
      const same = await put({ guide: `  ${DEFAULT_GUIDE}\n`, base: { guide: 'Our guide.' } })
      assert.equal(same.status, 200, same.text)
      assert.equal(same.body.customGuide, false)
      const back = await put({ guide: 'Third.', base: { guide: null } })
      assert.equal(back.status, 200, back.text)
      await put({ guide: null })
    })

    it('without a base a program saves as before; a base that is not an object of known fields is refused', async () => {
      assert.equal((await put({ longChars: 30000 })).status, 200)
      for (const base of [7, { nope: 1 }, ['staleDays']]) {
        const r = await put({ staleDays: 46, base })
        assert.deepEqual([r.status, r.body.error?.code], [400, 'invalid_request'], JSON.stringify(base))
      }
    })

    it('eight curators saving the same field on the same value at once: exactly one wins', async () => {
      // A brain of their own, so the other tests keep their members.
      await w.call(cura.key, 'POST', '/v1/brains', { slug: 'race' })
      // Its settings exist already (a first save makes them), as in a brain that has been used.
      await w.callWeb(curaWeb, 'PUT', '/v1/brains/race/wiki/settings', { staleDays: 91 })
      const at = 20
      // Eight curators, each signed in with their own session (one shared session makes the requests take
      // turns before they reach the brain, and the race would never happen).
      const webs: string[] = []
      for (let n = 0; n < 8; n++) {
        const c = await w.person(`Racer${n}`)
        await w.member('race', c.id, 'curator')
        webs.push(await w.web(c.id))
      }
      const all = await Promise.all(
        webs.map((web, n) =>
          w.callWeb(web, 'PUT', '/v1/brains/race/wiki/settings', {
            maintenanceEvery: 100 + n,
            base: { maintenanceEvery: at },
          }),
        ),
      )
      assert.deepEqual(
        all.map((r) => r.status).sort(),
        [200, 409, 409, 409, 409, 409, 409, 409],
        all.map((r) => r.text).join('\n'),
      )
    })

    it('approvals counting by themselves never conflict with a save', async () => {
      await w.db.query(
        "UPDATE wiki_settings SET approvals_since = 7 WHERE brain_id = (SELECT id FROM brains WHERE slug = 'set')",
      )
      const r = await put({ staleDays: 47, base: { staleDays: Number((await read()).staleDays) } })
      assert.equal(r.status, 200, r.text)
    })
  })

  describe('members, deleting, invitations and repositories (fix of PR25a)', () => {
    it('adding someone who is already a member is refused: their role changes only through the role', async () => {
      const r = await w.callWeb(curaWeb, 'POST', '/v1/brains/set/members', {
        account: rita.id,
        role: 'curator',
      })
      assert.deepEqual([r.status, r.body.error?.code], [409, 'already_member'])
      assert.match(String(r.body.error?.message), /Rita is already a reader/)
      const self = await w.callWeb(curaWeb, 'POST', '/v1/brains/set/members', {
        account: cura.id,
        role: 'reader',
      })
      assert.deepEqual([self.status, self.body.error?.code], [409, 'already_member'])
      const m = (await w.callWeb(curaWeb, 'GET', '/v1/brains/set/members')).body.members as Json[]
      assert.deepEqual(
        m.map((x) => `${x.name}:${x.role}`),
        ['Cura:curator', 'Rita:reader'],
      )
      assert.equal(
        (await w.callWeb(curaWeb, 'PUT', `/v1/brains/set/members/${rita.id}`, { role: 'contributor' }))
          .status,
        200,
      )
      await w.callWeb(curaWeb, 'PUT', `/v1/brains/set/members/${rita.id}`, { role: 'reader' })
    })

    it('deleting a brain is done in the web: an administrator’s token cannot', async () => {
      await w.call(admin.key, 'POST', '/v1/brains', { slug: 'doomed' })
      const byKey = await w.call(admin.key, 'DELETE', '/v1/brains/doomed', { confirm: 'doomed' })
      assert.deepEqual([byKey.status, byKey.body.error?.code], [403, 'web_only'])
      const byWeb = await w.callWeb(adminWeb, 'DELETE', '/v1/brains/doomed', { confirm: 'doomed' })
      assert.equal(byWeb.status, 200, byWeb.text)
    })

    it('one new link per invitation a minute: a second one sooner says when to try', async () => {
      const made = await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: ['slow@example.com'] })
      const id = String((made.body.invitations as Json[])[0]?.id)
      assert.equal((await w.callWeb(adminWeb, 'POST', `/v1/invitations/${id}/resend`)).status, 200)
      const soon = await w.callWeb(adminWeb, 'POST', `/v1/invitations/${id}/resend`)
      assert.deepEqual([soon.status, soon.body.error?.code], [429, 'too_soon'])
      assert.match(String(soon.body.error?.message), /minute/)
      assert.ok(!soon.text.includes('#token='))
      w.advance(61_000)
      assert.equal((await w.callWeb(adminWeb, 'POST', `/v1/invitations/${id}/resend`)).status, 200)
    })

    it('an archived brain links no repository; its members still change', async () => {
      await w.call(cura.key, 'POST', '/v1/brains', { slug: 'shelf' })
      await w.callWeb(curaWeb, 'POST', '/v1/brains/shelf/archive')
      const link = await w.callWeb(curaWeb, 'POST', '/v1/brains/shelf/repos', {
        repo: 'github.com/acme/shelf',
      })
      assert.equal(link.status, 403, link.text)
      assert.match(String(link.body.error?.message), /archived/)
      const add = await w.callWeb(curaWeb, 'POST', '/v1/brains/shelf/members', {
        account: rita.id,
        role: 'reader',
      })
      assert.equal(add.status, 201, add.text)
    })

    it('a repository is a full address: relative paths and a bare org/repo are refused with a hint', async () => {
      for (const repo of ['./app', '../app', 'org/repo']) {
        const r = await w.callWeb(curaWeb, 'POST', '/v1/brains/set/repos', { repo })
        assert.deepEqual([r.status, r.body.error?.code], [400, 'invalid_request'], repo)
        assert.match(String(r.body.error?.howToProceed), /full address, e\.g\. github\.com\/org\/repo/)
      }
      const git = await w.callWeb(curaWeb, 'POST', '/v1/brains/set/repos', {
        repo: 'git://Host.example:9418/A/b.git/',
      })
      assert.deepEqual([git.status, git.body.repo], [201, 'host.example/a/b'])
    })

    it('a deactivated service account is called so', async () => {
      const svc = await w.service('Sleeper')
      await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${svc.id}/remove`)
      const r = await w.callWeb(adminWeb, 'POST', `/v1/admin/services/${svc.id}/keys`, {})
      assert.match(String(r.body.error?.message), /deactivated/)
      const add = await w.callWeb(curaWeb, 'POST', '/v1/brains/set/members', {
        account: svc.id,
        role: 'reader',
      })
      assert.match(String(add.body.error?.message), /deactivated/)
    })
  })

  describe('the administration', () => {
    it('lists each person with their role in each brain', async () => {
      const r = await w.callWeb(adminWeb, 'GET', '/v1/admin/accounts')
      assert.equal(r.status, 200, r.text)
      const accounts = r.body.accounts as Json[]
      const c = accounts.find((a) => a.id === cura.id) as Json
      assert.deepEqual(
        (c.roles as Json[]).filter((r) => r.slug === 'set'),
        [{ slug: 'set', name: 'Settings', role: 'curator' }],
      )
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
