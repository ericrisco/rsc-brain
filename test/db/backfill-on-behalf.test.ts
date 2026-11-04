// Migration 0024 (F1-PR13): an agent's entry written with a short key «on behalf of» a person, before that was
// kept (src/domain/entries.ts, agentWriter), gets that person back from its key. Only where it can be derived:
// the entry's credential still exists, is a short key, and names someone. Run twice, it changes nothing more.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { MIGRATIONS_DIR } from '../../src/db/migrate.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const FILE = '0024_entries_on_behalf.sql'

describe('migration 0024: on behalf of, for the entries written before it was kept', { skip: skipPg }, () => {
  let w: World
  let ana: { id: string; key: string }
  let ben: { id: string; key: string }
  let factory: { id: string; key: string }
  before(async () => {
    w = await world()
    const eric = await w.person('Eric', { isAdmin: true })
    ana = await w.person('Ana')
    ben = await w.person('Ben')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'project' })
    await w.member('project', factory.id, 'contributor')
    await w.member('project', ben.id, 'contributor')
  })
  after(async () => w.close())

  const emailOf = async (id: string) =>
    String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [id]))?.email)
  const short = async (onBehalf?: string) => {
    const r = await w.call(factory.key, 'POST', '/v1/keys/short', {
      writeBrain: 'project',
      ref: 'run r_b step 1',
      ttlMinutes: 10,
      ...(onBehalf ? { onBehalf: await emailOf(onBehalf) } : {}),
    })
    assert.equal(r.status, 201, r.text)
    return r.body.key as { id: string; secret: string }
  }
  const save = async (key: string, title: string) => {
    const r = await w.call(key, 'POST', '/v1/brains/project/entries', {
      type: 'step',
      title,
      content: `${title}.`,
    })
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as { entryId: string }).entryId
  }
  const onBehalf = async (id: string) =>
    (await w.db.one('SELECT on_behalf_id FROM entries WHERE id = $1', [id]))?.on_behalf_id ?? null

  it('is one of the migrations, applied', async () => {
    const row = await w.db.one('SELECT id FROM schema_migrations WHERE id = $1', [FILE.slice(0, -4)])
    assert.ok(row)
  })

  it('fills the person from a short key that names one; leaves what it cannot derive; twice is once', async () => {
    const forAna = await short(ana.id)
    const forNobody = await short()
    const old = await save(forAna.secret, 'Before the fix, for Ana')
    const nobody = await save(forNobody.secret, 'For nobody')
    const token = await save(ben.key, 'Ben with his own token')
    // A key gone (its row deleted: the entry keeps no credential) and a person already named stay as they are.
    const gone = await save((await short(ana.id)).secret, 'Its key gone')
    const named = await save((await short(ana.id)).secret, 'Named already')
    // As before the fix: nobody kept.
    await w.db.query('UPDATE entries SET on_behalf_id = NULL WHERE id = ANY($1)', [[old, gone]])
    await w.db.query('UPDATE entries SET credential_id = NULL WHERE id = $1', [gone])
    await w.db.query('UPDATE entries SET on_behalf_id = $2 WHERE id = $1', [named, ben.id])
    const sql = await readFile(`${MIGRATIONS_DIR}${FILE}`, 'utf8')
    await w.db.query(sql)
    assert.equal(await onBehalf(old), ana.id)
    assert.equal(await onBehalf(nobody), null)
    assert.equal(await onBehalf(token), null)
    assert.equal(await onBehalf(gone), null)
    assert.equal(await onBehalf(named), ben.id)
    const before = await w.db.query('SELECT id, on_behalf_id, updated_at FROM entries ORDER BY id')
    await w.db.query(sql)
    assert.deepEqual(await w.db.query('SELECT id, on_behalf_id, updated_at FROM entries ORDER BY id'), before)
  })
})
