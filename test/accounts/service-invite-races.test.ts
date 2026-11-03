// Service invitations against what happens at the same time (F1-PR2 review): a second PostgreSQL client holds
// a transaction open at a chosen point, the server's request waits on it, and the order of the commits is
// fixed by the test, never left to timing. And the quota of invitation mails a service may send in an hour.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('rsc-brain invitation ' || $1))"

describe('service invitations under concurrency', { skip: skipPg }, () => {
  let w: World
  let factory: { id: string; key: string }
  let other: pg.Client
  const invite = (slug: string, people: unknown) =>
    w.call(factory.key, 'POST', `/v1/brains/${slug}/invitations`, { people })
  const roleOf = async (accountId: string) =>
    (
      await w.db.one<{ role: string }>(
        "SELECT m.role FROM memberships m JOIN brains b ON b.id = m.brain_id WHERE b.slug = 'made' AND m.account_id = $1",
        [accountId],
      )
    )?.role ?? null
  const madeId = async () => String((await w.db.one("SELECT id FROM brains WHERE slug = 'made'"))?.id)
  // Until a backend of this database waits on a lock (the server's request, held by `other`).
  async function blocked(n = 1) {
    const end = Date.now() + 5000
    for (;;) {
      const r = await w.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      if ((r?.n ?? 0) >= n) return
      if (Date.now() > end) throw new Error('nothing waited on the lock held by the other transaction')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  before(async () => {
    w = await world()
    await w.setUpMail()
    factory = await w.service('rsc-factory', { canInvite: true })
    const eric = await w.person('Eric', { isAdmin: true })
    const email = (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [eric.id]))
      ?.email
    assert.equal(
      (await w.call(factory.key, 'POST', '/v1/brains', { slug: 'made', firstCurator: email })).status,
      201,
    )
    other = new pg.Client({ connectionString: w.url })
    await other.connect()
  })
  after(async () => {
    await other.end()
    await w.close()
  })

  it('F2: a curator made while the service adds the same person as reader stays curator', async () => {
    const pat = await w.person('Pat')
    const email = (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [pat.id]))
      ?.email as string
    await other.query('BEGIN')
    await other.query(
      "INSERT INTO memberships (brain_id, account_id, role, created_at) VALUES ($1, $2, 'curator', now())",
      [await madeId(), pat.id],
    )
    const pending = invite('made', [{ email, role: 'reader' }])
    await blocked()
    await other.query('COMMIT')
    const r = await pending
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.invited, [{ email, status: 'already' }])
    assert.equal(await roleOf(pat.id), 'curator')
  })

  it('F3: accepting an invitation waits for an invitation of the same email being made', async () => {
    const email = 'accepts@example.com'
    assert.equal((await invite('made', [{ email, role: 'reader' }])).status, 201)
    const token = /#token=([A-Za-z0-9_-]+)/.exec((await w.mailTo(email, /invited you/)).text)?.[1] ?? ''
    await other.query('BEGIN')
    await other.query(LOCK, [email])
    const pending = w.raw('POST', '/v1/invitations/accept', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      body: { token, name: 'Accepts', password: 'correct horse battery staple' },
    })
    try {
      await blocked()
    } finally {
      await other.query('COMMIT')
    }
    const r = await pending
    assert.equal(r.status, 201, r.text)
  })

  it('F3: an account made while the service waits for the email is added, not invited', async () => {
    const email = 'late@example.com'
    await other.query('BEGIN')
    await other.query(LOCK, [email])
    const pending = invite('made', [{ email, role: 'reader' }])
    await blocked()
    // What an acceptance does under that lock: the account of the email.
    await other.query(
      "INSERT INTO accounts (id, kind, email, name, created_at) VALUES ('acc_late', 'person', $1, 'Late', now())",
      [email],
    )
    await other.query('COMMIT')
    const r = await pending
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.invited, [{ email, status: 'added' }])
    assert.equal(await roleOf('acc_late'), 'reader')
    const open = await w.db.one(
      'SELECT 1 FROM invitations WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [email],
    )
    assert.equal(open, undefined, 'no invitation is left for an email that has an account')
  })

  // Second pass: one lock order for everyone (the email's turn, then brain rows, then invitation rows). Before,
  // the service held the brain row and then wanted the email, while an acceptance held the email and then wanted
  // to update the brain row (its pending first curator): a deadlock, and one of them answered 500.
  it('second pass: a first curator accepting while the service invites the same email: both succeed', async () => {
    const email = 'first-curator@example.com'
    const made = await w.call(factory.key, 'POST', '/v1/brains', { slug: 'waits', firstCurator: email })
    assert.equal(made.status, 201, made.text)
    const token = /#token=([A-Za-z0-9_-]+)/.exec((await w.mailTo(email, /invited you/)).text)?.[1] ?? ''
    const waits = String((await w.db.one("SELECT id FROM brains WHERE slug = 'waits'"))?.id)
    // The brain row is held, so whoever wants it waits there, in the order they came.
    await other.query('BEGIN')
    await other.query('SELECT 1 FROM brains WHERE id = $1 FOR UPDATE', [waits])
    const invited = invite('waits', [{ email, role: 'reader' }])
    await blocked(1)
    const accepted = w.raw('POST', '/v1/invitations/accept', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      body: { token, name: 'First', password: 'correct horse battery staple' },
    })
    await blocked(2)
    await other.query('COMMIT')
    const [i, a] = await Promise.all([invited, accepted])
    assert.equal(i.status, 201, i.text)
    assert.equal(a.status, 201, a.text)
  })

  it("second pass: withdrawing an invitation takes the email's turn too (no deadlock with the service)", async () => {
    const email = 'withdrawn@example.com'
    assert.equal(
      (await w.call(factory.key, 'POST', '/v1/brains', { slug: 'withdraws', firstCurator: email })).status,
      201,
    )
    const id = String((await w.db.one('SELECT id FROM invitations WHERE email = $1', [email]))?.id)
    const brain = String((await w.db.one("SELECT id FROM brains WHERE slug = 'withdraws'"))?.id)
    const admin = await w.person('Admin', { isAdmin: true })
    const web = await w.web(admin.id)
    // The administration widens it: the invitation is now the administration's, so the service would take it
    // over (and lock its row) while holding the brain row.
    assert.equal((await w.callWeb(web, 'POST', '/v1/invitations', { emails: [email] })).status, 201)
    await other.query('BEGIN')
    await other.query('SELECT 1 FROM brains WHERE id = $1 FOR UPDATE', [brain])
    const invited = invite('withdraws', [{ email, role: 'curator' }])
    await blocked(1)
    const revoked = w.callWeb(web, 'DELETE', `/v1/invitations/${id}`)
    await blocked(2)
    await other.query('COMMIT')
    const [i, r] = await Promise.all([invited, revoked])
    assert.ok(i.status < 300, i.text)
    assert.ok(r.status < 300, r.text)
  })
})

describe('F8: a quota of invitation mails per service account and hour', { skip: skipPg }, () => {
  let w: World
  let factory: { id: string; key: string }
  let ana: string
  const invite = (people: unknown) => w.call(factory.key, 'POST', '/v1/brains/quota/invitations', { people })
  const open = async (email: string) =>
    w.db.one('SELECT 1 FROM invitations WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL', [email])

  before(async () => {
    w = await world({ serviceInvitesPerHour: 2 })
    await w.setUpMail()
    factory = await w.service('rsc-factory', { canInvite: true })
    const eric = await w.person('Eric', { isAdmin: true })
    const a = await w.person('Ana')
    const email = async (id: string) =>
      (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [id]))?.email as string
    ana = await email(a.id)
    const made = await w.call(factory.key, 'POST', '/v1/brains', {
      slug: 'quota',
      firstCurator: await email(eric.id),
    })
    assert.equal(made.status, 201, made.text)
  })
  after(async () => w.close())

  it('mails up to the quota; past it the request is refused with 429 invite_quota and nothing changes', async () => {
    const first = await invite([
      { email: 'q1@example.com', role: 'reader' },
      { email: 'q2@example.com', role: 'reader' },
    ])
    assert.equal(first.status, 201, first.text)
    const mails = w.mails.length
    w.advance(10 * 60_000)
    const over = await invite([
      { email: 'q3@example.com', role: 'reader' },
      { email: ana, role: 'reader' },
    ])
    assert.equal(over.status, 429, over.text)
    assert.equal(over.body.error?.code, 'invite_quota')
    assert.match(String(over.body.error?.howToProceed), /hour|minutes?/)
    assert.equal((over.body.error as Json | undefined)?.retryAfter, 50 * 60)
    assert.equal(await open('q3@example.com'), undefined)
    assert.equal(w.mails.length, mails)
    // Someone with an account takes no mail: still added at once.
    const added = await invite([{ email: ana, role: 'reader' }])
    assert.deepEqual(added.body.invited, [{ email: ana, status: 'added' }])
    // An hour after the first mails, there is room again.
    w.advance(50 * 60_000)
    const later = await invite([{ email: 'q3@example.com', role: 'reader' }])
    assert.deepEqual(later.body.invited, [{ email: 'q3@example.com', status: 'invited' }])
  })

  it('second pass: a brain made with a first curator to invite spends the same quota; past it, nothing is made', async () => {
    w.advance(2 * 3_600_000)
    const make = (slug: string, firstCurator: string) =>
      w.call(factory.key, 'POST', '/v1/brains', { slug, firstCurator })
    assert.equal((await make('qb-1', 'fc1@example.com')).status, 201)
    assert.equal((await make('qb-2', 'fc2@example.com')).status, 201)
    const over = await make('qb-3', 'fc3@example.com')
    assert.equal(over.status, 429, over.text)
    assert.equal(over.body.error?.code, 'invite_quota')
    assert.equal(await w.db.one("SELECT 1 FROM brains WHERE slug = 'qb-3'"), undefined, 'no brain is made')
    assert.equal(await open('fc3@example.com'), undefined)
    // And the invitations endpoint sees those two mails.
    const inv = await invite([{ email: 'q9@example.com', role: 'reader' }])
    assert.equal(inv.status, 429, inv.text)
  })
})
