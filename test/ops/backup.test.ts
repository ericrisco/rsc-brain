// Copies against a real PostgreSQL (spec B7 «Copias y restauración», CA9b, CA10; plan §3.3, risk 2): a copy
// holds every table in one snapshot, encrypted with the installation key; it is written to `.part` and renamed
// only when whole, so a full disk leaves nothing that looks like a copy and the failure is said in status.json;
// two copies never run at once; and a copy before an update waits for writes that slipped in before
// maintenance began.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { gunzipSync } from 'node:zlib'
import pg from 'pg'
import { seal } from '../../src/auth/vault.ts'
import { AppError } from '../../src/core/errors.ts'
import { maintenance } from '../../src/domain/maintenance.ts'
import { type BackupInfo, backup, type FileOps, readStatus } from '../../src/ops/backup/backup.ts'
import { keyId, openBackup, readHeader, readSections } from '../../src/ops/backup/format.ts'
import { BACKUP_TABLES, LOAD_ORDER_EXCEPTIONS, SKIP } from '../../src/ops/backup/tables.ts'
import { skipPg } from '../helpers/pg.ts'
import { TEST_SECRET, type World, world } from '../helpers/world.ts'

const OTHER_SECRET = 'another-installation-key-of-thirty-two-chars-or-more'
const CANARIES = {
  entry: 'CANARY-ENTRY-CONTENT-5e1d0a',
  page: 'CANARY-PAGE-BODY-0b7c33',
  name: 'Canaryname Personsurname',
  email: 'canary.person.b7@example.org',
  audit: 'CANARY-AUDIT-DETAIL-9a4f21',
  provider: 'sk-canary-provider-key-77aa55',
}

type Table = { table: string; columns: string[]; rows: Array<Array<string | null>> }
async function sections(path: string, secret = TEST_SECRET): Promise<Table[]> {
  const out: Table[] = []
  for await (const ev of readSections(await openBackup(path, secret))) {
    if (ev.kind === 'table') out.push({ table: ev.table, columns: ev.columns, rows: [] })
    else out[out.length - 1]?.rows.push(ev.values)
  }
  return out
}

const isCode = (code: string) => (err: unknown) => {
  assert.ok(err instanceof AppError, String(err))
  assert.equal(err.code, code)
  return true
}

describe('backups on PostgreSQL', { skip: skipPg }, () => {
  let w: World
  let dir: string
  const files = async () => (await readdir(dir)).filter((f) => f !== 'status.json').sort()

  before(async () => {
    w = await world()
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-backups-'))
    const p = await w.person('Canary', { name: CANARIES.name, email: CANARIES.email, isAdmin: true })
    assert.equal((await w.call(p.key, 'POST', '/v1/brains', { slug: 'canary' })).status, 201)
    const e = await w.call(p.key, 'POST', '/v1/brains/canary/entries', {
      type: 'note',
      title: 'A note',
      content: `${CANARIES.entry}\twith a tab\nand a line`,
    })
    assert.equal(e.status, 201)
    const brain = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'canary'")
    await w.db.query(
      `INSERT INTO pages (id, brain_id, address, type, title, body, created_at, updated_at)
       VALUES ('pag_canary0001', $1, 'canary', 'topic', 'Canary', $2, now(), now())`,
      [brain?.id, CANARIES.page],
    )
    await w.db.query(
      "INSERT INTO audit (at, action, outcome, detail) VALUES (now(), 'test.canary', 'ok', $1)",
      [CANARIES.audit],
    )
    await w.db.query('UPDATE meaning_settings SET openai_key = $1', [
      seal(TEST_SECRET, CANARIES.provider, 'meaning.openai'),
    ])
  })
  after(async () => {
    await w.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('risk 2: every table is copied or skipped with a written reason; every column of a copied table is in it', async () => {
    const tables = (
      await w.db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'")
    ).map((r) => r.t)
    const copied = BACKUP_TABLES.map((t) => t.name)
    assert.equal(new Set(copied).size, copied.length, 'a table is listed twice')
    for (const t of copied) assert.ok(!(t in SKIP), `${t} is both copied and skipped`)
    for (const [t, why] of Object.entries(SKIP)) assert.ok(why.length >= 30, `${t} has no reason`)
    assert.deepEqual([...copied, ...Object.keys(SKIP)].sort(), [...tables].sort())
    for (const t of BACKUP_TABLES) {
      const cols = await w.db.query<{ c: string }>(
        `SELECT a.attname AS c FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''`,
        [t.name],
      )
      assert.deepEqual([...t.columns].sort(), cols.map((r) => r.c).sort(), `columns of ${t.name}`)
      assert.ok(t.order.length > 0 && t.order.every((c) => t.columns.includes(c)), `order of ${t.name}`)
    }
  })

  it('tables are listed parents first, so a restore loads them in this order (but the named exceptions)', async () => {
    const fks = await w.db.query<{ child: string; parent: string }>(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
         FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    )
    const at = new Map(BACKUP_TABLES.map((t, i) => [t.name, i]))
    for (const { child, parent } of fks) {
      if (child === parent || !at.has(child)) continue
      if (LOAD_ORDER_EXCEPTIONS.some((x) => x.child === child && x.parent === parent)) continue
      assert.ok((at.get(parent) ?? -1) < (at.get(child) ?? -1), `${parent} must come before ${child}`)
    }
  })

  let first: BackupInfo
  it('a copy holds every table of the snapshot, row for row, and reads back with the key', async () => {
    first = await backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock })
    assert.match(first.file, /^rsc-brain-20261029T100000Z-manual\.rscb$/)
    assert.equal(first.keyId, keyId(TEST_SECRET))
    assert.deepEqual(await files(), [first.file])
    const path = join(dir, first.file)
    assert.equal((await stat(path)).size, first.bytes)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const h = await readHeader(path)
    assert.equal(h.reason, 'manual')
    assert.equal(h.installation.name, 'Test')
    const applied = await w.db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')
    assert.deepEqual(
      h.migrations,
      applied.map((r) => r.id),
    )
    assert.ok(h.lastWriteAt)
    const got = await sections(path)
    assert.deepEqual(
      got.map((s) => s.table),
      BACKUP_TABLES.map((t) => t.name),
    )
    for (const s of got) {
      const n = await w.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${s.table}`)
      assert.equal(s.rows.length, n?.n, `rows of ${s.table}`)
      assert.equal(h.tables.find((t) => t.name === s.table)?.rows, n?.n)
    }
    // Values come back exactly, tabs and new lines included.
    const entries = got.find((s) => s.table === 'entries') as Table
    const content = entries.columns.indexOf('content')
    assert.ok(entries.rows.some((r) => r[content] === `${CANARIES.entry}\twith a tab\nand a line`))
    const seqs = h.sequences.map((s) => s.name)
    assert.ok(seqs.includes('audit_id_seq') && seqs.includes('events_seq'))
  })

  it('every value comes back as PostgreSQL itself writes it, nulls as nulls', async () => {
    const got = await sections(join(dir, first.file))
    let nulls = 0
    await w.db.tx(async (tx) => {
      for (const s of [
        "SET LOCAL TimeZone = 'UTC'",
        "SET LOCAL DateStyle = 'ISO, YMD'",
        "SET LOCAL bytea_output = 'hex'",
        'SET LOCAL extra_float_digits = 1',
      ])
        await tx.query(s)
      for (const t of BACKUP_TABLES) {
        const rows = await tx.query<Record<string, string | null>>(
          `SELECT ${t.columns.map((c, i) => `"${c}"::text AS c${i}`).join(', ')} FROM "${t.name}"
            ORDER BY ${t.order.map((c) => `"${c}"`).join(', ')}`,
        )
        const want = rows.map((r) => t.columns.map((_, i) => r[`c${i}`] ?? null))
        const have = got.find((x) => x.table === t.name) as Table
        assert.deepEqual(have.columns, t.columns)
        assert.deepEqual(have.rows, want, `values of ${t.name}`)
        nulls += want.flat().filter((v) => v === null).length
      }
    })
    assert.ok(nulls > 0, 'the data has nulls to compare')
  })

  it('CA9b: no entry, page, name, email, audit text or provider key is readable in the file, nor in any gunzip of it', async () => {
    const file = await readFile(join(dir, first.file))
    const views = [file.toString('utf8'), file.toString('latin1')]
    for (let i = 0; i + 1 < file.length; i += 1) {
      if (file[i] === 0x1f && file[i + 1] === 0x8b) {
        try {
          views.push(gunzipSync(file.subarray(i)).toString('utf8'))
        } catch {}
      }
    }
    for (const v of views) {
      for (const c of Object.values(CANARIES)) assert.ok(!v.includes(c), `"${c}" is readable`)
      assert.ok(!v.includes(TEST_SECRET))
    }
  })

  it('CA20: read with another key, it says which key it needs', async () => {
    await assert.rejects(
      () => openBackup(join(dir, first.file), OTHER_SECRET),
      (err: unknown) => isCode('wrong_key')(err) && (err as AppError).extra?.needs === keyId(TEST_SECRET),
    )
  })

  it('status.json says the last good copy and the key id, with no failure', async () => {
    const s = await readStatus(dir)
    assert.deepEqual(s.lastOk, { at: '2026-10-29T10:00:00.000Z', file: first.file })
    assert.equal(s.lastFailure, null)
    assert.equal(s.keyId, keyId(TEST_SECRET))
    assert.equal((await stat(join(dir, 'status.json'))).mode & 0o777, 0o600)
  })

  it('CA10: the disk fills halfway → no .part, no copy, the list unchanged, lastFailure disk_full', async () => {
    w.advance(60_000)
    const before = await backup.list(dir)
    let written = 0
    const full: FileOps = {
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          async write(b) {
            if (written > 2000) {
              const e = new Error('no space left on device') as NodeJS.ErrnoException
              e.code = 'ENOSPC'
              throw e
            }
            written += b.length
            await real.write(b)
          },
          sync: () => real.sync(),
          close: () => real.close(),
        }
      },
    }
    await assert.rejects(
      () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock, files: full }),
      isCode('disk_full'),
    )
    assert.ok(written > 0, 'the copy had started writing')
    assert.deepEqual(await files(), [first.file])
    assert.deepEqual(await backup.list(dir), before)
    const s = await readStatus(dir)
    assert.deepEqual(s.lastFailure, { at: '2026-10-29T10:01:00.000Z', category: 'disk_full' })
    assert.deepEqual(s.lastOk, { at: '2026-10-29T10:00:00.000Z', file: first.file })
  })

  it('any other failure while writing also leaves nothing, and says it failed', async () => {
    w.advance(60_000)
    const broken: FileOps = {
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          write: (b) => real.write(b),
          sync: async () => {
            throw Object.assign(new Error('i/o error'), { code: 'EIO' })
          },
          close: () => real.close(),
        }
      },
    }
    await assert.rejects(() =>
      backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock, files: broken }),
    )
    assert.deepEqual(await files(), [first.file])
    assert.equal((await readStatus(dir)).lastFailure?.category, 'failed')
  })

  it('a good copy clears the failure', async () => {
    w.advance(60_000)
    const c = await backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock })
    const s = await readStatus(dir)
    assert.equal(s.lastFailure, null)
    assert.equal(s.lastOk?.file, c.file)
    await rm(join(dir, c.file))
  })

  it('without the installation key no copy is made, and the failure says why', async () => {
    w.advance(60_000)
    await assert.rejects(
      () => backup.create(w.db, { dir, secret: undefined, reason: 'scheduled', clock: w.clock }),
      isCode('no_installation_secret'),
    )
    assert.deepEqual(await files(), [first.file])
    assert.equal((await readStatus(dir)).lastFailure?.category, 'no_installation_secret')
  })

  it('two copies never overlap: the second is refused with backup_running while the first writes', async () => {
    w.advance(60_000)
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let started!: () => void
    const writing = new Promise<void>((r) => {
      started = r
    })
    const slow: FileOps = {
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          async write(b) {
            started()
            await held
            await real.write(b)
          },
          sync: () => real.sync(),
          close: () => real.close(),
        }
      },
    }
    const one = backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: slow,
    })
    const statusBefore = await readStatus(dir)
    try {
      await writing
      // While it is written it is only a .part: nothing in the list, no .rscb of it.
      const writingNow = await files()
      assert.equal(writingNow.length, 2)
      assert.ok(writingNow.includes(first.file))
      assert.ok(writingNow.some((f) => f.endsWith('.rscb.part')))
      assert.deepEqual(
        (await backup.list(dir)).map((b) => b.file),
        [first.file],
      )
      w.advance(1000)
      await assert.rejects(
        () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock }),
        isCode('backup_running'),
      )
      // Refused, not failed: status.json is left as it was.
      assert.deepEqual(await readStatus(dir), statusBefore)
    } finally {
      // Released whatever happens above, so a failure never leaves the first copy waiting.
      release()
    }
    const made = await one
    // The refused one is not a failed copy.
    assert.equal((await readStatus(dir)).lastFailure, null)
    assert.deepEqual(await files(), [first.file, made.file].sort())
    await rm(join(dir, made.file))
  })

  it('a .part left by a copy that died is cleared by the next copy', async () => {
    w.advance(60_000)
    const stale = join(dir, 'rsc-brain-20261029T090000Z-scheduled.rscb.part')
    await writeFile(stale, 'half a copy')
    assert.ok((await backup.list(dir)).every((b) => !b.file.endsWith('.part')))
    const c = await backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock })
    assert.deepEqual(await files(), [first.file, c.file].sort())
    await rm(join(dir, c.file))
  })

  it('a copy before an update needs maintenance on', async () => {
    w.advance(60_000)
    await assert.rejects(
      () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'pre-update', clock: w.clock }),
      isCode('not_in_maintenance'),
    )
    assert.deepEqual(await files(), [first.file])
  })

  it('a copy before an update waits for a write that began before maintenance, and holds it', async () => {
    w.advance(60_000)
    const late = new pg.Client({ connectionString: w.url })
    await late.connect()
    try {
      await late.query('BEGIN')
      await late.query(
        "INSERT INTO audit (at, action, outcome, detail) VALUES (now(), 'test.late', 'ok', 'written late')",
      )
      await maintenance.on(w.db, w.clock(), { reason: 'update' })
      setTimeout(() => void late.query('COMMIT'), 600)
      const t0 = Date.now()
      const c = await backup.create(w.db, {
        dir,
        secret: TEST_SECRET,
        reason: 'pre-update',
        clock: w.clock,
        settleMs: 50,
      })
      assert.ok(Date.now() - t0 >= 500, 'it waited for the open write')
      const audit = (await sections(join(dir, c.file))).find((s) => s.table === 'audit') as Table
      const action = audit.columns.indexOf('action')
      assert.ok(
        audit.rows.some((r) => r[action] === 'test.late'),
        'the late write is in the copy',
      )
      await rm(join(dir, c.file))
    } finally {
      await maintenance.off(w.db)
      await late.end()
    }
  })

  it('a copy of a database with migrations this release does not know is refused', async () => {
    w.advance(60_000)
    await w.db.query("INSERT INTO schema_migrations (id) VALUES ('9999_from_the_future')")
    try {
      await assert.rejects(
        () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock }),
        isCode('schema_mismatch'),
      )
    } finally {
      await w.db.query("DELETE FROM schema_migrations WHERE id = '9999_from_the_future'")
    }
    assert.deepEqual(await files(), [first.file])
  })

  it('CA8 with real copies: prune keeps the newest scheduled ones and never touches the others', async () => {
    const made: string[] = []
    for (let i = 0; i < 3; i += 1) {
      w.advance(24 * 3600_000)
      made.push(
        (await backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'scheduled', clock: w.clock })).file,
      )
    }
    const removed = await backup.prune(dir, 2)
    assert.deepEqual(removed, [made[0]])
    assert.deepEqual(await files(), [first.file, made[1], made[2]].sort())
    const list = await backup.list(dir)
    assert.deepEqual(
      list.map((b) => b.file),
      [made[2], made[1], first.file],
    )
    assert.deepEqual(Object.keys(list[0] as object).sort(), [
      'bytes',
      'createdAt',
      'file',
      'id',
      'keyId',
      'reason',
    ])
  })
})
