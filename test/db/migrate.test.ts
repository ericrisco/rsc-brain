import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { migrate, migrationFiles, NewerDatabaseError } from '../../src/db/migrate.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

describe('migration files', () => {
  it('takes only NNNN_name.sql files, in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    try {
      for (const f of ['0002_b.sql', '0001_a.sql', 'README.md', '.gitkeep', '3_bad.sql']) {
        await writeFile(join(dir, f), 'SELECT 1')
      }
      assert.deepEqual(await migrationFiles(dir), ['0001_a.sql', '0002_b.sql'])
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('migrate on postgres', { skip: skipPg }, () => {
  let t: TestDb
  let dir: string
  before(async () => {
    t = await freshDatabase()
    dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeFile(join(dir, '0001_people.sql'), 'CREATE TABLE people (id text PRIMARY KEY)')
    await writeFile(join(dir, '0002_more.sql'), 'ALTER TABLE people ADD COLUMN name text')
  })
  after(async () => {
    await rm(dir, { recursive: true })
    await t.drop()
  })

  it('applies pending migrations once, in order', async () => {
    assert.deepEqual(await migrate(t.db, dir), ['0001_people', '0002_more'])
    assert.deepEqual(await migrate(t.db, dir), [])
    const cols = await t.db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'people' ORDER BY 1",
    )
    assert.deepEqual(
      cols.map((c) => c.column_name),
      ['id', 'name'],
    )
  })

  it('rolls back a failing migration entirely', async () => {
    await writeFile(join(dir, '0003_broken.sql'), 'CREATE TABLE half (id int); SELECT nonsense FROM nowhere')
    await assert.rejects(() => migrate(t.db, dir))
    const half = await t.db.one("SELECT to_regclass('half') AS r")
    assert.equal(half?.r, null)
    const ids = await t.db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')
    assert.deepEqual(
      ids.map((r) => r.id),
      ['0001_people', '0002_more'],
    )
    await rm(join(dir, '0003_broken.sql'))
  })

  it('refuses a database migrated by a newer release', async () => {
    await t.db.query("INSERT INTO schema_migrations (id) VALUES ('9999_future')")
    await assert.rejects(() => migrate(t.db, dir), NewerDatabaseError)
    await t.db.query("DELETE FROM schema_migrations WHERE id = '9999_future'")
  })

  it('lets two migrators run at once without applying anything twice', async () => {
    const t2 = await freshDatabase()
    try {
      const [a, b] = await Promise.all([migrate(t2.db, dir), migrate(t2.db, dir)])
      assert.equal(a.length + b.length, 2)
    } finally {
      await t2.drop()
    }
  })
})
