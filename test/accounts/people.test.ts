// Spec B4 «Invitar», «Roles y miembros», «Tokens personales», «Cuentas de servicio», «Avisos por email»:
// invitations with and without mail, roles and the last curator, the administration that reads only as
// a member, removing people, tokens seen once, service accounts and rotation, the pending curator.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { remindExpiringTokens } from '../../src/domain/notices.ts'
import { skipPg } from '../helpers/pg.ts'
import { TEST_SECRET, type World, world } from '../helpers/world.ts'

const WEB = { 'x-requested-with': 'rsc-brain-web' }
const PW = 'a long enough password'
const sessionOf = (h: Headers) => /rscb_session=([^;]+)/.exec(h.get('set-cookie') ?? '')?.[1] ?? ''
const tokenOf = (text: string) => /#token=(rscb_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? ''

describe('people and keys', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string } // the administration
  let ana: { id: string; key: string } // curator of yt
  let adminWeb: string
  let anaWeb: string

  const look = (token: string) => w.raw('POST', '/v1/invitations/look', { body: { token } })
  const accept = (token: string, name = 'New Person', password = PW) =>
    w.raw('POST', '/v1/invitations/accept', { headers: WEB, body: { token, name, password } })
  const audited = (action: string, extra = '') =>
    w.db.query(`SELECT * FROM audit WHERE action = $1 ${extra} ORDER BY id`, [action])

  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    ana = await w.person('Ana')
    adminWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    await w.call(ana.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.call(ana.key, 'POST', '/v1/brains', { slug: 'blog' })
  })
  after(async () => w.close())

  it('CA4: without mail the administration copies the link, and it works the same', async () => {
    const r = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['carla@example.com'],
      brains: [{ slug: 'yt', role: 'contributor' }],
    })
    assert.equal(r.status, 201, r.text)
    const inv = (r.body.invitations as Array<{ link: string; mailed: boolean; mailError: string }>)[0]
    assert.equal(inv?.mailed, false)
    assert.match(String(inv?.mailError), /not set up/)
    assert.equal(w.mails.length, 0)
    const shown = await look(tokenOf(String(inv?.link)))
    assert.deepEqual(
      [shown.status, (shown.body.invitation as { brains: unknown }).brains],
      [200, [{ slug: 'yt', name: 'yt', role: 'contributor' }]],
    )
    const ok = await accept(tokenOf(String(inv?.link)), 'Carla')
    assert.equal(ok.status, 201, ok.text)
    const me = await w.raw('GET', '/v1/brains/yt', {
      headers: { cookie: `rscb_session=${sessionOf(ok.headers)}` },
    })
    assert.equal((me.body.brain as { role: string }).role, 'contributor')
    const log = await w.db.one("SELECT status FROM mail_log WHERE to_addr = 'carla@example.com'")
    assert.equal(log?.status, 'skipped')
  })

  it('CA3: with mail, the link arrives; it sets the password, gives the exact roles, works once, ends at 72 h', async () => {
    await w.setUpMail()
    const r = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['dani@example.com', 'late@example.com'],
      brains: [
        { slug: 'yt', role: 'contributor' },
        { slug: 'blog', role: 'reader' },
      ],
    })
    assert.equal(r.status, 201, r.text)
    const mail = await w.mailTo('dani@example.com')
    assert.match(mail.text, /yt \(contributor\)/)
    assert.match(mail.text, /blog \(reader\)/)
    // The log keeps no content: it would carry the link.
    const logged = await w.db.query("SELECT * FROM mail_log WHERE to_addr = 'dani@example.com'")
    assert.ok(!JSON.stringify(logged).includes(tokenOf(mail.text)))
    const ok = await accept(tokenOf(mail.text), 'Dani')
    assert.equal(ok.status, 201, ok.text)
    const dani = String((ok.body.account as { id: string }).id)
    const roles = await w.db.query(
      'SELECT b.slug, m.role FROM memberships m JOIN brains b ON b.id = m.brain_id WHERE m.account_id = $1 ORDER BY b.slug',
      [dani],
    )
    assert.deepEqual(
      roles.map((x) => [x.slug, x.role]),
      [
        ['blog', 'reader'],
        ['yt', 'contributor'],
      ],
    )
    // Signing in works with the password chosen.
    const login = await w.raw('POST', '/v1/auth/login', {
      headers: WEB,
      body: { email: 'dani@example.com', password: PW },
    })
    assert.equal(login.status, 200)
    const again = await accept(tokenOf(mail.text), 'Dani again')
    assert.deepEqual([again.status, again.body.error?.code], [400, 'invitation_invalid'])
    assert.match(String(again.body.error?.howToProceed), /administration/)
    // 72 hours later the other link no longer works.
    const late = await w.mailTo('late@example.com')
    w.advance(72 * 3_600_000 + 1000)
    assert.equal((await look(tokenOf(late.text))).status, 400)
    assert.equal((await accept(tokenOf(late.text))).status, 400)
    w.advance(-(72 * 3_600_000 + 1000))
  })

  it('resending makes a new link and the old one stops; withdrawing stops it; an existing email is refused', async () => {
    const r = await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: ['eva@example.com'] })
    const inv = (r.body.invitations as Array<{ id: string; link: string }>)[0]
    const re = await w.callWeb(adminWeb, 'POST', `/v1/invitations/${inv?.id}/resend`)
    assert.equal(re.status, 200, re.text)
    assert.equal((await look(tokenOf(String(inv?.link)))).status, 400)
    const fresh = tokenOf(String((re.body.invitation as { link: string }).link))
    assert.equal((await look(fresh)).status, 200)
    assert.equal((await w.callWeb(adminWeb, 'DELETE', `/v1/invitations/${inv?.id}`)).status, 200)
    assert.equal((await look(fresh)).status, 400)
    const listed = (await w.callWeb(adminWeb, 'GET', '/v1/invitations')).body.invitations as Array<{
      email: string
      status: string
    }>
    assert.equal(listed.find((x) => x.email === 'eva@example.com')?.status, 'revoked')
    const taken = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: [String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [ana.id]))?.email)],
    })
    assert.deepEqual([taken.status, taken.body.error?.code], [409, 'email_taken'])
    // Not a plain email (a display name, a list): refused, so nothing can add a recipient.
    for (const bad of [
      'Eve <eve@example.com>',
      'a@example.com, b@example.com',
      'x@example.com\nBcc: y@z.com',
    ]) {
      assert.equal((await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: [bad] })).status, 400, bad)
    }
  })

  it('a curator invites only when the installation allows it, only to their brains, never as admin', async () => {
    const no = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['fede@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    assert.equal(no.status, 403)
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: true })
    const yes = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['fede@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    assert.equal(yes.status, 201, yes.text)
    const asAdmin = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['gil@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
      isAdmin: true,
    })
    assert.equal(asAdmin.status, 403)
    const other = await w.person('Other')
    await w.call(other.key, 'POST', '/v1/brains', { slug: 'theirs' })
    const notMine = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['gil@example.com'],
      brains: [{ slug: 'theirs', role: 'reader' }],
    })
    assert.equal(notMine.status, 404)
    // A key, even the curator's, does not invite.
    const byKey = await w.call(ana.key, 'POST', '/v1/invitations', {
      emails: ['gil@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    assert.deepEqual([byKey.status, byKey.body.error?.code], [403, 'web_only'])
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: false })
  })

  it('CA5: a reader cannot write by the web or a key; the refusal says whom to ask, and is audited', async () => {
    const rita = await w.person('Rita')
    await w.member('yt', rita.id, 'reader')
    for (const r of [
      await w.call(rita.key, 'POST', '/v1/brains/yt/entries', { type: 'learning', title: 'x', content: 'y' }),
      await w.callWeb(await w.web(rita.id), 'POST', '/v1/brains/yt/entries', {
        type: 'learning',
        title: 'x',
        content: 'y',
      }),
    ]) {
      assert.equal(r.status, 403, r.text)
      assert.match(String(r.body.error?.message), /you are reader/)
      assert.match(String(r.body.error?.howToProceed), /Ask a curator of the brain \(Ana\)/)
    }
    const denied = await w.db.query("SELECT * FROM audit WHERE actor_id = $1 AND outcome = 'denied'", [
      rita.id,
    ])
    assert.ok(denied.length >= 2)
  })

  it('CA6: the last curator cannot be removed or demoted; with another curator it can', async () => {
    const demote = await w.callWeb(anaWeb, 'PUT', `/v1/brains/blog/members/${ana.id}`, { role: 'reader' })
    assert.deepEqual([demote.status, demote.body.error?.code], [409, 'last_curator'])
    assert.match(String(demote.body.error?.howToProceed), /another member curator first/)
    const leave = await w.callWeb(anaWeb, 'DELETE', `/v1/brains/blog/members/${ana.id}`)
    assert.equal(leave.status, 409)
    const hugo = await w.person('Hugo')
    const add = await w.callWeb(anaWeb, 'POST', '/v1/brains/blog/members', {
      account: hugo.id,
      role: 'curator',
    })
    assert.equal(add.status, 201, add.text)
    const now = await w.callWeb(anaWeb, 'PUT', `/v1/brains/blog/members/${ana.id}`, { role: 'contributor' })
    assert.equal(now.status, 200, now.text)
    // A role change counts from the next request of every key of that person.
    const write = await w.call(ana.key, 'POST', '/v1/brains/blog/archive')
    assert.equal(write.status, 403)
    // Only curators change members.
    const anaAgain = await w.callWeb(anaWeb, 'PUT', `/v1/brains/blog/members/${hugo.id}`, { role: 'reader' })
    assert.equal(anaAgain.status, 403)
  })

  it('CA7: the administration does not read a brain it is not in; joining is audited and its curators see it', async () => {
    const before = await w.call(eric.key, 'GET', '/v1/brains/yt/entries')
    const none = await w.call(eric.key, 'GET', '/v1/brains/no-such-brain/entries')
    assert.deepEqual([before.status, before.body], [none.status, none.body])
    const list = await w.callWeb(adminWeb, 'GET', '/v1/admin/brains')
    const yt = (list.body.brains as Array<{ slug: string; youAreMember: boolean; curators: unknown[] }>).find(
      (b) => b.slug === 'yt',
    )
    assert.equal(yt?.youAreMember, false)
    const join = await w.callWeb(adminWeb, 'POST', '/v1/admin/brains/yt/join')
    assert.deepEqual([join.status, join.body.joined, join.body.role], [200, true, 'reader'])
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/entries')).status, 200)
    assert.equal((await audited('admin.join')).length, 1)
    const notices = (await w.callWeb(anaWeb, 'GET', '/v1/me/notices')).body.notices as Array<{ text: string }>
    assert.ok(notices.some((n) => /administration\) joined "yt"/.test(n.text)))
  })

  it('CA8: a token is seen once; then only its last 4, its last use and its client', async () => {
    const made = await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
      name: 'Claude Code laptop',
      perm: 'write',
      brains: ['yt'],
      days: 30,
    })
    assert.equal(made.status, 201, made.text)
    const t = made.body.token as { id: string; secret: string; last4: string }
    assert.match(String(made.body.message), /only this once/)
    await fetch(`${w.base}/v1/me`, {
      headers: { authorization: `Bearer ${t.secret}`, 'user-agent': 'claude-code/2.1' },
    })
    const listed = await w.callWeb(anaWeb, 'GET', '/v1/me/tokens')
    const row = (listed.body.tokens as Array<Record<string, unknown>>).find((x) => x.id === t.id)
    assert.deepEqual(
      [row?.last4, row?.lastClient, row?.brains],
      [t.secret.slice(-4), 'claude-code/2.1', ['yt']],
    )
    assert.ok(row?.lastUsedAt)
    assert.ok(!listed.text.includes(t.secret))
    // "All my brains" says it reaches future ones too; days other than 30, 90, 365 are refused.
    const all = await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
      name: 'all',
      perm: 'read',
      allBrains: true,
    })
    assert.match(String(all.body.note), /including brains you join later/)
    assert.equal(
      (
        await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
          name: 'x',
          perm: 'read',
          allBrains: true,
          days: 1000,
        })
      ).status,
      400,
    )
    // A token cannot name a brain its person is not in; a key cannot make tokens.
    assert.equal(
      (await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', { name: 'x', perm: 'read', brains: ['theirs'] }))
        .status,
      404,
    )
    assert.equal(
      (await w.call(ana.key, 'POST', '/v1/me/tokens', { name: 'x', perm: 'read', allBrains: true })).status,
      403,
    )
  })

  it('CA9 and CA10: a read + write token of a reader cannot write; a revoked token stops at once', async () => {
    const ines = await w.person('Ines')
    await w.member('yt', ines.id, 'reader')
    const web = await w.web(ines.id)
    const made = await w.callWeb(web, 'POST', '/v1/me/tokens', { name: 'rw', perm: 'write', brains: ['yt'] })
    const secret = String((made.body.token as { secret: string }).secret)
    const id = String((made.body.token as { id: string }).id)
    const write = await w.call(secret, 'POST', '/v1/brains/yt/entries', {
      type: 'learning',
      title: 'x',
      content: 'y',
    })
    assert.equal(write.status, 403)
    assert.equal((await w.call(secret, 'GET', '/v1/brains/yt')).status, 200)
    assert.equal((await w.callWeb(web, 'DELETE', `/v1/me/tokens/${id}`)).status, 200)
    const after = await w.call(secret, 'GET', '/v1/brains/yt')
    assert.deepEqual([after.status, after.body.error?.code], [401, 'key_revoked'])
    assert.match(String(after.body.error?.howToProceed), /http:\/\/localhost\/profile\/tokens/)
  })

  it('CA11: removing a person stops all their keys at once; what they wrote stays signed «former member»', async () => {
    const juan = await w.person('Juan')
    await w.member('yt', juan.id, 'contributor')
    const web = await w.web(juan.id)
    const t2 = await w.token(juan.id)
    const saved = await w.call(juan.key, 'POST', '/v1/brains/yt/entries', {
      type: 'learning',
      title: 'Hooks',
      content: 'Short hooks.',
    })
    assert.equal(saved.status, 201, saved.text)
    const out = await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${juan.id}/remove`)
    assert.equal(out.status, 200, out.text)
    for (const r of [
      await w.call(juan.key, 'GET', '/v1/me'),
      await w.call(t2, 'GET', '/v1/me'),
      await w.callWeb(web, 'GET', '/v1/me'),
    ]) {
      assert.equal(r.status, 401)
    }
    const entryId = (saved.body.receipt as { entryId: string }).entryId
    const e = (await w.call(ana.key, 'GET', `/v1/entries/${entryId}`)).body.entry as { authorId: string }
    assert.equal(e.authorId, juan.id)
    const members = await w.callWeb(anaWeb, 'GET', '/v1/brains/yt/members')
    assert.deepEqual(
      (members.body.former as Array<{ accountId: string; name: string; label: string }>).find(
        (f) => f.accountId === juan.id,
      ),
      { accountId: juan.id, name: 'Juan', label: 'former member' },
    )
    // Reactivated, the person is back in their brains; the old keys stay revoked.
    assert.equal((await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${juan.id}/restore`)).status, 200)
    assert.equal((await w.call(juan.key, 'GET', '/v1/me')).status, 401)
    assert.equal((await w.call(await w.token(juan.id), 'GET', '/v1/brains/yt')).status, 200)
    // The administration cannot remove itself, nor the last administrator.
    assert.equal((await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${eric.id}/remove`)).status, 400)
    const demote = await w.callWeb(adminWeb, 'PATCH', `/v1/admin/accounts/${eric.id}`, { isAdmin: false })
    assert.deepEqual([demote.status, demote.body.error?.code], [409, 'last_admin'])
  })

  it('CA15 and CA32: a service account is never curator; a curator adds it (audited); the administration adding it tells the curators', async () => {
    await w.setUpMail()
    const factory = await w.service('RSC Factory')
    const cur = await w.callWeb(anaWeb, 'POST', '/v1/brains/yt/members', {
      account: factory.id,
      role: 'curator',
    })
    assert.equal(cur.status, 400)
    assert.match(String(cur.body.error?.message), /never a curator/)
    const add = await w.callWeb(anaWeb, 'POST', '/v1/brains/yt/members', {
      account: factory.id,
      role: 'reader',
    })
    assert.equal(add.status, 201, add.text)
    const yt = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'yt'")
    const rows = await audited('member.add', `AND brain_id = '${yt?.id}' AND target = '${factory.id}'`)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.actor_id, ana.id)
    // Nobody was told: a curator did it.
    const before = w.mails.length
    // The administration adds the service to blog: blog's curators hear of it, in the web and by mail.
    const adminAdd = await w.callWeb(adminWeb, 'POST', '/v1/brains/blog/members', {
      account: factory.id,
      role: 'contributor',
    })
    assert.equal(adminAdd.status, 201, adminAdd.text)
    const hugoId = String((await w.db.one("SELECT id FROM accounts WHERE name = 'Hugo'"))?.id)
    const hugoNotices = (await w.callWeb(await w.web(hugoId), 'GET', '/v1/me/notices')).body
      .notices as Array<{
      kind: string
      brain: string
    }>
    assert.ok(hugoNotices.some((n) => n.kind === 'service.added' && n.brain === 'blog'))
    assert.ok(w.mails.length > before)
  })

  it('CA19: a second main key rotates without a cut; a third at once is refused', async () => {
    const created = await w.callWeb(adminWeb, 'POST', '/v1/admin/services', {
      name: 'Rotor',
      brains: [{ slug: 'yt', role: 'contributor' }],
    })
    assert.equal(created.status, 201, created.text)
    const id = String((created.body.account as { id: string }).id)
    const l1 = created.body.key as { id: string; secret: string }
    const l2 = (await w.callWeb(adminWeb, 'POST', `/v1/admin/services/${id}/keys`, { name: 'main 2' })).body
      .key as { id: string; secret: string }
    assert.equal((await w.call(l2.secret, 'GET', '/v1/brains/yt')).status, 200)
    const third = await w.callWeb(adminWeb, 'POST', `/v1/admin/services/${id}/keys`, {})
    assert.deepEqual([third.status, third.body.error?.code], [409, 'too_many_main_keys'])
    assert.equal((await w.callWeb(adminWeb, 'DELETE', `/v1/keys/${l1.id}`)).status, 200)
    assert.equal((await w.call(l1.secret, 'GET', '/v1/brains/yt')).status, 401)
    assert.equal((await w.call(l2.secret, 'GET', '/v1/brains/yt')).status, 200)
    const keys = (await w.callWeb(adminWeb, 'GET', `/v1/admin/accounts/${id}/keys`)).body.keys as Array<{
      id: string
      status: string
      last4: string
    }>
    assert.deepEqual(
      keys.map((k) => [k.id, k.status]).sort(),
      [
        [l1.id, 'revoked'],
        [l2.id, 'active'],
      ].sort(),
    )
    // A service is created only with contributor or reader roles.
    const asCurator = await w.callWeb(adminWeb, 'POST', '/v1/admin/services', {
      name: 'Bad',
      brains: [{ slug: 'yt', role: 'curator' }],
    })
    assert.equal(asCurator.status, 400)
  })

  it('CA25: a token ending within 7 days shows in the web with a way to make another, and is mailed once', async () => {
    await w.setUpMail()
    const kim = await w.person('Kim')
    const web = await w.web(kim.id)
    const made = await w.callWeb(web, 'POST', '/v1/me/tokens', {
      name: 'short one',
      perm: 'read',
      allBrains: true,
      days: 30,
    })
    assert.equal(made.status, 201)
    const n0 = (await w.callWeb(web, 'GET', '/v1/me/notices')).body.expiringTokens as unknown[]
    assert.equal(n0.length, 0)
    w.advance(24 * 86_400_000)
    const web2 = await w.web(kim.id)
    const n1 = (await w.callWeb(web2, 'GET', '/v1/me/notices')).body.expiringTokens as Array<{
      name: string
      action: { path: string }
    }>
    assert.deepEqual([n1[0]?.name, n1[0]?.action.path], ['short one', '/v1/me/tokens'])
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [kim.id]))?.email)
    assert.ok(
      (await remindExpiringTokens(w.db, w.clock, {
        secret: TEST_SECRET,
        transport: () => ({ send: async (m) => void w.mails.push(m) }),
      })) >= 1,
    )
    assert.match((await w.mailTo(email)).subject, /"short one" ends soon/)
    const count = w.mails.filter((m) => m.to === email).length
    await remindExpiringTokens(w.db, w.clock, {
      secret: TEST_SECRET,
      transport: () => ({ send: async (m) => void w.mails.push(m) }),
    })
    assert.equal(w.mails.filter((m) => m.to === email).length, count, 'once')
    w.advance(-24 * 86_400_000)
  })

  it('CA31: a service that may invite names a curator by email; the brain works, nobody approves, accepting makes the curator', async () => {
    await w.setUpMail()
    const svc = await w.service('Factory Inviter', { canInvite: true })
    const made = await w.call(svc.key, 'POST', '/v1/brains', {
      slug: 'new-show',
      firstCurator: 'lia@example.com',
    })
    assert.equal(made.status, 201, made.text)
    assert.equal((made.body.brain as { pendingCuratorEmail: string }).pendingCuratorEmail, 'lia@example.com')
    const mail = await w.mailTo('lia@example.com')
    assert.match(mail.text, /new-show \(curator\)/)
    const saved = await w.call(svc.key, 'POST', '/v1/brains/new-show/entries', {
      type: 'learning',
      title: 'First',
      content: 'Works before the curator.',
    })
    assert.equal(saved.status, 201)
    const brains = (await w.callWeb(adminWeb, 'GET', '/v1/admin/brains')).body.brains as Array<{
      slug: string
      curators: unknown[]
      pendingCurator: { email: string; invitationId: string } | null
    }>
    const b = brains.find((x) => x.slug === 'new-show')
    assert.deepEqual([b?.curators, b?.pendingCurator?.email], [[], 'lia@example.com'])
    assert.ok(b?.pendingCurator?.invitationId)
    const ok = await accept(tokenOf(mail.text), 'Lia')
    assert.equal(ok.status, 201, ok.text)
    const lia = String((ok.body.account as { id: string }).id)
    const role = await w.db.one(
      "SELECT m.role FROM memberships m JOIN brains b ON b.id = m.brain_id WHERE b.slug = 'new-show' AND m.account_id = $1",
      [lia],
    )
    assert.equal(role?.role, 'curator')
    const after = await w.db.one("SELECT pending_curator_email FROM brains WHERE slug = 'new-show'")
    assert.equal(after?.pending_curator_email, null)
  })

  it('a curator who asks gets a mail for each new proposal: which brain, who, how many; never the content', async () => {
    await w.setUpMail()
    const mo = await w.person('Mo')
    await w.call(mo.key, 'POST', '/v1/brains', { slug: 'notes' })
    const moWeb = await w.web(mo.id)
    assert.equal(
      (await w.callWeb(moWeb, 'PUT', '/v1/brains/notes/notify', { notifyProposals: true })).status,
      200,
    )
    const bot = await w.service('Bot')
    await w.member('notes', bot.id, 'contributor')
    const e = await w.call(bot.key, 'POST', '/v1/brains/notes/entries', {
      type: 'learning',
      title: 'Secret plan',
      content: 'Nobody should read this in a mail.',
    })
    const entryId = (e.body.receipt as { entryId: string }).entryId
    const p = await w.call(bot.key, 'POST', '/v1/brains/notes/proposals', {
      title: 'Secret plan page',
      reason: 'Learned.',
      ops: [
        {
          op: 'create',
          address: 'plans/secret',
          type: 'topic',
          title: 'Secret plan',
          summary: 'The plan.',
          body: 'Nobody should read this in a mail.',
          sources: [{ entryId }],
          reason: 'It is what the journal says.',
        },
      ],
    })
    assert.equal(p.status, 201, p.text)
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [mo.id]))?.email)
    const m = await w.mailTo(email)
    assert.match(m.text, /Bot proposed 1 change to the wiki of "notes"/)
    assert.match(m.text, /\/brains\/notes\/proposals\/prp_/)
    assert.ok(!/Secret plan|Nobody should/.test(m.text + m.subject))
  })

  it('mail settings: the password is sealed and never shown; a failed send is logged and blocks nothing', async () => {
    const put = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
      host: 'smtp.example.com',
      port: 587,
      user: 'brain',
      password: 'smtp-password-123',
      fromAddress: 'brain@example.com',
    })
    assert.equal(put.status, 200, put.text)
    assert.ok(!put.text.includes('smtp-password-123'))
    assert.equal((put.body.settings as { hasPassword: boolean }).hasPassword, true)
    const raw = await w.db.one('SELECT mail::text AS m FROM installation')
    assert.ok(!String(raw?.m).includes('smtp-password-123'))
    w.mailFails = true
    const r = await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: ['nora@example.com'] })
    assert.equal(r.status, 201)
    const inv = (r.body.invitations as Array<{ mailed: boolean; mailError: string; link: string }>)[0]
    assert.deepEqual([inv?.mailed, /refused/.test(String(inv?.mailError))], [false, true])
    assert.ok(tokenOf(String(inv?.link)))
    const panel = await w.callWeb(adminWeb, 'GET', '/v1/admin/mail')
    assert.ok(
      (panel.body.recent as Array<{ to: string; status: string }>).some(
        (l) => l.to === 'nora@example.com' && l.status === 'failed',
      ),
    )
    const test = await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test')
    assert.equal((test.body as { sent: boolean }).sent, false)
    w.mailFails = false
    assert.equal(
      ((await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test')).body as { sent: boolean }).sent,
      true,
    )
    // Only the administration, only in the web.
    assert.equal((await w.callWeb(anaWeb, 'GET', '/v1/admin/mail')).status, 403)
    assert.equal((await w.call(eric.key, 'GET', '/v1/admin/mail')).status, 403)
  })

  it('CA22 with mail: asking to reset sends a single-use link that lasts one hour', async () => {
    await w.setUpMail()
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [ana.id]))?.email)
    const r = await w.raw('POST', '/v1/auth/reset', { body: { email } })
    assert.equal(r.status, 202)
    const m = await w.mailTo(email, /Reset your Brain password/)
    assert.match(m.text, /once, for 1 hour/)
    const token = tokenOf(m.text)
    const ok = await w.raw('POST', '/v1/auth/reset/confirm', {
      body: { token, password: 'a brand new password' },
    })
    assert.equal(ok.status, 200, ok.text)
    const twice = await w.raw('POST', '/v1/auth/reset/confirm', {
      body: { token, password: 'another new password' },
    })
    assert.equal(twice.status, 400)
  })
})
