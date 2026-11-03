// Copies against a real PostgreSQL (spec B7 «Copias y restauración», CA9b, CA10; plan §3.3, risk 2): a copy
// holds every table in one snapshot, encrypted with the installation key; it is written to `.part` and renamed
// only when whole, so a full disk leaves nothing that looks like a copy and the failure is said in status.json;
// two copies never run at once; and a copy before an update waits for writes that slipped in before
// maintenance began.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { gunzipSync } from 'node:zlib'
import pg from 'pg'
import { seal } from '../../src/auth/vault.ts'
import { AppError } from '../../src/core/errors.ts'
import { makeLog } from '../../src/core/log.ts'
import { maintenance } from '../../src/domain/maintenance.ts'
import {
  type BackupInfo,
  backup,
  backupJob,
  backupName,
  type FileOps,
  readStatus,
} from '../../src/ops/backup/backup.ts'
import { keyId, openBackup, readHeader, readSections, writeBackup } from '../../src/ops/backup/format.ts'
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
    // First the counts and the sequences (review of PR #29: inside the encryption, never in the header), then
    // every table in load order.
    assert.deepEqual(
      got.map((s) => s.table),
      ['_tables', '_sequences', ...BACKUP_TABLES.map((t) => t.name)],
    )
    assert.deepEqual(
      h.tables,
      BACKUP_TABLES.map((t) => t.name),
    )
    const counted = got[0] as Table
    assert.deepEqual(counted.columns, ['name', 'rows'])
    for (const s of got.slice(2)) {
      const n = await w.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${s.table}`)
      assert.equal(s.rows.length, n?.n, `rows of ${s.table}`)
      assert.deepEqual(
        counted.rows.find((r) => r[0] === s.table),
        [s.table, String(n?.n)],
      )
    }
    const raw = await readFile(path)
    const header = raw.subarray(10, 10 + raw.readUInt32BE(6)).toString('utf8')
    for (const word of ['"rows"', 'audit_id_seq', 'last_value', 'is_called'])
      assert.ok(!header.includes(word), `${word} in the readable header`)
    // Values come back exactly, tabs and new lines included.
    const entries = got.find((s) => s.table === 'entries') as Table
    const content = entries.columns.indexOf('content')
    assert.ok(entries.rows.some((r) => r[content] === `${CANARIES.entry}\twith a tab\nand a line`))
    // Sequences as setval takes them: a used one with its value and is_called true; one never used says so,
    // with the value it would hand out first (never a 0 that setval refuses).
    const seqs = got[1] as Table
    assert.deepEqual(seqs.columns, ['name', 'last_value', 'is_called'])
    const audit = seqs.rows.find((r) => r[0] === 'audit_id_seq')
    assert.equal(audit?.[2], 't')
    assert.ok(Number(audit?.[1]) >= 1)
    const unused = seqs.rows.find((r) => r[0] === 'mail_log_id_seq')
    assert.deepEqual(unused, ['mail_log_id_seq', '1', 'f'])
    assert.ok(seqs.rows.some((r) => r[0] === 'events_seq'))
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
      ...backup.diskFiles,
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          async write(b, offset, length) {
            // The header goes out; the first frame meets a full disk.
            if (written > 0) {
              const e = new Error('no space left on device') as NodeJS.ErrnoException
              e.code = 'ENOSPC'
              throw e
            }
            written += length
            return real.write(b, offset, length)
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
      ...backup.diskFiles,
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          write: (b, offset, length) => real.write(b, offset, length),
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

  it('review of PR #29 (blocker): writes that take only part of a buffer still give a whole copy', async () => {
    w.advance(60_000)
    const dribble: FileOps = {
      ...backup.diskFiles,
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          // At most 97 bytes per write, as a nearly full disk may do without an error.
          write: (b, offset, length) => real.write(b, offset, Math.min(length, 97)),
          sync: () => real.sync(),
          close: () => real.close(),
        }
      },
    }
    const c = await backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: dribble,
    })
    assert.equal((await stat(join(dir, c.file))).size, c.bytes)
    const got = await sections(join(dir, c.file))
    assert.equal(got.length, BACKUP_TABLES.length + 2)
    await rm(join(dir, c.file))
  })

  it('review of PR #29 (blocker): bytes lost on the way to disk → the copy is never renamed, listed or called kept', async () => {
    w.advance(60_000)
    const before = await backup.list(dir)
    let calls = 0
    const lossy: FileOps = {
      ...backup.diskFiles,
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          // Says it wrote everything; the second write (the first frame) loses its last 10 bytes.
          async write(b, offset, length) {
            calls += 1
            if (calls === 2) await real.write(b, offset, Math.max(0, length - 10))
            else await real.write(b, offset, length)
            return { bytesWritten: length }
          },
          sync: () => real.sync(),
          close: () => real.close(),
        }
      },
    }
    await assert.rejects(
      () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock, files: lossy }),
      isCode('disk_full'),
    )
    assert.deepEqual(await files(), [first.file])
    assert.deepEqual(await backup.list(dir), before)
    assert.equal((await readStatus(dir)).lastFailure?.category, 'disk_full')
  })

  it('review of PR #29 (blocker): a rename that fails leaves nothing; a failure after the rename keeps the whole copy and says so', async () => {
    w.advance(60_000)
    const noRename: FileOps = {
      ...backup.diskFiles,
      rename: async () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    }
    await assert.rejects(
      () =>
        backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock, files: noRename }),
      isCode('disk_full'),
    )
    assert.deepEqual(await files(), [first.file])
    w.advance(60_000)
    const noDirSync: FileOps = {
      ...backup.diskFiles,
      syncDir: async () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    }
    const c = await backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: noDirSync,
    })
    assert.ok(c.warning && /kept/.test(c.warning), c.warning)
    assert.ok((await backup.list(dir)).some((b) => b.file === c.file))
    assert.equal((await sections(join(dir, c.file))).length, BACKUP_TABLES.length + 2)
    await rm(join(dir, c.file))
  })

  it('review of PR #29: status.json that cannot be written after a good copy → "copy kept, status not saved"; the next status is right', async () => {
    w.advance(60_000)
    const noStatus: FileOps = {
      ...backup.diskFiles,
      status: async () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    }
    const before = await readStatus(dir)
    const kept = await backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: noStatus,
    })
    assert.match(kept.warning ?? '', /copy is kept.*status.*not saved/i)
    assert.deepEqual(await readStatus(dir), before)
    // The next copy fails and its status is written: the last good copy is the one above, not an older one.
    w.advance(60_000)
    const full: FileOps = {
      ...backup.diskFiles,
      open: async () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    }
    await assert.rejects(() =>
      backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock, files: full }),
    )
    const s = await readStatus(dir)
    assert.deepEqual(s.lastOk, { at: kept.createdAt, file: kept.file })
    assert.equal(s.lastFailure?.category, 'disk_full')
    await rm(join(dir, kept.file))
  })

  it('review of PR #29: status.json is written through a temporary file of its own, never followed through a link', async () => {
    w.advance(60_000)
    const seen: string[] = []
    const watch: FileOps = {
      ...backup.diskFiles,
      status: async (path) => {
        seen.push(path)
        return backup.diskFiles.status(path)
      },
    }
    const c = await backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: watch,
    })
    assert.equal(seen.length, 1)
    assert.match(seen[0] as string, /\/status\.json\.\d+\.[0-9a-f]{16}\.tmp$/)
    assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')))
    // The default opener refuses a path that exists (a planted link included).
    const planted = join(dir, 'status.json.1.0000000000000000.tmp')
    await symlink(join(dir, 'elsewhere'), planted)
    await assert.rejects(() => backup.diskFiles.status(planted), /EEXIST/)
    await rm(planted)
    await rm(join(dir, c.file))
  })

  it('review of PR #29: a weak installation key makes no copy, and says why', async () => {
    w.advance(60_000)
    await assert.rejects(
      () => backup.create(w.db, { dir, secret: 'x'.repeat(31), reason: 'manual', clock: w.clock }),
      isCode('weak_installation_key'),
    )
    assert.deepEqual(await files(), [first.file])
    assert.equal((await readStatus(dir)).lastFailure?.category, 'weak_installation_key')
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
      ...backup.diskFiles,
      async open(path) {
        const real = await backup.diskFiles.open(path)
        return {
          async write(b, offset, length) {
            started()
            await held
            return real.write(b, offset, length)
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
      assert.ok(writingNow.some((f) => /\.rscb\.\d+\.[0-9a-f]{16}\.part$/.test(f)))
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

  it('a .part left by a copy that died more than an hour ago is cleared by the next copy; a recent one is left', async () => {
    w.advance(60_000)
    const stale = join(dir, 'rsc-brain-20261029T090000Z-scheduled.rscb.123.00112233445566aa.part')
    const old = join(dir, 'rsc-brain-20261029T080000Z-scheduled.rscb.part')
    const recent = join(dir, 'rsc-brain-20261029T095900Z-scheduled.rscb.456.00112233445566bb.part')
    for (const f of [stale, old, recent]) await writeFile(f, 'half a copy')
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
    await utimes(stale, twoHoursAgo, twoHoursAgo)
    await utimes(old, twoHoursAgo, twoHoursAgo)
    assert.ok((await backup.list(dir)).every((b) => !b.file.endsWith('.part')))
    const c = await backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock })
    assert.deepEqual(await files(), [first.file, c.file, recent.slice(dir.length + 1)].sort())
    await rm(join(dir, c.file))
    await rm(recent)
  })

  // A rename held until the test lets it go, to look at the folder while one copy is between its snapshot and
  // its place.
  function pausedRename(): { files: FileOps; renaming: Promise<void>; release(): void; parts: string[] } {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let started!: () => void
    const renaming = new Promise<void>((r) => {
      started = r
    })
    const parts: string[] = []
    return {
      files: {
        ...backup.diskFiles,
        async open(path) {
          parts.push(path)
          return backup.diskFiles.open(path)
        },
        async rename(from, to) {
          started()
          await held
          return backup.diskFiles.rename(from, to)
        },
      },
      renaming,
      release,
      parts,
    }
  }

  it('second pass: one copy at a time until it is in place — another copy meanwhile is refused and sweeps nothing', async () => {
    w.advance(60_000)
    const p = pausedRename()
    const one = backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: p.files,
    })
    try {
      await p.renaming
      // The .part is unique to this copy.
      assert.match(p.parts[0] as string, /\.rscb\.\d+\.[0-9a-f]{16}\.part$/)
      w.advance(1000)
      await assert.rejects(
        () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock }),
        isCode('backup_running'),
      )
      assert.ok(
        (await readdir(dir)).includes((p.parts[0] as string).slice(dir.length + 1)),
        'its .part is still there',
      )
    } finally {
      p.release()
    }
    const made = await one
    assert.equal((await sections(join(dir, made.file))).length, BACKUP_TABLES.length + 2)
    assert.ok((await backup.list(dir)).some((b) => b.file === made.file))
    await rm(join(dir, made.file))
  })

  it('second pass: two copies at the same second with the same reason — the second never touches the first', async () => {
    w.advance(60_000)
    const p = pausedRename()
    const one = backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: p.files,
    })
    try {
      await p.renaming
      await assert.rejects(
        () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock }),
        isCode('backup_running'),
      )
    } finally {
      p.release()
    }
    const made = await one
    const size = (await stat(join(dir, made.file))).size
    await assert.rejects(
      () => backup.create(w.db, { dir, secret: TEST_SECRET, reason: 'manual', clock: w.clock }),
      isCode('backup_exists'),
    )
    assert.equal((await stat(join(dir, made.file))).size, size)
    assert.equal((await sections(join(dir, made.file))).length, BACKUP_TABLES.length + 2)
    await rm(join(dir, made.file))
  })

  it('second pass: the job of serve answers busy while another copy runs, so the scheduler tries again', async () => {
    w.advance(60_000)
    const p = pausedRename()
    const one = backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: p.files,
    })
    try {
      await p.renaming
      w.advance(1000)
      const job = backupJob(w.db, {
        dir,
        secret: TEST_SECRET,
        keep: 99,
        clock: w.clock,
        log: makeLog(() => {}),
      })
      assert.equal(await job(), 'busy')
    } finally {
      p.release()
    }
    await rm(join(dir, (await one).file))
  })

  it('second pass: the job of serve says a kept copy with a warning in the log, and the next status records it', async () => {
    w.advance(60_000)
    const lines: string[] = []
    const log = makeLog((l) => lines.push(l))
    const noStatus: FileOps = {
      ...backup.diskFiles,
      status: async () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    }
    const warnedAt = w.clock().toISOString()
    const statusBefore = await readStatus(dir)
    const job = backupJob(w.db, { dir, secret: TEST_SECRET, keep: 99, clock: w.clock, log, files: noStatus })
    await job()
    const warned = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'backup_kept_with_warning')
    assert.deepEqual(
      warned.map((l) => [l.level, l.code]),
      [['warn', 'disk_full']],
    )
    assert.deepEqual(await readStatus(dir), statusBefore, 'status could not be written then')
    // The same job, the disk fine again: its next status says what happened.
    w.advance(60_000)
    job.files = backup.diskFiles
    await job()
    assert.deepEqual((await readStatus(dir)).lastWarning, { at: warnedAt, code: 'disk_full' })
    for (const b of await backup.list(dir)) if (b.reason === 'scheduled') await rm(join(dir, b.file))
  })

  it('second pass: a folder that cannot be flushed is recorded as lastWarning fsync_failed', async () => {
    w.advance(60_000)
    const noDirSync: FileOps = {
      ...backup.diskFiles,
      syncDir: async () => {
        throw Object.assign(new Error('i/o'), { code: 'EIO' })
      },
    }
    const c = await backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: noDirSync,
    })
    assert.deepEqual((await readStatus(dir)).lastWarning, { at: c.createdAt, code: 'fsync_failed' })
    await rm(join(dir, c.file))
  })

  it('second pass: a copy dated in the future (beyond 5 minutes) is never taken as the last good one nor the last daily one', async () => {
    w.advance(60_000)
    const future = new Date('2030-01-01T03:00:00Z')
    const name = backupName(future, 'scheduled')
    const parts: Buffer[] = []
    async function* rows() {
      yield Buffer.from('x')
    }
    await writeBackup(
      async (b) => void parts.push(Buffer.from(b)),
      {
        release: '0.1.0',
        migrations: [],
        createdAt: future.toISOString(),
        installation: { id: 1, name: 'T' },
        reason: 'scheduled',
        tables: [],
        lastWriteAt: null,
      },
      rows(),
      TEST_SECRET,
    )
    await writeFile(join(dir, name), Buffer.concat(parts))
    try {
      const last = await backup.lastScheduledAt(dir, w.clock())
      assert.ok(last === null || last.getTime() <= w.clock().getTime(), String(last))
      const before = await readStatus(dir)
      await assert.rejects(() =>
        backup.create(w.db, { dir, secret: undefined, reason: 'manual', clock: w.clock }),
      )
      assert.deepEqual((await readStatus(dir)).lastOk, before.lastOk)
      assert.notEqual((await readStatus(dir)).lastOk?.file, name)
    } finally {
      await rm(join(dir, name))
    }
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

  it('a copy before an update does not wait for an export: it only reads (B7 PR31 second pass)', {
    timeout: 15_000,
  }, async () => {
    w.advance(60_000)
    const reading = new pg.Client({ connectionString: w.url })
    await reading.connect()
    try {
      // What an export holds open: a read-only snapshot, named as the export names it.
      await reading.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await reading.query("SET LOCAL application_name = 'rsc-brain export'")
      await reading.query('SELECT count(*) FROM entries')
      await maintenance.on(w.db, w.clock(), { reason: 'update' })
      const t0 = Date.now()
      const c = await backup.create(w.db, {
        dir,
        secret: TEST_SECRET,
        reason: 'pre-update',
        clock: w.clock,
        settleMs: 50,
      })
      assert.ok(Date.now() - t0 < 5000, 'it waited for the export')
      await rm(join(dir, c.file))
    } finally {
      await maintenance.off(w.db)
      await reading.query('ROLLBACK').catch(() => {})
      await reading.end()
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
