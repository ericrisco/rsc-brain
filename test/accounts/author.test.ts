// Spec B7 «Importar» (C17, plan §3.6 and §4, migration 0023): someone named in a faithful export who has no account
// here comes in as an author: a name on what they wrote, never someone who signs in. An author has no email, no
// password, no second factor, no key, no connection and no membership, and the administration does not list or
// change one as a person. Brains remember when and from what they were imported.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { newId } from '../../src/core/ids.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('imported authors (migration 0023)', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let adminWeb: string
  let author: string
  const rejects = (sql: string, params: unknown[]) =>
    assert.rejects(w.db.query(sql, params), (e: { code?: string }) => {
      assert.equal(e.code, '23514', String(e))
      return true
    })

  before(async () => {
    w = await world()
    admin = await w.person('Ada', { isAdmin: true })
    adminWeb = await w.web(admin.id)
    await w.call(admin.key, 'POST', '/v1/brains', { slug: 'past', name: 'Past' })
    author = newId('acc')
    await w.db.query(
      "INSERT INTO accounts (id, kind, name, created_at) VALUES ($1, 'author', 'Old Colleague', now())",
      [author],
    )
  })
  after(async () => w.close())

  it('an author is an account with a name and nothing to sign in with', async () => {
    const a = await w.db.one('SELECT kind, email, password_hash, is_admin FROM accounts WHERE id = $1', [
      author,
    ])
    assert.deepEqual(a, { kind: 'author', email: null, password_hash: null, is_admin: false })
    for (const set of [
      "email = 'old@example.com'",
      "password_hash = 'x'",
      "totp_secret = 'x'",
      "totp_pending = 'x'",
      'is_admin = true',
      'can_create_brains = true',
      'can_invite = true',
    ])
      await rejects(`UPDATE accounts SET ${set} WHERE id = $1`, [author])
  })

  it('an author never has a key, a connection or a membership', async () => {
    const brain = (await w.db.one("SELECT id FROM brains WHERE slug = 'past'"))?.id
    await rejects(
      "INSERT INTO memberships (brain_id, account_id, role, created_at) VALUES ($1, $2, 'reader', now())",
      [brain, author],
    )
    await rejects(
      `INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, created_at, expires_at)
       VALUES ($1, $2, 'token', 'k', $3, 'abcd', 'read', now(), now() + interval '1 day')`,
      [newId('crd'), author, newId('crd')],
    )
    // A key or a membership of someone else cannot be moved to an author either.
    const ada = await w.db.one('SELECT id FROM credentials WHERE account_id = $1 LIMIT 1', [admin.id])
    await rejects('UPDATE credentials SET account_id = $2 WHERE id = $1', [ada?.id, author])
    await rejects('UPDATE memberships SET account_id = $2 WHERE account_id = $1', [admin.id, author])
    await w.db.query(
      "INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, created_at) VALUES ('c1', 'cimd', 'C', '{}', now())",
    )
    await rejects(
      `INSERT INTO oauth_grants (id, client_id, client_name, redirect_host, account_id, brain_ids, perm, refresh_hash,
         epoch, created_at, last_used_at, expires_max)
       VALUES ('g1', 'c1', 'C', 'h', $1, '{}', 'read', 'r', 1, now(), now(), now() + interval '1 day')`,
      [author],
    )
    // A person or a service never becomes an author (their keys and memberships would stay).
    await rejects("UPDATE accounts SET kind = 'author', email = NULL WHERE id = $1", [admin.id])
    await rejects("UPDATE accounts SET kind = 'service' WHERE id = $1", [author])
  })

  it('the web never lets an author in: no session, no key, not a member', async () => {
    const add = await w.callWeb(adminWeb, 'POST', '/v1/brains/past/members', {
      account: author,
      role: 'reader',
    })
    assert.equal(add.status, 400, add.text)
    assert.equal(add.body.error?.code, 'invalid_request')
  })

  it('the administration does not list or change an author as an account', async () => {
    const list = await w.callWeb(adminWeb, 'GET', '/v1/admin/accounts')
    assert.equal(list.status, 200)
    const ids = (list.body.accounts as { id: string }[]).map((a) => a.id)
    assert.ok(ids.includes(admin.id))
    assert.ok(!ids.includes(author))
    for (const [method, path, body] of [
      ['PATCH', `/v1/admin/accounts/${author}`, { canInvite: true }],
      ['POST', `/v1/admin/accounts/${author}/remove`, undefined],
      ['POST', `/v1/admin/accounts/${author}/restore`, undefined],
      ['GET', `/v1/admin/accounts/${author}/keys`, undefined],
    ] as const) {
      const r = await w.callWeb(adminWeb, method, path, body)
      assert.equal(r.status, 404, `${method} ${path}: ${r.text}`)
    }
  })

  it('a brain says when and from what it was imported', async () => {
    const b = await w.db.one("SELECT imported_at, imported_from FROM brains WHERE slug = 'past'")
    assert.deepEqual(b, { imported_at: null, imported_from: null })
    await w.db.query("UPDATE brains SET imported_at = now(), imported_from = 'docs.zip' WHERE slug = 'past'")
    await rejects("UPDATE brains SET imported_from = repeat('x', 201) WHERE slug = 'past'", [])
  })

  it('an import is a kind of wiki change: in the log and in the history of a page', async () => {
    const brain = (await w.db.one("SELECT id FROM brains WHERE slug = 'past'"))?.id
    await w.db.query(
      "INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary) VALUES ($1, $2, now(), $3, 'import', 'Imported')",
      [newId('wlg'), brain, admin.id],
    )
    const page = newId('pg')
    await w.db.query(
      `INSERT INTO pages (id, brain_id, address, type, title, created_at, updated_at)
       VALUES ($1, $2, 'a', 'topic', 'A', now(), now())`,
      [page, brain],
    )
    await w.db.query(
      `INSERT INTO page_revisions (page_id, revision, address, type, title, summary, body, tags, status, kind,
         author_id, credential_id, created_at)
       VALUES ($1, 1, 'a', 'topic', 'A', '', '', '{}', 'current', 'import', $2, 'crd_x', now())`,
      [page, author],
    )
  })
})
