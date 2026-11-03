// POST /v1/brains/:slug/invitations (plan rsc-factory-brain §3.1, spec C6, CA6b): a service account that
// may invite brings people into a brain it created, as curator or reader. It never takes a role away nor
// changes one, it cannot touch a brain someone else made, and the brain's curators are told.
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

  it('C6: a member keeps the role they have: nobody is lowered nor raised ("already")', async () => {
    const r = await invite('made', [
      { email: eric.email, role: 'reader' },
      { email: rita.email, role: 'curator' },
    ])
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.invited, [
      { email: eric.email, status: 'already' },
      { email: rita.email, status: 'already' },
    ])
    assert.equal(await roleOf('made', eric.id), 'curator')
    assert.equal(await roleOf('made', rita.id), 'reader')
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

  it('a removed account is not brought back: the whole request is refused and nothing changes', async () => {
    const r = await invite('made', [
      { email: 'first@example.com', role: 'reader' },
      { email: gone.email, role: 'reader' },
    ])
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'email_taken')
    assert.equal(await openGrants('first@example.com'), null)
    assert.equal(await roleOf('made', gone.id), null)
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
    const curators = [eric.id, ana.id].sort()
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

  it('nothing to tell when nobody new came in', async () => {
    const noticed = await w.db.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM notices')
    await invite('made', [{ email: eric.email, role: 'curator' }])
    assert.deepEqual(await w.db.query('SELECT id FROM notices WHERE id > $1', [noticed?.id]), [])
  })
})
