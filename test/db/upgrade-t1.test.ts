// Spec learning-memory «Paso desde la versión anterior» (plan §3.1, §3.2): a database of v0.7.15 (migrated up to 0031)
// with brains, curators, entries, pages and a pending proposal, then the rest of the migrations. What existed keeps
// working as before: the proposal still waits (CA-U2), the old pages count as reviewed (CA-U6), the old entries start
// their per-type expiry on the day of the upgrade (CA-U1), every brain is in «Apply automatically» and each curator has
// a notice that says so, with the way back to «Ask first» (CA-U3). A new installation notifies nobody.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MIGRATIONS_DIR, migrate, migrationFiles, STEPS } from '../../src/db/migrate.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const DAY = 86_400_000
// Shaped like a GitHub token: a notice never stores it (pack rule 1).
const LEAK = `ghp_${'a1B2'.repeat(9)}`

// Every migration of v0.7.15: the SQL files up to 0031 and the steps in code numbered before it.
async function upTo0031(): Promise<string[]> {
  const files = (await migrationFiles(MIGRATIONS_DIR)).map((f) => f.slice(0, -4))
  return [...files, ...STEPS.map((s) => s.id)].filter((id) => id < '0032').sort()
}

describe('upgrade from v0.7.15 (migrations 0032 and 0033)', { skip: skipPg }, () => {
  let t: TestDb
  let applied: string[] = []
  let upgradedAt: Date
  const old = new Date(Date.now() - 30 * DAY)

  before(async () => {
    t = await freshDatabase()
    await migrate(t.db, MIGRATIONS_DIR, { until: await upTo0031() })
    const q = (sql: string, p: unknown[] = []) => t.db.query(sql, p)
    // Accounts: two curators, a removed curator, a contributor.
    await q(
      `INSERT INTO accounts (id, kind, email, name, status, created_at) VALUES
        ('acc_cur', 'person', 'cur@example.com', 'Cur', 'active', $1),
        ('acc_cur2', 'person', 'cur2@example.com', 'Cur Two', 'active', $1),
        ('acc_gone', 'person', 'gone@example.com', 'Gone', 'removed', $1),
        ('acc_con', 'person', 'con@example.com', 'Con', 'active', $1)`,
      [old],
    )
    await q(
      `INSERT INTO brains (id, slug, name, created_by, created_at, updated_at) VALUES
        ('brn_ops', 'ops', 'Ops', 'acc_cur', $1, $1),
        ('brn_yt', 'yt', 'Our channel', 'acc_cur2', $1, $1),
        ('brn_zz', 'leak', $2, 'acc_cur2', $1, $1)`,
      [old, `Leak ${LEAK}`],
    )
    await q(
      `INSERT INTO memberships (brain_id, account_id, role, created_at) VALUES
        ('brn_ops', 'acc_cur', 'curator', $1), ('brn_ops', 'acc_gone', 'curator', $1),
        ('brn_ops', 'acc_con', 'contributor', $1), ('brn_yt', 'acc_cur2', 'curator', $1),
        ('brn_yt', 'acc_cur', 'curator', $1), ('brn_zz', 'acc_cur2', 'curator', $1)`,
      [old],
    )
    await q(
      `INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, all_brains, created_at, expires_at)
       VALUES ('crd_con', 'acc_con', 'token', 't', 'h', 'abcd', 'write', true, $1, $2)`,
      [old, new Date(Date.now() + 90 * DAY)],
    )
    await q(
      `INSERT INTO sessions (id, brain_id, account_id, credential_id, opened_at, last_activity_at)
       VALUES ('ses_1', 'brn_ops', 'acc_con', 'crd_con', $1, $1)`,
      [old],
    )
    // A step of 30 days ago (its type lasts 7: by creation date it would be long gone) and a decision.
    await q(
      `INSERT INTO entries (id, brain_id, session_id, type, title, content, author_id, norm_hash, created_at, updated_at)
       VALUES ('ent_step', 'brn_ops', 'ses_1', 'step', 'Old step', 'Deployed it.', 'acc_con', 'h1', $1, $1),
              ('ent_dec', 'brn_ops', 'ses_1', 'decision', 'Old decision', 'We use PG.', 'acc_con', 'h2', $1, $1)`,
      [old],
    )
    // A page at revision 3, and settings for one brain only.
    await q(
      `INSERT INTO pages (id, brain_id, address, type, title, revision, created_at, updated_at)
       VALUES ('pg_1', 'brn_ops', 'deploys', 'topic', 'Deploys', 3, $1, $1)`,
      [old],
    )
    await q("INSERT INTO wiki_settings (brain_id, stale_days) VALUES ('brn_ops', 30)")
    // A proposal still waiting for a person.
    await q(
      `INSERT INTO proposals (id, brain_id, title, author_id, credential_id, created_at)
       VALUES ('prp_1', 'brn_ops', 'Add a page', 'acc_con', 'crd_con', $1)`,
      [old],
    )
    await q(
      `INSERT INTO proposal_ops (proposal_id, idx, op) VALUES
        ('prp_1', 0, '{"op":"create","address":"new-page","type":"topic","title":"New"}')`,
    )
    upgradedAt = new Date()
    applied = await migrate(t.db)
  })
  after(async () => t.drop())

  it('applies the schema of tranche 1 and the notices step, once', async () => {
    assert.ok(applied.includes('0032_learning_memory_t1'), applied.join(','))
    assert.ok(applied.includes('0033_wiki_mode_notices'), applied.join(','))
    for (const table of ['wiki_changes', 'wiki_change_parts']) {
      const r = await t.db.one('SELECT to_regclass($1) AS r', [table])
      assert.ok(r?.r, `${table} exists`)
    }
    assert.deepEqual(await migrate(t.db), [])
    const n = await t.db.one("SELECT count(*)::int AS n FROM notices WHERE kind = 'wiki_mode'")
    assert.equal(n?.n, 4, 'twice is once')
  })

  it('CA-U2: the pending proposal still waits, with its part', async () => {
    const p = await t.db.one("SELECT status FROM proposals WHERE id = 'prp_1'")
    assert.equal(p?.status, 'pending')
    const o = await t.db.one(
      "SELECT status, hold_reason, stale_current FROM proposal_ops WHERE proposal_id = 'prp_1'",
    )
    assert.deepEqual({ ...o }, { status: 'pending', hold_reason: null, stale_current: null })
  })

  it('CA-U6: pages that existed count as reviewed and none is protected (CA-A19)', async () => {
    const p = await t.db.one("SELECT revision, reviewed_revision, protected FROM pages WHERE id = 'pg_1'")
    assert.deepEqual({ ...p }, { revision: 3, reviewed_revision: 3, protected: false })
    const changes = await t.db.one('SELECT count(*)::int AS n FROM wiki_changes')
    assert.equal(changes?.n, 0, 'nothing enters Review later')
  })

  it('CA-U1: old entries start counting on the day of the upgrade, not on their creation', async () => {
    const rows = await t.db.query<{ id: string; lapse_from: Date }>(
      'SELECT id, lapse_from FROM entries ORDER BY id',
    )
    assert.equal(rows.length, 2)
    for (const r of rows)
      assert.ok(
        r.lapse_from.getTime() >= upgradedAt.getTime() - 5000,
        `${r.id} counts from the upgrade (${r.lapse_from.toISOString()})`,
      )
  })

  it('CA-U3: every brain applies at once; each active curator has a notice with the way back', async () => {
    const modes = await t.db.query('SELECT brain_id, write_mode, entry_lifetimes FROM wiki_settings')
    assert.deepEqual(
      modes.map((m) => ({ ...m })),
      [{ brain_id: 'brn_ops', write_mode: 'auto', entry_lifetimes: {} }],
    )
    const notices = await t.db.query<{ account_id: string; brain_id: string; text: string }>(
      "SELECT account_id, brain_id, text FROM notices WHERE kind = 'wiki_mode' ORDER BY brain_id, account_id",
    )
    assert.deepEqual(
      notices.map((n) => `${n.brain_id}:${n.account_id}`),
      ['brn_ops:acc_cur', 'brn_yt:acc_cur', 'brn_yt:acc_cur2', 'brn_zz:acc_cur2'],
    )
    const leak = notices.find((n) => n.brain_id === 'brn_zz')
    assert.ok(!String(leak?.text).includes(LEAK), 'redacted')
    assert.match(String(leak?.text), /\[redacted secret\]/)
    const yt = notices.find((n) => n.brain_id === 'brn_yt')
    assert.match(
      String(yt?.text),
      /The wiki of "Our channel" now applies agents' changes at once, with undo\./,
    )
    assert.match(String(yt?.text), /Settings › Wiki/)
    assert.match(String(yt?.text), /\/b\/yt\/settings/)
    const audit = await t.db.query(
      "SELECT brain_id, outcome, detail FROM audit WHERE action = 'wiki.mode' ORDER BY brain_id",
    )
    assert.deepEqual(
      audit.map((a) => ({ ...a })),
      [
        { brain_id: 'brn_ops', outcome: 'ok', detail: 'auto (upgrade)' },
        { brain_id: 'brn_yt', outcome: 'ok', detail: 'auto (upgrade)' },
        { brain_id: 'brn_zz', outcome: 'ok', detail: 'auto (upgrade)' },
      ],
    )
  })

  it('the expiry of each type, with the defaults of the spec and per-brain changes', async () => {
    const days = async (type: string, o: unknown = {}) =>
      (await t.db.one('SELECT public.brain_entry_days($1, $2::jsonb) AS d', [type, JSON.stringify(o)]))?.d ??
      null
    assert.equal(await days('step'), 7)
    assert.equal(await days('attempt'), 14)
    assert.equal(await days('summary'), 30)
    assert.equal(await days('note'), 30)
    assert.equal(await days('learning'), 60)
    for (const never of ['decision', 'fact', 'preference', 'correction'])
      assert.equal(await days(never), null)
    assert.equal(await days('note', { note: 90 }), 90)
    assert.equal(await days('step', { step: null }), null, 'null is never')
    assert.equal(await days('decision', { decision: 365 }), 365)
  })
})

describe('a new installation (0032 and 0033)', { skip: skipPg }, () => {
  let t: TestDb
  before(async () => {
    t = await freshDatabase()
    await migrate(t.db)
  })
  after(async () => t.drop())

  it('notifies nobody and writes no audit line', async () => {
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM notices'))?.n, 0)
    assert.equal((await t.db.one("SELECT count(*)::int AS n FROM audit WHERE action = 'wiki.mode'"))?.n, 0)
  })

  it('a new brain is in «Apply automatically» and a new page is not protected', async () => {
    const now = new Date()
    await t.db.query(
      "INSERT INTO accounts (id, kind, email, name, created_at) VALUES ('acc_p', 'person', 'p@x.com', 'P', $1)",
      [now],
    )
    await t.db.query(
      "INSERT INTO brains (id, slug, name, created_by, created_at, updated_at) VALUES ('brn_a', 'aa', 'A', 'acc_p', $1, $1)",
      [now],
    )
    await t.db.query("INSERT INTO wiki_settings (brain_id) VALUES ('brn_a')")
    const s = await t.db.one("SELECT write_mode, entry_lifetimes FROM wiki_settings WHERE brain_id = 'brn_a'")
    assert.deepEqual({ ...s }, { write_mode: 'auto', entry_lifetimes: {} })
    await t.db.query(
      "INSERT INTO pages (id, brain_id, address, type, title, created_at, updated_at) VALUES ('pg_a', 'brn_a', 'a', 'topic', 'A', $1, $1)",
      [now],
    )
    const p = await t.db.one("SELECT protected, protected_by, protected_at FROM pages WHERE id = 'pg_a'")
    assert.deepEqual({ ...p }, { protected: false, protected_by: null, protected_at: null })
  })
})
