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
  async function blocked() {
    const end = Date.now() + 5000
    for (;;) {
      const r = await w.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      if ((r?.n ?? 0) > 0) return
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
})
