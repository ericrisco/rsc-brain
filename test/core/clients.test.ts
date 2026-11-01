// Second review of PR23 (S2): the client of a key is named redacted, and only a web session is "web". Each
// place pins it on its own: the name made from a key, the event that stores it, and the SQL that names keys
// written before.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Principal } from '../../src/auth/principal.ts'
import type { Db } from '../../src/db/db.ts'
import { migrate, STEPS } from '../../src/db/migrate.ts'
import { clientNow, clientOfKey } from '../../src/domain/clients.ts'
import { emit } from '../../src/domain/events.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const SECRET = 'sk-live-0123456789abcdefghijklmnopqrstuv'

describe('the client of a key', () => {
  it('is redacted when named from the key', () => {
    const c = clientOfKey({ kind: 'short', agent: `bot ${SECRET}`, clientName: null, program: null })
    assert.ok(c)
    assert.doesNotMatch(c, /0123456789abcdefghij/)
    assert.match(c, /^bot /)
  })

  it('is "web" only for a web session; a key saying "web" is named otherwise', () => {
    assert.equal(clientOfKey({ kind: 'web', agent: null, clientName: null, program: 'Mozilla/5.0' }), 'web')
    assert.equal(
      clientOfKey({ kind: 'token', agent: null, clientName: null, program: 'web', name: 'mine' }),
      'mine',
    )
    assert.equal(
      clientOfKey({ kind: 'token', agent: ' WEB ', clientName: null, program: 'curl/8', name: 'x' }),
      'curl/8',
    )
  })

  it('is redacted again when an event stores it, whatever the principal carries', async () => {
    const sent: unknown[][] = []
    const db = {
      query: async (_t: string, p: unknown[]) => {
        sent.push(p)
        return []
      },
    } as unknown as Db
    const who = {
      accountId: 'acc_1',
      credential: { id: 'crd_1', kind: 'token', ref: null },
      client: `raw ${SECRET}`,
    } as unknown as Principal
    await emit(db, { clock: () => new Date(), who }, { brainId: 'brn_1', kind: 'entry.saved', label: 't' })
    assert.doesNotMatch(JSON.stringify(sent), /0123456789abcdefghij/)
  })
})

describe('the client of a key, from the database', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await world()
  })
  after(async () => w.close())

  it('the SQL names a key that says "web" by another of its names, and redacts it', async () => {
    const eric = await w.person('Eric')
    const insert = async (id: string, agent: string | null, last: string | null, name: string) => {
      await w.db.query(
        `INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, all_brains, created_at,
                                  expires_at, agent, last_client)
         VALUES ($1, $2, 'token', $3, $4, 'abcd', 'write', true, now(), now() + interval '1 day', $5, $6)`,
        [id, eric.id, name, `hash-${id}`, agent, last],
      )
    }
    await insert('crd_webagent', 'web', 'web', 'my token')
    await insert('crd_secret', `bot ${SECRET}`, null, 'n')
    const who = { accountId: eric.id, credential: { id: 'crd_other' } } as unknown as Principal
    assert.equal(await clientNow(w.db, who, 'crd_webagent'), 'my token')
    const red = await clientNow(w.db, who, 'crd_secret')
    assert.ok(red)
    assert.doesNotMatch(String(red), /0123456789abcdefghij/)
  })

  it('a key named with a secret, and a program that says one, are stored redacted', async () => {
    const eric = await w.person('Lia')
    const factory = await w.service('Runner')
    assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'keyed' })).status, 201)
    await w.member('keyed', factory.id, 'contributor')
    const made = await w.call(factory.key, 'POST', '/v1/keys/short', {
      writeBrain: 'keyed',
      perm: 'write',
      ref: 'job-1',
      ttlMinutes: 30,
      name: `job ${SECRET}`,
    })
    assert.equal(made.status, 201, made.text)
    const key = String((made.body as { key: { secret: string } }).key.secret)
    const used = await w.raw('GET', '/v1/brains/keyed', {
      headers: { authorization: `Bearer ${key}`, 'user-agent': `curl ${SECRET}` },
    })
    assert.equal(used.status, 200, used.text)
    const row = await w.db.one<{ name: string; last_client: string }>(
      'SELECT name, last_client FROM credentials WHERE id = $1',
      [(made.body as { key: { id: string } }).key.id],
    )
    assert.ok(row?.last_client, 'the program is remembered')
    assert.doesNotMatch(`${row?.name} ${row?.last_client}`, /0123456789abcdefghij/)
  })

  it('migration 0018 redacts what was stored before: key names and agents, app names, and stored clients', async () => {
    const eric = await w.person('Ana')
    await w.db.query(
      `INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, all_brains, created_at,
                                expires_at, agent, last_client)
       VALUES ('crd_old', $1, 'token', $2, 'hash-old', 'abcd', 'write', true, now(), now() + interval '1 day', $3, $4)`,
      [eric.id, `name ${SECRET}`, `agent ${SECRET}`, `ua ${SECRET}`],
    )
    const b = await w.call(eric.key, 'POST', '/v1/brains', { slug: 'mig' })
    assert.equal(b.status, 201)
    const brain = (await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'mig'")) as {
      id: string
    }
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, label, client) VALUES ($1, now(), 'entry.saved', 'x', $2)`,
      [brain.id, `bot ${SECRET}`],
    )
    // A session and an entry written by a program that said a secret.
    const e = await w.call(eric.key, 'POST', '/v1/brains/mig/entries', {
      type: 'note',
      title: 'Seeded',
      content: 'Seeded.',
    })
    assert.equal(e.status, 201, e.text)
    await w.db.query('UPDATE sessions SET client = $2 WHERE brain_id = $1', [brain.id, `cli ${SECRET}`])
    await w.db.query('UPDATE entries SET client = $2 WHERE brain_id = $1', [brain.id, `cli ${SECRET}`])
    // An app and a connection named with a secret before names were redacted.
    await w.db.query(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, created_at)
       VALUES ('dcr_old', 'dcr', $1, ARRAY['http://127.0.0.1/cb'], now())`,
      [`Notes ${SECRET}`],
    )
    await w.db.query(
      `INSERT INTO oauth_grants (id, client_id, client_name, redirect_host, account_id, brain_ids, perm, refresh_hash,
                                 epoch, created_at, last_used_at, expires_max)
       VALUES ('app_old', 'dcr_old', $1, '127.0.0.1', $2, ARRAY[$3], 'read', 'hash-app-old', 1, now(), now(),
               now() + interval '1 day')`,
      [`Notes ${SECRET}`, eric.id, brain.id],
    )
    const step = STEPS.find((x) => x.id === '0018_redact_clients')
    assert.ok(step, 'the step is known to the migrator')
    await w.db.tx((t) => (step as { run: (d: Db) => Promise<void> }).run(t))
    const left = await w.db.query(
      `SELECT 'credentials.name' AS c FROM credentials WHERE name LIKE $1
       UNION ALL SELECT 'credentials.agent' FROM credentials WHERE agent LIKE $1
       UNION ALL SELECT 'credentials.last_client' FROM credentials WHERE last_client LIKE $1
       UNION ALL SELECT 'events.client' FROM events WHERE client LIKE $1
       UNION ALL SELECT 'sessions.client' FROM sessions WHERE client LIKE $1
       UNION ALL SELECT 'entries.client' FROM entries WHERE client LIKE $1
       UNION ALL SELECT 'oauth_clients.name' FROM oauth_clients WHERE name LIKE $1
       UNION ALL SELECT 'oauth_grants.client_name' FROM oauth_grants WHERE client_name LIKE $1`,
      ['%0123456789abcdefghij%'],
    )
    assert.deepEqual(left, [])
    // What was redacted keeps what was not secret.
    const kept = await w.db.one<{ name: string }>(
      "SELECT name FROM oauth_clients WHERE client_id = 'dcr_old'",
    )
    assert.match(String(kept?.name), /^Notes /)
    // Applied once, and recorded like the SQL migrations (running again changes nothing).
    assert.deepEqual(await migrate(w.db), [])
    const rec = await w.db.one("SELECT id FROM schema_migrations WHERE id = '0018_redact_clients'")
    assert.ok(rec)
  })
})
