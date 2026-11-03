// POST /v1/brains/:slug/invitations (plan rsc-factory-brain §3.1, spec C6, CA6b): a service account that
// may invite brings people into a brain it created, as curator or reader. It never takes a role away nor
// lowers one (it raises one, CA6b), never adopts a link someone else holds, cannot touch a brain someone else
// made, and the brain's curators are told.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('a service invites people to the brains it created', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string; email: string }
  let ana: { id: string; key: string; email: string }
  let rita: { id: string; key: string; email: string }
  let gone: { id: string; key: string; email: string }
  let factory: { id: string; key: string }
  let mute: { id: string; key: string }
  const emailOf = async (id: string) =>
    (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [id]))?.email as string
  const roleOf = async (slug: string, accountId: string) =>
    (
      await w.db.one<{ role: string }>(
        'SELECT m.role FROM memberships m JOIN brains b ON b.id = m.brain_id WHERE b.slug = $1 AND m.account_id = $2',
        [slug, accountId],
      )
    )?.role ?? null
  const invite = (slug: string, people: unknown, key = factory.key) =>
    w.call(key, 'POST', `/v1/brains/${slug}/invitations`, { people })
  const openGrants = async (email: string) =>
    ((
      await w.db.one<{ grants: Array<{ brainId: string; role: string }> }>(
        'SELECT grants FROM invitations WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL',
        [email],
      )
    )?.grants ?? null) as Array<{ brainId: string; role: string }> | null
  const tokenOf = (v: unknown) => /#token=([A-Za-z0-9_-]+)/.exec(String(v))?.[1] ?? ''
  const accept = (token: string, name: string) =>
    w.raw('POST', '/v1/invitations/accept', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      body: { token, name, password: 'correct horse battery staple' },
    })
  const brainId = async (slug: string) =>
    String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)

  before(async () => {
    w = await world()
    await w.setUpMail()
    const e = await w.person('Eric', { isAdmin: true })
    eric = { ...e, email: await emailOf(e.id) }
    const a = await w.person('Ana')
    ana = { ...a, email: await emailOf(a.id) }
    const r = await w.person('Rita')
    rita = { ...r, email: await emailOf(r.id) }
    const g = await w.person('Gone')
    gone = { ...g, email: await emailOf(g.id) }
    await w.db.query("UPDATE accounts SET status = 'removed' WHERE id = $1", [gone.id])
    factory = await w.service('rsc-factory', { canInvite: true })
    mute = await w.service('Quiet service', { canInvite: false })
    for (const slug of ['made', 'other-made', 'quiet']) {
      const made = await w.call(slug === 'quiet' ? mute.key : factory.key, 'POST', '/v1/brains', {
        slug,
        firstCurator: eric.email,
      })
      assert.equal(made.status, 201, made.text)
    }
    // A brain Eric made, with rsc-factory in it as a contributor: not the service's to invite into.
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'erics' })
    await w.member('erics', factory.id, 'contributor')
    await w.member('made', rita.id, 'reader')
  })
  after(async () => w.close())

  it('C6: an active person is added with the role; someone without an account is invited by mail', async () => {
    const r = await invite('made', [
      { email: ana.email, role: 'curator' },
      { email: 'New.Person@Example.com', role: 'reader' },
    ])
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body, {
      invited: [
        { email: ana.email, status: 'added' },
        { email: 'new.person@example.com', status: 'invited' },
      ],
    })
    assert.equal(await roleOf('made', ana.id), 'curator')
    assert.deepEqual(await openGrants('new.person@example.com'), [
      { brainId: await brainId('made'), role: 'reader' },
    ])
    const mail = await w.mailTo('new.person@example.com', /invited you/)
    assert.match(mail.subject, /^rsc-factory invited you/)
  })

  it('C6, CA6b: a member is never lowered; a reader asked for as curator is raised ("raised")', async () => {
    const r = await invite('made', [
      { email: eric.email, role: 'reader' },
      { email: rita.email, role: 'curator' },
    ])
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.invited, [
      { email: eric.email, status: 'already' },
      { email: rita.email, status: 'raised' },
    ])
    assert.equal(await roleOf('made', eric.id), 'curator')
    assert.equal(await roleOf('made', rita.id), 'curator')
    // Asked again as reader: never lowered.
    const again = await invite('made', [{ email: rita.email, role: 'reader' }])
    assert.deepEqual(again.body.invited, [{ email: rita.email, status: 'already' }])
    assert.equal(await roleOf('made', rita.id), 'curator')
  })

  it('an open invitation that already brings the person to this brain is left as it is', async () => {
    const email = 'pending@example.com'
    const made = await w.call(factory.key, 'POST', '/v1/brains', { slug: 'awaits', firstCurator: email })
    assert.equal(made.status, 201, made.text)
    const mailsTo = () => w.mails.filter((m) => m.to === email).length
    const before = mailsTo()
    const r = await invite('awaits', [{ email, role: 'reader' }])
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.invited, [{ email, status: 'already' }])
    assert.deepEqual(await openGrants(email), [{ brainId: await brainId('awaits'), role: 'curator' }])
    assert.equal(mailsTo(), before, 'no new mail')
    // Invited to a second brain of the service: the open invitation gains it and keeps its link.
    const again = await invite('made', [{ email, role: 'reader' }])
    assert.deepEqual(again.body.invited, [{ email, status: 'invited' }])
    assert.deepEqual(await openGrants(email), [
      { brainId: await brainId('awaits'), role: 'curator' },
      { brainId: await brainId('made'), role: 'reader' },
    ])
    assert.equal(mailsTo(), before, 'the link already sent still works: nothing new is mailed')
  })

  it('accepting the invitation gives the role in the brain', async () => {
    const email = 'joins@example.com'
    await invite('other-made', [{ email, role: 'curator' }])
    const link = (await w.mailTo(email, /invited you/)).text
    const token = /#token=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? ''
    const ok = await w.raw('POST', '/v1/invitations/accept', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      body: { token, name: 'Joins', password: 'correct horse battery staple' },
    })
    assert.equal(ok.status, 201, ok.text)
    assert.deepEqual(ok.body.brains, [{ slug: 'other-made', name: 'other-made', role: 'curator' }])
  })

  it('a brain the service did not create answers as one that does not exist', async () => {
    for (const slug of ['erics', 'quiet', 'nowhere']) {
      const r = await invite(slug, [{ email: ana.email, role: 'reader' }])
      assert.equal(r.status, 404, `${slug}: ${r.text}`)
      assert.equal(r.body.error?.code, 'brain_not_found')
    }
    assert.equal(await roleOf('erics', ana.id), null)
    // Taken out of a brain it made, the service no longer reaches it.
    await w.call(factory.key, 'POST', '/v1/brains', { slug: 'left', firstCurator: eric.email })
    await w.db.query('DELETE FROM memberships WHERE brain_id = $1 AND account_id = $2', [
      await brainId('left'),
      factory.id,
    ])
    assert.equal((await invite('left', [{ email: ana.email, role: 'reader' }])).status, 404)
  })

  it('only the main key of a service that may invite', async () => {
    const quiet = await invite('quiet', [{ email: ana.email, role: 'reader' }], mute.key)
    assert.equal(quiet.status, 403, quiet.text)
    assert.equal(quiet.body.error?.code, 'forbidden')
    assert.match(String(quiet.body.error?.howToProceed), /administration/)
    const short = await w.call(factory.key, 'POST', '/v1/keys/short', {
      writeBrain: 'made',
      ref: 'run r_0000aaaa step 1',
      ttlMinutes: 10,
    })
    const shortKey = String((short.body.key as Json).secret)
    for (const key of [shortKey, eric.key]) {
      const r = await invite('made', [{ email: 'x@example.com', role: 'reader' }], key)
      assert.equal(r.status, 403, r.text)
      assert.equal(r.body.error?.code, 'key_not_allowed')
    }
    const web = await w.callWeb(await w.web(eric.id), 'POST', '/v1/brains/made/invitations', {
      people: [{ email: 'x@example.com', role: 'reader' }],
    })
    assert.equal(web.body.error?.code, 'key_not_allowed')
    assert.equal(await openGrants('x@example.com'), null)
  })

  it('a removed account is not brought back: that person is refused, the others go ahead', async () => {
    const r = await invite('made', [
      { email: 'first@example.com', role: 'reader' },
      { email: gone.email, role: 'reader' },
    ])
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.invited, [
      { email: 'first@example.com', status: 'invited' },
      { email: gone.email, status: 'refused', reason: 'account_removed' },
    ])
    assert.deepEqual(await openGrants('first@example.com'), [
      { brainId: await brainId('made'), role: 'reader' },
    ])
    assert.equal(await roleOf('made', gone.id), null)
    assert.equal(await openGrants(gone.email), null)
  })

  it('a malformed request says what to fix', async () => {
    const bad: unknown[] = [
      undefined,
      [],
      'ana@example.com',
      [{ email: 'not an email', role: 'reader' }],
      [{ email: 'a@example.com', role: 'contributor' }],
      [{ email: 'a@example.com' }],
      [
        { email: 'a@example.com', role: 'reader' },
        { email: 'A@example.com', role: 'curator' },
      ],
      Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com`, role: 'reader' })),
    ]
    for (const people of bad) {
      const r = await invite('made', people)
      assert.equal(r.status, 400, `${JSON.stringify(people)?.slice(0, 80)}: ${r.text}`)
      assert.equal(r.body.error?.code, 'invalid_request')
    }
  })

  it('audited per person, and the curators of the brain are told', async () => {
    const mark = await w.db.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM audit')
    const noticed = await w.db.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM notices')
    await invite('made', [
      { email: 'audited@example.com', role: 'reader' },
      { email: eric.email, role: 'reader' },
    ])
    const rows = await w.db.query(
      "SELECT actor_id, brain_id, target, outcome, detail FROM audit WHERE action = 'invitation.create' AND id > $1 ORDER BY id",
      [mark?.id],
    )
    assert.deepEqual(
      rows.map((x) => [x.actor_id, x.brain_id, x.target, x.outcome]),
      [
        [factory.id, await brainId('made'), 'audited@example.com', 'ok'],
        [factory.id, await brainId('made'), eric.email, 'ok'],
      ],
    )
    assert.match(String(rows[0]?.detail), /reader.*invited/)
    assert.match(String(rows[1]?.detail), /already/)
    const told = await w.db.query(
      'SELECT account_id, kind, brain_id, text FROM notices WHERE id > $1 ORDER BY account_id',
      [noticed?.id],
    )
    // Rita among them since she was raised to curator (CA6b).
    const curators = [eric.id, ana.id, rita.id].sort()
    assert.deepEqual(
      told.map((n) => n.account_id),
      curators,
    )
    for (const n of told) {
      assert.equal(n.kind, 'service.invited')
      assert.equal(n.brain_id, await brainId('made'))
      assert.match(String(n.text), /rsc-factory/)
      assert.match(String(n.text), /audited@example\.com/)
    }
  })

  it('F1: an open invitation someone else made is taken over: its old link stops working, the person gets a new one', async () => {
    const mallory = await w.person('Mallory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'mallorys' })
    await w.member('mallorys', mallory.id, 'curator')
    await w.db.query('UPDATE installation SET curators_invite = true WHERE id = 1')
    const email = 'alice@corp.example'
    const web = await w.web(mallory.id)
    const sent = await w.callWeb(web, 'POST', '/v1/invitations', {
      emails: [email],
      brains: [{ slug: 'mallorys', role: 'reader' }],
    })
    assert.equal(sent.status, 201, sent.text)
    const mine = (sent.body.invitations as Json[])[0] as Json
    const held = tokenOf(mine.link)
    const r = await invite('made', [{ email, role: 'curator' }])
    assert.deepEqual(r.body.invited, [{ email, status: 'invited' }])
    // Mallory's link no longer opens anything: she cannot accept it as alice.
    const stolen = await accept(held, 'Mallory again')
    assert.equal(stolen.status, 400, stolen.text)
    assert.equal(stolen.body.error?.code, 'invitation_invalid')
    // Nor can she make a new link of it: it is no longer hers.
    const resent = await w.callWeb(web, 'POST', `/v1/invitations/${String(mine.id)}/resend`)
    assert.equal(resent.status, 404, resent.text)
    // Alice gets one fresh link, from rsc-factory, that covers every grant.
    const mail = await w.mailTo(email, /^rsc-factory invited you/)
    const fresh = tokenOf(mail.text)
    assert.notEqual(fresh, held)
    const joined = await accept(fresh, 'Alice')
    assert.equal(joined.status, 201, joined.text)
    assert.deepEqual((joined.body.brains as Json[]).map((b) => [b.slug, b.role]).sort(), [
      ['made', 'curator'],
      ['mallorys', 'reader'],
    ])
    await w.db.query('UPDATE installation SET curators_invite = false WHERE id = 1')
  })

  // Second pass: a takeover happens only when the new link reaches the person. Without mail, or when the send
  // fails, the other invitation is left as it was and that person is refused (invitation_pending_elsewhere).
  const curatorInvite = async (email: string, slug: string) => {
    const mallory = await w.person(`Mallory${slug.replaceAll('-', '')}`)
    await w.call(eric.key, 'POST', '/v1/brains', { slug })
    await w.member(slug, mallory.id, 'curator')
    await w.db.query('UPDATE installation SET curators_invite = true WHERE id = 1')
    const sent = await w.callWeb(await w.web(mallory.id), 'POST', '/v1/invitations', {
      emails: [email],
      brains: [{ slug, role: 'reader' }],
    })
    await w.db.query('UPDATE installation SET curators_invite = false WHERE id = 1')
    assert.equal(sent.status, 201, sent.text)
    return { mallory, held: tokenOf(((sent.body.invitations as Json[])[0] as Json).link) }
  }
  const look = (token: string) => w.raw('POST', '/v1/invitations/look', { body: { token } })

  it("second pass: without mail, someone else's invitation is left alone and the person is refused", async () => {
    const email = 'nomail@corp.example'
    const { held } = await curatorInvite(email, 'nomail-src')
    const mail = await w.db.one<{ mail: unknown }>('SELECT mail FROM installation WHERE id = 1')
    await w.db.query('UPDATE installation SET mail = NULL WHERE id = 1')
    try {
      const r = await invite('made', [{ email, role: 'curator' }])
      assert.equal(r.status, 201, r.text)
      assert.deepEqual(r.body.invited, [{ email, status: 'refused', reason: 'invitation_pending_elsewhere' }])
    } finally {
      await w.db.query('UPDATE installation SET mail = $1 WHERE id = 1', [JSON.stringify(mail?.mail)])
    }
    assert.equal((await look(held)).status, 200, 'the link already handed out still works')
    assert.deepEqual(
      ((await openGrants(email)) ?? []).map((g) => g.role),
      ['reader'],
      'nothing was added to it',
    )
  })

  it('second pass: a send that fails leaves the other invitation as it was; the person is refused', async () => {
    const email = 'mailfails@corp.example'
    const { held } = await curatorInvite(email, 'mailfails-src')
    w.mailFails = true
    try {
      const r = await invite('made', [{ email, role: 'curator' }])
      assert.deepEqual(r.body.invited, [{ email, status: 'refused', reason: 'invitation_pending_elsewhere' }])
    } finally {
      w.mailFails = false
    }
    assert.equal((await look(held)).status, 200)
    assert.equal((await openGrants(email))?.length, 1)
  })

  it('second pass: a takeover is audited with the previous inviter, who is told in the app', async () => {
    const email = 'taken@corp.example'
    const { mallory, held } = await curatorInvite(email, 'taken-src')
    const r = await invite('made', [{ email, role: 'reader' }])
    assert.deepEqual(r.body.invited, [{ email, status: 'invited' }])
    assert.equal((await look(held)).status, 400, 'the old link no longer opens it')
    const audit = await w.db.one<{ actor_id: string; detail: string }>(
      "SELECT actor_id, detail FROM audit WHERE action = 'invitation.taken_over' AND target = $1",
      [email],
    )
    assert.equal(audit?.actor_id, factory.id)
    assert.match(String(audit?.detail), new RegExp(mallory.id))
    const told = await w.db.query(
      "SELECT text FROM notices WHERE account_id = $1 AND kind = 'invitation.taken_over'",
      [mallory.id],
    )
    assert.equal(told.length, 1)
    assert.match(String(told[0]?.text), /rsc-factory/)
  })

  it("second pass: someone else's invitation that already gives this role here is taken over too (Mallory variant)", async () => {
    const email = 'variant@corp.example'
    const mallory = await w.person('Malloryvariant')
    await w.member('made', mallory.id, 'curator')
    await w.db.query('UPDATE installation SET curators_invite = true WHERE id = 1')
    const sent = await w.callWeb(await w.web(mallory.id), 'POST', '/v1/invitations', {
      emails: [email],
      brains: [{ slug: 'made', role: 'curator' }],
    })
    await w.db.query('UPDATE installation SET curators_invite = false WHERE id = 1')
    const held = tokenOf(((sent.body.invitations as Json[])[0] as Json).link)
    await w.db.query('DELETE FROM memberships WHERE account_id = $1', [mallory.id])
    const r = await invite('made', [{ email, role: 'curator' }])
    assert.deepEqual(r.body.invited, [{ email, status: 'invited' }])
    assert.equal((await look(held)).status, 400, 'the link Mallory holds is dead')
    const fresh = tokenOf((await w.mailTo(email, /^rsc-factory invited you/)).text)
    assert.equal((await look(fresh)).status, 200)
  })

  // Fourth pass: a brain is never made and then undone. Someone else's open invitation for the first curator is
  // refused before anything is written: no brain, no mail, no quota spent, the other invitation untouched.
  it("fourth pass: a first curator with someone else's open invitation: 409 up front, nothing written", async () => {
    const email = 'upfront@corp.example'
    const { held } = await curatorInvite(email, 'upfront-src')
    const mails = w.mails.length
    const spent = async () =>
      Number(
        (
          await w.db.one<{ n: string }>(
            "SELECT count(*) AS n FROM audit WHERE action = 'invitation.mail' AND actor_id = $1",
            [factory.id],
          )
        )?.n,
      )
    const before = await spent()
    const r = await w.call(factory.key, 'POST', '/v1/brains', { slug: 'upfront', firstCurator: email })
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'invitation_pending_elsewhere')
    assert.match(String(r.body.error?.howToProceed), /resend or withdraw/)
    assert.equal(await w.db.one("SELECT 1 FROM brains WHERE slug = 'upfront'"), undefined, 'no brain')
    assert.equal(w.mails.length, mails, 'no mail')
    assert.equal(await spent(), before, 'no quota spent')
    assert.equal((await look(held)).status, 200, 'the other invitation is untouched')
    assert.equal(
      await w.db.one(
        "SELECT 1 FROM audit WHERE action IN ('brain.delete', 'invitation.takeover_failed') AND target = $1",
        [email],
      ),
      undefined,
    )
  })

  it('fourth pass: a first curator with an open invitation of this same service gains the brain, link kept', async () => {
    const email = 'own@corp.example'
    assert.equal((await invite('made', [{ email, role: 'reader' }])).status, 201)
    const mails = w.mails.filter((m) => m.to === email).length
    const r = await w.call(factory.key, 'POST', '/v1/brains', { slug: 'own-fc', firstCurator: email })
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(
      ((await openGrants(email)) ?? []).map((g) => g.role),
      ['reader', 'curator'],
    )
    assert.equal(w.mails.filter((m) => m.to === email).length, mails, 'the link already mailed stays')
  })

  // Third pass.
  it('third pass: grants added to the invitation while its new link is mailed are kept', async () => {
    const email = 'kept@corp.example'
    const { held } = await curatorInvite(email, 'kept-src')
    // Another service of its own makes the invitation its own in two of its brains (own path, link kept)…
    const other = await w.service('Other service', { canInvite: true })
    for (const slug of ['other-a', 'other-b'])
      assert.equal(
        (await w.call(other.key, 'POST', '/v1/brains', { slug, firstCurator: eric.email })).status,
        201,
      )
    // …taking it over first, then (while rsc-factory mails its own new link) adding a brain to it.
    assert.deepEqual(
      (
        await w.call(other.key, 'POST', '/v1/brains/other-a/invitations', {
          people: [{ email, role: 'reader' }],
        })
      ).body.invited,
      [{ email, status: 'invited' }],
    )
    assert.equal((await look(held)).status, 400)
    w.beforeMail = async (m) => {
      if (m.to !== email || !/^rsc-factory/.test(m.subject)) return
      w.beforeMail = undefined
      const r = await w.call(other.key, 'POST', '/v1/brains/other-b/invitations', {
        people: [{ email, role: 'reader' }],
      })
      assert.deepEqual(r.body.invited, [{ email, status: 'invited' }])
    }
    try {
      const r = await invite('made', [{ email, role: 'reader' }])
      assert.deepEqual(r.body.invited, [{ email, status: 'invited' }])
    } finally {
      w.beforeMail = undefined
    }
    assert.deepEqual(
      ((await openGrants(email)) ?? []).map((g) => g.brainId).sort(),
      [
        await brainId('kept-src'),
        await brainId('made'),
        await brainId('other-a'),
        await brainId('other-b'),
      ].sort(),
      'no grant is lost',
    )
  })

  it('third pass: the previous inviter is told without the brain (no slug), in general words', async () => {
    const email = 'noslug@corp.example'
    const { mallory } = await curatorInvite(email, 'noslug-src')
    await invite('made', [{ email, role: 'reader' }])
    const n = await w.db.one<{ brain_id: string | null; text: string }>(
      "SELECT brain_id, text FROM notices WHERE account_id = $1 AND kind = 'invitation.taken_over'",
      [mallory.id],
    )
    assert.equal(n?.brain_id, null)
    assert.doesNotMatch(String(n?.text), /made/)
  })

  it('third pass: a takeover that loses its race after mailing tells the person the new link is void', async () => {
    const email = 'lost@corp.example'
    await curatorInvite(email, 'lost-src')
    const admin = await w.web(eric.id)
    w.beforeMail = async (m) => {
      if (m.to !== email || !/^rsc-factory/.test(m.subject)) return
      w.beforeMail = undefined
      // Meanwhile the administration makes the invitation's link again: the takeover's compare-and-set loses.
      const id = String(
        (
          await w.db.one(
            'SELECT id FROM invitations WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL',
            [email],
          )
        )?.id,
      )
      await w.db.query('UPDATE invitations SET resent_at = NULL WHERE id = $1', [id])
      assert.equal((await w.callWeb(admin, 'POST', `/v1/invitations/${id}/resend`)).status, 200)
    }
    try {
      const r = await invite('made', [{ email, role: 'reader' }])
      assert.deepEqual(r.body.invited, [{ email, status: 'refused', reason: 'invitation_pending_elsewhere' }])
    } finally {
      w.beforeMail = undefined
    }
    const last = await w.mailTo(email)
    assert.match(last.subject, /no longer valid/)
    assert.match(last.text, /no longer valid/)
    // It says which brain the dead link was for, and only that one (never the other invitation's brains).
    assert.match(last.text, /^- made$/m)
    assert.doesNotMatch(last.text, /lost-src/)
  })

  it('fourth pass: two takeovers of the same service at once both go through: the second merges into the first', async () => {
    const email = 'twice@corp.example'
    const { held, mallory } = await curatorInvite(email, 'twice-src')
    let second: Promise<{ body: Json }> | undefined
    w.beforeMail = async (m) => {
      if (m.to !== email || !/^rsc-factory/.test(m.subject)) return
      w.beforeMail = undefined
      // While the first request mails its new link, a second request of the same service takes it over first.
      second = invite('other-made', [{ email, role: 'reader' }])
      assert.deepEqual((await second).body.invited, [{ email, status: 'invited' }])
    }
    let first: { body: Json }
    try {
      first = await invite('made', [{ email, role: 'reader' }])
    } finally {
      w.beforeMail = undefined
    }
    assert.deepEqual(first.body.invited, [{ email, status: 'invited' }], 'not a lost race')
    assert.equal((await look(held)).status, 400)
    assert.deepEqual(
      ((await openGrants(email)) ?? []).map((g) => g.brainId).sort(),
      [await brainId('twice-src'), await brainId('made'), await brainId('other-made')].sort(),
    )
    assert.equal(
      w.mails.filter((m) => m.to === email && /no longer valid/.test(m.subject)).length,
      0,
      'no follow-up mail',
    )
    const told = await w.db.query(
      "SELECT 1 FROM notices WHERE account_id = $1 AND kind = 'invitation.taken_over'",
      [mallory.id],
    )
    assert.equal(told.length, 1, 'the previous inviter is told once')
    // The first request's link opens nothing: the person is told to use the latest working link, which also
    // covers the brain that request was for (and only that one is named).
    const hint = w.mails.filter((m) => m.to === email && /most recent/.test(m.subject))
    assert.equal(hint.length, 1, 'one short follow-up')
    assert.match(String(hint[0]?.text), /most recent working link/)
    assert.match(String(hint[0]?.text), /^- made$/m)
    assert.doesNotMatch(String(hint[0]?.text), /other-made|twice-src/)
  })

  it('CA6b: an open invitation of this service to the brain as reader is raised to curator, its link kept', async () => {
    const email = 'raise-me@example.com'
    await invite('other-made', [{ email, role: 'reader' }])
    const mailsTo = () => w.mails.filter((m) => m.to === email).length
    const before = mailsTo()
    const noticed = await w.db.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM notices')
    const r = await invite('other-made', [{ email, role: 'curator' }])
    assert.deepEqual(r.body.invited, [{ email, status: 'raised' }])
    assert.deepEqual(await openGrants(email), [{ brainId: await brainId('other-made'), role: 'curator' }])
    assert.equal(mailsTo(), before, 'the link already mailed still works')
    const told = await w.db.query('SELECT text FROM notices WHERE id > $1', [noticed?.id])
    assert.ok(told.length > 0, 'the curators are told')
    for (const n of told) assert.match(String(n.text), /raise-me@example\.com \(curator, raised\)/)
    // Asked as reader again: never lowered.
    const down = await invite('other-made', [{ email, role: 'reader' }])
    assert.deepEqual(down.body.invited, [{ email, status: 'already' }])
    assert.deepEqual(await openGrants(email), [{ brainId: await brainId('other-made'), role: 'curator' }])
  })

  it('nothing to tell when nobody new came in', async () => {
    const noticed = await w.db.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM notices')
    await invite('made', [{ email: eric.email, role: 'curator' }])
    assert.deepEqual(await w.db.query('SELECT id FROM notices WHERE id > $1', [noticed?.id]), [])
  })
})
