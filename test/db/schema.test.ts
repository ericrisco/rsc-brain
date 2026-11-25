// Migration 0001 enforces its own rules, so no code path can store an account or key that breaks them.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { migrate } from '../../src/db/migrate.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

describe('schema 0001 constraints', { skip: skipPg }, () => {
  let t: TestDb
  const now = new Date('2026-10-29T10:00:00Z')
  before(async () => {
    t = await freshDatabase()
    await migrate(t.db)
    await t.db.query(
      "INSERT INTO accounts (id, kind, email, name, created_at) VALUES ('acc_p', 'person', 'p@x.com', 'P', $1), ('acc_s', 'service', NULL, 'S', $1)",
      [now],
    )
    await t.db.query(
      "INSERT INTO brains (id, slug, name, created_by, created_at, updated_at) VALUES ('brn_a', 'aa', 'A', 'acc_p', $1, $1)",
      [now],
    )
  })
  after(async () => t.drop())

  const rejects = (sql: string, params: unknown[] = []) => assert.rejects(() => t.db.query(sql, params))

  it('a person has an email and a service has none', async () => {
    await rejects("INSERT INTO accounts (id, kind, name, created_at) VALUES ('acc_x', 'person', 'X', $1)", [
      now,
    ])
    await rejects(
      "INSERT INTO accounts (id, kind, email, name, created_at) VALUES ('acc_y', 'service', 'y@x.com', 'Y', $1)",
      [now],
    )
  })

  it('a service is never an administrator, and emails are stored lowercase', async () => {
    await rejects(
      "INSERT INTO accounts (id, kind, name, is_admin, created_at) VALUES ('acc_z', 'service', 'Z', true, $1)",
      [now],
    )
    await rejects(
      "INSERT INTO accounts (id, kind, email, name, created_at) VALUES ('acc_w', 'person', 'W@X.com', 'W', $1)",
      [now],
    )
  })

  it('brain names are slugs', async () => {
    await rejects(
      "INSERT INTO brains (id, slug, name, created_by, created_at, updated_at) VALUES ('brn_b', 'Bad Name', 'B', 'acc_p', $1, $1)",
      [now],
    )
  })

  it('a short key has a parent, an expiry and a brain; read brains need on-behalf', async () => {
    await t.db.query(
      "INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, created_at) VALUES ('crd_m', 'acc_s', 'main', 'm', 'h1', 'abcd', 'write', $1)",
      [now],
    )
    await rejects(
      "INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, write_brain_id, created_at, expires_at) VALUES ('crd_1', 'acc_s', 'short', 'k', 'h2', 'abcd', 'write', 'brn_a', $1, $1)",
      [now],
    )
    await rejects(
      "INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, parent_id, write_brain_id, read_brain_ids, created_at, expires_at) VALUES ('crd_2', 'acc_s', 'short', 'k', 'h3', 'abcd', 'write', 'crd_m', 'brn_a', '{brn_a}', $1, $1)",
      [now],
    )
    await rejects(
      "INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, created_at) VALUES ('crd_3', 'acc_p', 'token', 't', 'h4', 'abcd', 'write', $1)",
      [now],
    )
  })
})

// Migration 0032 (spec learning-memory, plan §3.1): the states and reasons of tranche 1 are closed lists.
describe('schema 0032 constraints', { skip: skipPg }, () => {
  let t: TestDb
  const now = new Date('2026-11-25T10:00:00Z')
  before(async () => {
    t = await freshDatabase()
    await migrate(t.db)
    await t.db.query(
      "INSERT INTO accounts (id, kind, email, name, created_at) VALUES ('acc_p', 'person', 'p@x.com', 'P', $1)",
      [now],
    )
    await t.db.query(
      "INSERT INTO brains (id, slug, name, created_by, created_at, updated_at) VALUES ('brn_a', 'aa', 'A', 'acc_p', $1, $1)",
      [now],
    )
    await t.db.query(
      "INSERT INTO pages (id, brain_id, address, type, title, created_at, updated_at) VALUES ('pg_a', 'brn_a', 'a', 'topic', 'A', $1, $1)",
      [now],
    )
    await t.db.query(
      `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary) VALUES ('wlg_1', 'brn_a', $1, 'acc_p', 'undo', 'Undone')`,
      [now],
    )
  })
  after(async () => t.drop())

  const rejects = (sql: string, params: unknown[] = []) => assert.rejects(() => t.db.query(sql, params))

  it('a wiki writes in «auto» or «ask_first» only', async () => {
    await t.db.query("INSERT INTO wiki_settings (brain_id, write_mode) VALUES ('brn_a', 'ask_first')")
    await rejects("UPDATE wiki_settings SET write_mode = 'sometimes' WHERE brain_id = 'brn_a'")
  })

  it('a proposal may be applied, partly applied or stale; a part says why it waits', async () => {
    for (const [i, status] of ['applied', 'partially_applied', 'stale'].entries())
      await t.db.query(
        `INSERT INTO proposals (id, brain_id, title, author_id, credential_id, status, created_at)
         VALUES ($1, 'brn_a', 'T', 'acc_p', 'crd_x', $2, $3)`,
        [`prp_${i}`, status, now],
      )
    for (const [i, status] of ['applied', 'stale', 'undone', 'pending'].entries())
      await t.db.query(
        "INSERT INTO proposal_ops (proposal_id, idx, op, status) VALUES ('prp_0', $1, '{}', $2)",
        [i, status],
      )
    for (const reason of ['protected', 'correction', 'ask_first', 'depends'])
      await t.db.query("UPDATE proposal_ops SET hold_reason = $1 WHERE proposal_id = 'prp_0' AND idx = 3", [
        reason,
      ])
    await rejects("UPDATE proposal_ops SET hold_reason = 'whim' WHERE proposal_id = 'prp_0' AND idx = 3")
    await rejects("UPDATE proposals SET status = 'lost' WHERE id = 'prp_0'")
  })

  it('a change for review has a closed list of states; its parts too', async () => {
    await t.db.query(
      `INSERT INTO wiki_changes (id, brain_id, log_id, actor_id, credential_id, created_at)
       VALUES ('chg_1', 'brn_a', 'wlg_1', 'acc_p', 'crd_x', $1)`,
      [now],
    )
    const c = await t.db.one("SELECT state FROM wiki_changes WHERE id = 'chg_1'")
    assert.equal(c?.state, 'pending_review')
    for (const state of ['kept', 'undone', 'partly_undone'])
      await t.db.query("UPDATE wiki_changes SET state = $1 WHERE id = 'chg_1'", [state])
    await rejects("UPDATE wiki_changes SET state = 'forgotten' WHERE id = 'chg_1'")
    await t.db.query(
      `INSERT INTO wiki_change_parts (change_id, part, page_id, created, revision_after, address_after, status_before)
       VALUES ('chg_1', 0, 'pg_a', true, 1, 'a', NULL)`,
    )
    const p = await t.db.one(
      "SELECT state, undone_by_person FROM wiki_change_parts WHERE change_id = 'chg_1'",
    )
    assert.deepEqual({ ...p }, { state: 'applied', undone_by_person: false })
    await rejects("UPDATE wiki_change_parts SET state = 'kept' WHERE change_id = 'chg_1'")
  })

  it('the log and the revisions know «undo»; only the log knows «protect»', async () => {
    await t.db.query(
      `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary) VALUES ('wlg_2', 'brn_a', $1, 'acc_p', 'protect', 'Protected: a')`,
      [now],
    )
    await t.db.query(
      `INSERT INTO page_revisions (page_id, revision, address, type, title, summary, body, tags, status, kind, author_id, credential_id, created_at)
       VALUES ('pg_a', 1, 'a', 'topic', 'A', '', '', '{}', 'current', 'undo', 'acc_p', 'crd_x', $1)`,
      [now],
    )
    await rejects(
      `INSERT INTO page_revisions (page_id, revision, address, type, title, summary, body, tags, status, kind, author_id, credential_id, created_at)
       VALUES ('pg_a', 2, 'a', 'topic', 'A', '', '', '{}', 'current', 'protect', 'acc_p', 'crd_x', $1)`,
      [now],
    )
  })
})
