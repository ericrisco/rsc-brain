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
