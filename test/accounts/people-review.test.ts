// Review of B4 PR12: invitations a curator must not reach, the last administrator under concurrency,
// the administration joining by the members route, the pending curator's email.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { remindExpiringTokens } from '../../src/domain/notices.ts'
import { skipPg } from '../helpers/pg.ts'
import { TEST_SECRET, type World, world } from '../helpers/world.ts'

const tokenOf = (text: string) => /#token=(rscb_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? ''

describe('people: review', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let ana: { id: string; key: string }
  let adminWeb: string
  let anaWeb: string

  before(async () => {
    w = await world()
    admin = await w.person('Admin', { isAdmin: true })
    ana = await w.person('Ana')
    adminWeb = await w.web(admin.id)
    anaWeb = await w.web(ana.id)
    await w.call(ana.key, 'POST', '/v1/brains', { slug: 'yt' })
    await w.call(admin.key, 'POST', '/v1/brains', { slug: 'secret' })
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: true })
  })
  after(async () => w.close())

  it('a curator inviting an email with an open invitation does not get its link', async () => {
    const boss = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['boss@example.com'],
      brains: [{ slug: 'secret', role: 'curator' }],
      isAdmin: true,
    })
    assert.equal(boss.status, 201)
    const r = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['boss@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    assert.deepEqual([r.status, r.body.error?.code], [409, 'invitation_open'])
    assert.ok(!r.text.includes('#token='))
    // The administration's link still works.
    const link = (boss.body.invitations as Array<{ link: string }>)[0]?.link ?? ''
    assert.equal(
      (await w.raw('POST', '/v1/invitations/look', { body: { token: tokenOf(link) } })).status,
      200,
    )
  })

  it('a curator does not see or resend an invitation the administration widened', async () => {
    const mine = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['x2@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    const id = (mine.body.invitations as Array<{ id: string }>)[0]?.id
    await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['x2@example.com'],
      brains: [{ slug: 'secret', role: 'curator' }],
      isAdmin: true,
    })
    const listed = await w.callWeb(anaWeb, 'GET', '/v1/invitations')
    assert.ok(!listed.text.includes('secret'))
    assert.ok(!listed.text.includes('x2@example.com'))
    assert.equal((await w.callWeb(anaWeb, 'POST', `/v1/invitations/${id}/resend`)).status, 404)
  })

  it('a curator who no longer curates the brain, or may no longer invite, cannot resend', async () => {
    const bob = await w.person('Bob')
    await w.member('yt', bob.id, 'curator')
    const bobWeb = await w.web(bob.id)
    const r = await w.callWeb(bobWeb, 'POST', '/v1/invitations', {
      emails: ['bobalt@example.com'],
      brains: [{ slug: 'yt', role: 'curator' }],
    })
    const id = (r.body.invitations as Array<{ id: string }>)[0]?.id
    await w.callWeb(anaWeb, 'DELETE', `/v1/brains/yt/members/${bob.id}`)
    assert.equal((await w.callWeb(bobWeb, 'POST', `/v1/invitations/${id}/resend`)).status, 404)
    await w.member('yt', bob.id, 'curator')
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: false })
    assert.equal((await w.callWeb(bobWeb, 'POST', `/v1/invitations/${id}/resend`)).status, 403)
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: true })
  })

  it('two administrators removing each other at once leave one', async () => {
    for (let i = 0; i < 5; i++) {
      const p = await w.person(`P${i}`, { isAdmin: true })
      const q = await w.person(`Q${i}`, { isAdmin: true })
      // The others step down first, so P and Q are the last two.
      await w.db.query('UPDATE accounts SET is_admin = false WHERE is_admin AND id <> ALL($1)', [
        [p.id, q.id],
      ])
      const [pw, qw] = [await w.web(p.id), await w.web(q.id)]
      const out = await Promise.all([
        i % 2
          ? w.callWeb(pw, 'PATCH', `/v1/admin/accounts/${q.id}`, { isAdmin: false })
          : w.callWeb(pw, 'POST', `/v1/admin/accounts/${q.id}/remove`),
        w.callWeb(qw, 'PATCH', `/v1/admin/accounts/${p.id}`, { isAdmin: false }),
      ])
      const left = await w.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM accounts WHERE is_admin AND status = 'active'",
      )
      assert.equal(left?.n, 1, out.map((o) => o.status).join(','))
    }
    await w.db.query('UPDATE accounts SET is_admin = true WHERE id = $1', [admin.id])
  })

  it('the administration adding itself to a brain is told to its curators', async () => {
    const r = await w.callWeb(adminWeb, 'POST', '/v1/brains/yt/members', {
      account: admin.id,
      role: 'reader',
    })
    assert.equal(r.status, 201, r.text)
    const n = (await w.callWeb(anaWeb, 'GET', '/v1/me/notices')).body.notices as Array<{ kind: string }>
    assert.ok(n.some((x) => x.kind === 'admin.joined'))
  })

  it('only curators see the pending curator email', async () => {
    const svc = await w.service('Inviter', { canInvite: true })
    await w.call(svc.key, 'POST', '/v1/brains', { slug: 'pend', firstCurator: 'hidden@example.com' })
    const rita = await w.person('Rita')
    await w.member('pend', rita.id, 'reader')
    const seen = await w.callWeb(await w.web(rita.id), 'GET', '/v1/brains/pend/members')
    assert.equal(seen.status, 200)
    assert.ok(!seen.text.includes('hidden@example.com'))
    assert.equal(seen.body.pendingCurator, true)
  })

  it('the same new email invited at once: one invitation, no server error', async () => {
    const webs = await Promise.all(Array.from({ length: 6 }, () => w.web(admin.id)))
    const out = await Promise.all(
      webs.map((s) => w.callWeb(s, 'POST', '/v1/invitations', { emails: ['race@example.com'] })),
    )
    assert.ok(
      out.every((o) => o.status === 201),
      out.map((o) => o.status).join(','),
    )
    const n = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM invitations WHERE email = 'race@example.com' AND used_at IS NULL AND revoked_at IS NULL",
    )
    assert.equal(n?.n, 1)
  })

  it('an expired invitation is not revived by a new one', async () => {
    const old = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['old@example.com'],
      isAdmin: true,
    })
    assert.equal(old.status, 201)
    w.advance(73 * 3_600_000)
    const fresh = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['old@example.com'],
      brains: [{ slug: 'secret', role: 'reader' }],
    })
    const link = (fresh.body.invitations as Array<{ link: string }>)[0]?.link ?? ''
    const seen = await w.raw('POST', '/v1/invitations/look', { body: { token: tokenOf(link) } })
    assert.equal((seen.body.invitation as { isAdmin: boolean }).isAdmin, false)
    w.advance(-73 * 3_600_000)
  })

  it('removing a curator while the other curator leaves cannot leave a brain unnoticed without one', async () => {
    for (let i = 0; i < 15; i++) {
      const p1 = await w.person(`C1-${i}`)
      const p2 = await w.person(`C2-${i}`)
      await w.call(p1.key, 'POST', '/v1/brains', { slug: `rb-${i}` })
      await w.member(`rb-${i}`, p2.id, 'curator')
      const [rem, leave] = await Promise.all([
        w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${p1.id}/remove`),
        w.callWeb(await w.web(p2.id), 'DELETE', `/v1/brains/rb-${i}/members/${p2.id}`),
      ])
      const left = await w.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships m JOIN accounts a ON a.id = m.account_id JOIN brains b ON b.id = m.brain_id
          WHERE b.slug = $1 AND m.role = 'curator' AND a.status = 'active'`,
        [`rb-${i}`],
      )
      const reported = ((rem.body.brainsWithoutCurator as string[]) ?? []).includes(`rb-${i}`)
      assert.ok((left?.n ?? 0) >= 1 || reported, `${rem.status} ${leave.status}`)
    }
  })

  it('reset links: at most three an hour, even when asked at once', async () => {
    await w.setUpMail()
    const p = await w.person('Resetter')
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [p.id]))?.email)
    await Promise.all(Array.from({ length: 8 }, () => w.raw('POST', '/v1/auth/reset', { body: { email } })))
    await new Promise((r) => setTimeout(r, 400))
    const n = await w.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM password_resets WHERE account_id = $1',
      [p.id],
    )
    assert.equal(n?.n, 3)
  })

  it('a token reminder that could not be mailed is mailed later', async () => {
    await w.db.query('UPDATE installation SET mail = NULL')
    const kim = await w.person('Kim')
    await w.callWeb(await w.web(kim.id), 'POST', '/v1/me/tokens', {
      name: 'soon',
      perm: 'read',
      allBrains: true,
      days: 30,
    })
    w.advance(25 * 86_400_000)
    const capture = {
      secret: TEST_SECRET,
      transport: () => ({ send: async (m: never) => void w.mails.push(m) }),
    }
    await remindExpiringTokens(w.db, w.clock, capture)
    await w.setUpMail()
    w.mailFails = true
    await remindExpiringTokens(w.db, w.clock, { secret: TEST_SECRET })
    w.mailFails = false
    await remindExpiringTokens(w.db, w.clock, capture)
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [kim.id]))?.email)
    assert.match((await w.mailTo(email, /"soon" ends soon/)).subject, /soon/)
    w.advance(-25 * 86_400_000)
  })

  it('small edges: a misnamed notify field is refused; removing a non-member says member', async () => {
    const bad = await w.callWeb(anaWeb, 'PUT', '/v1/brains/yt/notify', { proposals: true })
    assert.equal(bad.status, 400)
    const ok = await w.callWeb(anaWeb, 'PUT', '/v1/brains/yt/notify', { notifyProposals: true })
    assert.deepEqual([ok.status, ok.body.notifyProposals], [200, true])
    const stranger = await w.person('Stranger')
    const r = await w.callWeb(anaWeb, 'DELETE', `/v1/brains/yt/members/${stranger.id}`)
    assert.deepEqual([r.status, r.body.error?.code], [404, 'not_found'])
  })

  it('proposal mail: not to the curator who proposes, nor to a curator who did not ask', async () => {
    await w.setUpMail()
    const pia = await w.person('Pia')
    const quim = await w.person('Quim')
    await w.call(pia.key, 'POST', '/v1/brains', { slug: 'mail-test' })
    await w.member('mail-test', quim.id, 'curator')
    await w.callWeb(await w.web(pia.id), 'PUT', '/v1/brains/mail-test/notify', { notifyProposals: true })
    const e = await w.call(pia.key, 'POST', '/v1/brains/mail-test/entries', {
      type: 'learning',
      title: 't',
      content: 'c',
    })
    const entryId = (e.body.receipt as { entryId: string }).entryId
    const before = w.mails.length
    const p = await w.call(pia.key, 'POST', '/v1/brains/mail-test/proposals', {
      title: 'x',
      reason: 'y',
      ops: [
        {
          op: 'create',
          address: 'a/b',
          type: 'topic',
          title: 'A',
          summary: 'S.',
          body: 'B.',
          sources: [{ entryId }],
          reason: 'R.',
        },
      ],
    })
    assert.equal(p.status, 201, p.text)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(w.mails.length, before)
  })

  it('second pass: two batch invitations of the same emails in opposite orders both succeed', async () => {
    const emails = Array.from({ length: 25 }, (_, i) => `batch${i}@example.com`)
    const [a, b] = [await w.web(admin.id), await w.web(admin.id)]
    for (let round = 0; round < 3; round++) {
      const list = emails.map((e) => e.replace('@', `-${round}@`))
      const out = await Promise.all([
        w.callWeb(a, 'POST', '/v1/invitations', { emails: list }),
        w.callWeb(b, 'POST', '/v1/invitations', { emails: [...list].reverse() }),
      ])
      assert.deepEqual(
        out.map((o) => o.status),
        [201, 201],
      )
    }
  })

  it('second pass: a first-curator place survives its invitation expiring; a curator cannot take it over', async () => {
    const svc = await w.service('Inviter 2', { canInvite: true })
    await w.call(svc.key, 'POST', '/v1/brains', { slug: 'pendb', firstCurator: 'pc@example.com' })
    w.advance(73 * 3_600_000)
    const byCurator = await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['pc@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    assert.deepEqual([byCurator.status, byCurator.body.error?.code], [409, 'invitation_open'])
    const byAdmin = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['pc@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    assert.equal(byAdmin.status, 201, byAdmin.text)
    const link = (byAdmin.body.invitations as Array<{ link: string }>)[0]?.link ?? ''
    const ok = await w.raw('POST', '/v1/invitations/accept', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      body: { token: tokenOf(link), name: 'PC', password: 'a long enough password' },
    })
    assert.equal(ok.status, 201, ok.text)
    const role = await w.db.one(
      "SELECT m.role FROM memberships m JOIN brains b ON b.id = m.brain_id WHERE b.slug = 'pendb' AND m.account_id = $1",
      [(ok.body.account as { id: string }).id],
    )
    assert.equal(role?.role, 'curator')
    w.advance(-73 * 3_600_000)
  })

  it('F1-PR2 fourth pass: a service naming as first curator someone invited by another makes nothing (409)', async () => {
    const r = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['boss2@example.com'],
      isAdmin: true,
    })
    const link = (r.body.invitations as Array<{ link: string }>)[0]?.link ?? ''
    const svc = await w.service('Sneaky', { canInvite: true })
    const made = await w.call(svc.key, 'POST', '/v1/brains', {
      slug: 'sneak',
      firstCurator: 'boss2@example.com',
    })
    assert.equal(made.status, 409, made.text)
    assert.equal(made.body.error?.code, 'invitation_pending_elsewhere')
    // The administration's link still opens it, unchanged.
    const seen = await w.raw('POST', '/v1/invitations/look', { body: { token: tokenOf(link) } })
    assert.equal(seen.status, 200, seen.text)
    assert.deepEqual((seen.body.invitation as { brains: unknown[] }).brains, [])
  })

  it('second pass: an invitation the administration widened names the administration as inviter', async () => {
    // The newest invitation, so it is on the first page whatever the earlier tests left (same clock, random ids).
    w.advance(1000)
    await w.callWeb(anaWeb, 'POST', '/v1/invitations', {
      emails: ['ee@example.com'],
      brains: [{ slug: 'yt', role: 'reader' }],
    })
    await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['ee@example.com'],
      canCreateBrains: true,
    })
    const list = (await w.callWeb(adminWeb, 'GET', '/v1/invitations')).body.invitations as Array<{
      email: string
      invitedBy: string
    }>
    assert.equal(list.find((i) => i.email === 'ee@example.com')?.invitedBy, 'Admin')
  })
})
