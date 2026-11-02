// Restoring a copy against a real PostgreSQL (spec B7 «Copias y restauración», CA9, CA20, CA7; plan §3.3, risks 3
// and 9). A restore replaces everything in one transaction: it migrates to the copy's migrations, loads every table,
// puts every sequence back where it stood, migrates the rest, seals what was sealed again with the key of the
// installation it lands in, and moves the epoch so no key of the copy works again (unless the rollback of an update
// asks to keep them). Nothing is committed before the last frame of the copy is read and every count checks out: a
// copy cut, changed or made with another key leaves the database exactly as it was.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { hashSecret, newSecret } from '../../src/auth/secrets.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { seal, unseal } from '../../src/auth/vault.ts'
import { AppError } from '../../src/core/errors.ts'
import type { Db } from '../../src/db/db.ts'
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.ts'
import { newReset } from '../../src/domain/login.ts'
import { maintenance } from '../../src/domain/maintenance.ts'
import { openai } from '../../src/meaning/providers.ts'
import { destinationOf } from '../../src/meaning/stored.ts'
import { backup, knownMigrations } from '../../src/ops/backup/backup.ts'
import {
  encodeRow,
  type Header,
  keyId,
  openBackup,
  readSections,
  sectionEnd,
  sectionHead,
  writeBackup,
} from '../../src/ops/backup/format.ts'
import { restore } from '../../src/ops/backup/restore.ts'
import { BACKUP_TABLES } from '../../src/ops/backup/tables.ts'
import { freshDatabase, skipPg } from '../helpers/pg.ts'
import { TEST_SECRET, type World, world } from '../helpers/world.ts'

const OTHER = 'the-key-of-another-installation-thirty-two-plus'
const PW = 'correct horse battery staple'
const MAIL_PW = 'mail-password-canary-41c9'
const PROVIDER_KEY = 'sk-provider-canary-key-0f3e'
const WEB = { 'x-requested-with': 'rsc-brain-web' }
// A restore that moves the epoch ends every pending invitation and unused reset link of the copy.
const LINKS = { invitations: ['revoked_at'], password_resets: ['used_at'] }

const isCode = (code: string) => (err: unknown) => {
  assert.ok(err instanceof AppError, String(err))
  assert.equal(err.code, code, err.message)
  return true
}

// Every table of the schema, row by row (generated columns included: they must come out the same), and every
// sequence: what "the database did not change" means.
async function state(db: Db, o: { except?: Record<string, string[]> } = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const tables = await db.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
  )
  for (const { t } of tables) {
    const cols = (
      await db.query<{ c: string }>(
        `SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
          ORDER BY attnum`,
        [t],
      )
    )
      .map((r) => r.c)
      // When a migration ran is when the restore ran it.
      .filter((c) => !(o.except?.[t] ?? []).includes(c) && !(t === 'schema_migrations' && c === 'applied_at'))
    const r = await db.one<{ h: string; n: number }>(
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n
         FROM (SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}") x`,
    )
    out[t] = `${r?.n}:${r?.h}`
  }
  for (const s of await db.query<{ n: string; v: string | null }>(
    "SELECT sequencename AS n, last_value::text AS v FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1",
  ))
    out[`seq:${s.n}`] = String(s.v)
  return out
}

type Section = { table: string; columns: string[]; rows: Array<Array<string | null>> }
async function sectionsOf(path: string, key = TEST_SECRET): Promise<{ header: Header; sections: Section[] }> {
  const opened = await openBackup(path, key)
  const sections: Section[] = []
  for await (const ev of readSections(opened)) {
    if (ev.kind === 'table') sections.push({ table: ev.table, columns: ev.columns, rows: [] })
    else sections[sections.length - 1]?.rows.push(ev.values)
  }
  return { header: opened.header, sections }
}

// A copy made by hand from sections (changed by a test), encrypted as rsc-brain encrypts them.
async function craft(
  path: string,
  header: Header,
  sections: Section[],
  o: { key?: string; migrations?: string[]; release?: string; tables?: string[] } = {},
): Promise<void> {
  const chunks: Buffer[] = []
  async function* text() {
    for (const s of sections)
      yield Buffer.from(sectionHead(s.table, s.columns) + s.rows.map(encodeRow).join('') + sectionEnd)
  }
  await writeBackup(
    async (b) => void chunks.push(b),
    {
      release: o.release ?? header.release,
      migrations: o.migrations ?? header.migrations,
      createdAt: header.createdAt,
      installation: header.installation,
      reason: header.reason,
      tables: o.tables ?? header.tables,
      lastWriteAt: header.lastWriteAt,
    },
    text(),
    o.key ?? TEST_SECRET,
  )
  await writeFile(path, Buffer.concat(chunks))
}

const lookInvite = (w: World, token: string) => w.raw('POST', '/v1/invitations/look', { body: { token } })
const lookReset = (w: World, token: string) => w.raw('POST', '/v1/auth/reset/look', { body: { token } })

const login = (w: World, email: string, password: string, extra: Record<string, unknown> = {}) =>
  w.raw('POST', '/v1/auth/login', { headers: WEB, body: { email, password, ...extra } })

describe('restore on PostgreSQL', { skip: skipPg }, () => {
  let source: World
  let dir: string
  let copy: string
  let atCopy: Record<string, string>
  let atCopyNoEpoch: Record<string, string>
  let admin: { id: string; key: string; email: string; totp: string; web: string }
  let service: { id: string; key: string }
  let appKey: string
  let invite: string
  let reset: string

  before(async () => {
    source = await world()
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-restore-'))
    const a = await source.person('Ada', { isAdmin: true })
    await source.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      a.id,
      await hashPassword(PW),
    ])
    const email = String((await source.db.one('SELECT email FROM accounts WHERE id = $1', [a.id]))?.email)
    const web = await source.web(a.id)
    const start = await source.callWeb(web, 'POST', '/v1/me/totp')
    assert.equal(start.status, 200, start.text)
    const totp = String(start.body.secret)
    const ok = await source.callWeb(web, 'POST', '/v1/me/totp/confirm', {
      code: totpAt(totp, stepOf(source.now)),
    })
    assert.equal(ok.status, 200, ok.text)
    admin = { ...a, email, totp, web }
    assert.equal((await source.call(a.key, 'POST', '/v1/brains', { slug: 'alpha' })).status, 201)
    for (let i = 0; i < 3; i += 1) {
      const e = await source.call(a.key, 'POST', '/v1/brains/alpha/entries', {
        type: 'note',
        title: `Note ${i}`,
        content: `Entry ${i}\twith a tab\nand a line, and a backslash \\ here`,
      })
      assert.equal(e.status, 201, e.text)
    }
    const brain = await source.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'alpha'")
    // A session summarised by one of its entries: the link both ways a restore loads in two steps.
    const entry = await source.db.one<{ id: string; session_id: string | null }>(
      'SELECT id, session_id FROM entries ORDER BY created_at, id LIMIT 1',
    )
    assert.ok(entry?.session_id, 'an entry with a session')
    await source.db.query('UPDATE sessions SET summary_entry_id = $1 WHERE id = $2', [
      entry.id,
      entry.session_id,
    ])
    // Two pages of text that does not compress, so the copy spans several frames.
    for (const n of [1, 2])
      await source.db.query(
        `INSERT INTO pages (id, brain_id, address, type, title, body, created_at, updated_at)
         VALUES ($1, $2, $3, 'topic', 'Big', $4, now(), now())`,
        [`pag_big000000${n}`, brain?.id, `big-${n}`, randomBytes(75_000).toString('base64')],
      )
    service = await source.service('Robot')
    appKey = await source.app(a.id, [String(brain?.id)])
    // A pending invitation and an unused link to set a password: links that are not keys, but open the door.
    invite = newSecret()
    await source.db.query(
      `INSERT INTO invitations (id, email, token_hash, grants, invited_by, created_at, expires_at)
       VALUES ('inv_restore01', 'new.person@example.com', $1, '[]', $2, $3, $4)`,
      [hashSecret(invite), a.id, source.now, new Date(source.now.getTime() + 7 * 86_400_000)],
    )
    reset = await newReset(source.db, a.id, null, source.now)
    assert.equal((await lookInvite(source, invite)).status, 200)
    assert.equal((await lookReset(source, reset)).status, 200)
    await source.setUpMail()
    await source.db.query(
      "UPDATE installation SET mail = jsonb_set(mail, '{password}', to_jsonb($1::text)) WHERE id = 1",
      [seal(TEST_SECRET, MAIL_PW, 'mail.password')],
    )
    await source.db.query(
      `UPDATE meaning_settings SET enabled = true, provider = 'openai', model = 'text-embedding-3-small',
              openai_key = $1, openai_key_last4 = 'ef3e', destination = $2 WHERE id = 1`,
      [seal(TEST_SECRET, PROVIDER_KEY, 'meaning.openai'), destinationOf(openai(PROVIDER_KEY), TEST_SECRET)],
    )
    const info = await backup.create(source.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: source.clock,
    })
    copy = join(dir, info.file)
    atCopy = await state(source.db)
    atCopyNoEpoch = await state(source.db, { except: { installation: ['key_epoch'], ...LINKS } })
  })
  after(async () => {
    await source.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('wrong key (CA20): refused with the id of the key it needs; nothing changes', async () => {
    const before = await state(source.db)
    await assert.rejects(
      restore(source.db, {
        file: copy,
        key: OTHER,
        targetSecret: TEST_SECRET,
        keepKeys: false,
        clock: source.clock,
      }),
      (err: unknown) => {
        isCode('wrong_key')(err)
        assert.deepEqual((err as AppError).extra, { needs: keyId(TEST_SECRET) })
        return true
      },
    )
    assert.deepEqual(await state(source.db), before)
  })

  it('a copy of a newer release: refused saying which release it needs; nothing changes', async () => {
    const { header, sections } = await sectionsOf(copy)
    const newer = join(dir, 'newer.rscb')
    await craft(newer, header, sections, {
      migrations: [...header.migrations, '9999_from_the_future'],
      release: '99.1.0',
    })
    const before = await state(source.db)
    await assert.rejects(
      restore(source.db, {
        file: newer,
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: false,
        clock: source.clock,
      }),
      (err: unknown) => {
        isCode('newer_copy')(err)
        assert.deepEqual((err as AppError).extra, { needs: '99.1.0' })
        return true
      },
    )
    assert.deepEqual(await state(source.db), before)
  })

  it('a copy cut before its last frame: refused whole, after loading part of it; nothing changes', async () => {
    const cut = join(dir, 'cut.rscb')
    const bytes = await readFile(copy)
    assert.ok(bytes.length > 2 * 65_536 + 100, 'the copy spans several frames')
    await writeFile(cut, bytes)
    await truncate(cut, bytes.length - 40)
    const before = await state(source.db)
    await assert.rejects(
      restore(source.db, {
        file: cut,
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: false,
        clock: source.clock,
      }),
      isCode('corrupt_copy'),
    )
    assert.deepEqual(await state(source.db), before)
    assert.equal(await maintenance.current(source.db, source.clock()), null, 'maintenance as it was')
  })

  it('section checks: counts, the first two sections, order and tables are those the header names', async () => {
    const { header, sections } = await sectionsOf(copy)
    assert.deepEqual(
      sections.slice(0, 2).map((s) => s.table),
      ['_tables', '_sequences'],
    )
    const clone = () => sections.map((s) => ({ ...s, rows: s.rows.map((r) => [...r]) }))
    const at = (ss: Section[], t: string) => ss.findIndex((s) => s.table === t)
    const cases: Array<[string, (ss: Section[]) => Section[], { tables?: string[] }?]> = [
      [
        'a count one too many',
        (ss) => {
          const row = ss[0]?.rows.find((r) => r[0] === 'brains')
          if (row) row[1] = String(Number(row[1]) + 1)
          return ss
        },
      ],
      [
        'a count one too few',
        (ss) => {
          const row = ss[0]?.rows.find((r) => r[0] === 'entries')
          if (row) row[1] = String(Number(row[1]) - 1)
          return ss
        },
      ],
      [
        'a row more than counted',
        (ss) => {
          const s = ss[at(ss, 'audit')] as Section
          const last = [...(s.rows[s.rows.length - 1] as Array<string | null>)]
          last[0] = '999999'
          s.rows.push(last)
          return ss
        },
      ],
      ['no _tables', (ss) => ss.slice(1)],
      [
        'the counts under another name',
        (ss) => {
          ss[0] = { ...(ss[0] as Section), table: '_counts' }
          return ss
        },
      ],
      ['no _sequences', (ss) => [ss[0] as Section, ...ss.slice(2)]],
      ['_sequences first', (ss) => [ss[1] as Section, ss[0] as Section, ...ss.slice(2)]],
      ['_tables twice', (ss) => [ss[0] as Section, ss[1] as Section, ss[0] as Section, ...ss.slice(2)]],
      [
        '_tables names out of order',
        (ss) => {
          const r = ss[0]?.rows
          if (r) [r[1], r[2]] = [r[2] as (string | null)[], r[1] as (string | null)[]]
          return ss
        },
      ],
      ['a table missing', (ss) => ss.filter((s) => s.table !== 'mail_log')],
      [
        // A table copies leave out (single-use codes, receipts, brakes) is never loaded from a copy.
        'a table copies skip',
        (ss) => {
          ss[0]?.rows.push(['request_keys', '0'])
          ss.push({ table: 'request_keys', columns: ['key'], rows: [] })
          return ss
        },
        { tables: [...header.tables, 'request_keys'] },
      ],
      [
        // Both empty, so only the name tells them apart.
        'an empty table under the name of another empty one',
        (ss) => {
          const i = at(ss, 'mail_log')
          assert.equal(ss[i]?.rows.length, 0)
          assert.equal(ss[at(ss, 'repo_links')]?.rows.length, 0)
          ss[i] = { ...(ss[i] as Section), table: 'repo_links' }
          return ss
        },
      ],
      ['a table twice', (ss) => [...ss, ss[at(ss, 'mail_log')] as Section]],
      [
        'tables out of order',
        (ss) => {
          const i = at(ss, 'notices')
          const j = at(ss, 'events')
          ;[ss[i], ss[j]] = [ss[j] as Section, ss[i] as Section]
          return ss
        },
      ],
      [
        'a table the header does not name',
        (ss) => {
          ss[0] = { ...(ss[0] as Section), rows: (ss[0] as Section).rows.filter((r) => r[0] !== 'mail_log') }
          return ss
        },
        { tables: header.tables.filter((t) => t !== 'mail_log') },
      ],
      [
        'a sequence missing',
        (ss) => {
          ss[1] = { ...(ss[1] as Section), rows: (ss[1] as Section).rows.slice(1) }
          return ss
        },
      ],
    ]
    const before = await state(source.db)
    for (const [name, change, o] of cases) {
      const file = join(dir, `bad-${name.replace(/\W+/g, '-')}.rscb`)
      await craft(file, header, change(clone()), o ?? {})
      await assert.rejects(
        restore(source.db, {
          file,
          key: TEST_SECRET,
          targetSecret: TEST_SECRET,
          keepKeys: false,
          clock: source.clock,
        }),
        isCode('corrupt_copy'),
        name,
      )
      assert.deepEqual(await state(source.db), before, `${name}: nothing changes`)
    }
  })

  it('CA9: into another installation with another key: everything the same, secrets open there, no key of the source works', async () => {
    const target = await world({ secret: OTHER })
    try {
      const before = await state(target.db)
      assert.notDeepEqual(before, atCopy)
      const out = await restore(target.db, {
        file: copy,
        key: TEST_SECRET,
        targetSecret: OTHER,
        keepKeys: false,
        clock: target.clock,
      })
      assert.equal(out.copyAt, (await sectionsOf(copy)).header.createdAt)
      const after = await state(target.db, {
        except: {
          installation: ['key_epoch', 'mail'],
          accounts: ['totp_secret', 'totp_pending'],
          meaning_settings: ['openai_key', 'destination'],
          ...LINKS,
        },
      })
      const was = await state(source.db, {
        except: {
          installation: ['key_epoch', 'mail'],
          accounts: ['totp_secret', 'totp_pending'],
          meaning_settings: ['openai_key', 'destination'],
          ...LINKS,
        },
      })
      const audit = await target.db.query<{ action: string; detail: string }>(
        'SELECT action, detail FROM audit ORDER BY id DESC LIMIT 1',
      )
      assert.equal(audit[0]?.action, 'installation.restore')
      assert.match(String(audit[0]?.detail), new RegExp(out.copyAt.slice(0, 10)))
      const auditSeq = String(
        (await target.db.one<{ s: string }>("SELECT pg_get_serial_sequence('audit', 'id') AS s"))?.s,
      ).replace('public.', '')
      for (const k of Object.keys(was)) {
        if (k === 'audit' || k === `seq:${auditSeq}`) continue
        assert.equal(after[k], was[k], `${k} is as in the copy`)
      }
      // Every sequence where it stood, so the next id is the one the source would have handed out.
      assert.equal(after['seq:events_seq'], was['seq:events_seq'])
      const epochs = await target.db.one<{ e: number }>('SELECT key_epoch AS e FROM installation')
      const srcEpoch = await source.db.one<{ e: number }>('SELECT key_epoch AS e FROM installation')
      assert.equal(Number(epochs?.e), Number(srcEpoch?.e) + 1)
      assert.equal(out.epoch, Number(epochs?.e))
      // Sealed again with the key of this installation: they open with it, and no longer with the source's.
      const inst = await target.db.one<{ mail: { password: string } }>('SELECT mail FROM installation')
      assert.equal(unseal(OTHER, String(inst?.mail.password), 'mail.password'), MAIL_PW)
      assert.throws(() => unseal(TEST_SECRET, String(inst?.mail.password), 'mail.password'))
      const ms = await target.db.one<{ openai_key: string; destination: string; enabled: boolean }>(
        'SELECT openai_key, destination, enabled FROM meaning_settings',
      )
      assert.equal(unseal(OTHER, String(ms?.openai_key), 'meaning.openai'), PROVIDER_KEY)
      assert.equal(ms?.destination, destinationOf(openai(PROVIDER_KEY), OTHER))
      assert.equal(ms?.enabled, true, 'meaning search stays on: the destination is the one accepted')
      // The administrator signs in there with the same password and a code of the same authenticator.
      target.advance(60_000)
      const noCode = await login(target, admin.email, PW)
      assert.equal(noCode.body.error?.code, 'code_required')
      const signed = await login(target, admin.email, PW, { code: totpAt(admin.totp, stepOf(target.now)) })
      assert.equal(signed.status, 200, signed.text)
      // No key of the source works there: tokens, main keys, connections, web sessions.
      for (const key of [admin.key, service.key, appKey]) {
        const r = await target.call(key, 'GET', '/v1/brains')
        assert.equal(r.status, 401)
        assert.equal(r.body.error?.code, 'key_invalidated')
      }
      assert.equal((await target.callWeb(admin.web, 'GET', '/v1/me')).status, 401)
      // Nor the links of the source: the invitation and the reset link are ended, and the audit says how many.
      assert.notEqual((await lookInvite(target, invite)).status, 200)
      assert.notEqual((await lookReset(target, reset)).status, 200)
      assert.match(String(audit[0]?.detail), /1 pending invitation.*1 password link/)
      assert.equal(await maintenance.current(target.db, target.clock()), null)
    } finally {
      await target.close()
    }
  })

  it('the same installation: back to the copy, later writes gone, every key ended, one audit line', async () => {
    const later = await source.call(admin.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'note',
      title: 'After the copy',
      content: 'written after the copy',
    })
    assert.equal(later.status, 201)
    const out = await restore(source.db, {
      file: copy,
      key: TEST_SECRET,
      targetSecret: TEST_SECRET,
      keepKeys: false,
      clock: source.clock,
      by: admin.id,
    })
    const now = await state(source.db, { except: { installation: ['key_epoch'], ...LINKS } })
    for (const k of Object.keys(atCopyNoEpoch)) {
      if (k === 'audit' || k.startsWith('seq:audit')) continue
      assert.equal(now[k], atCopyNoEpoch[k], `${k} is as in the copy`)
    }
    const n = await source.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM entries WHERE title = 'After the copy'",
    )
    assert.equal(n?.n, 0)
    const last = await source.db.one<{ action: string; actor_id: string | null }>(
      'SELECT action, actor_id FROM audit ORDER BY id DESC LIMIT 1',
    )
    assert.deepEqual([last?.action, last?.actor_id], ['installation.restore', admin.id])
    assert.equal((await source.call(admin.key, 'GET', '/v1/brains')).status, 401)
    // An invitation or reset link pending in the copy does not come back to life.
    assert.notEqual((await lookInvite(source, invite)).status, 200)
    assert.notEqual((await lookReset(source, reset)).status, 200)
    assert.equal(out.epoch, Number((await source.db.one('SELECT key_epoch FROM installation'))?.key_epoch))
  })

  it('--keep-keys (CA7, the rollback of an update): keys and sessions keep working, no epoch move, the old schema back', async () => {
    const t = await world()
    const d = await mkdtemp(join(tmpdir(), 'rsc-brain-rollback-'))
    try {
      const p = await t.person('Pia', { isAdmin: true })
      const web = await t.web(p.id)
      assert.equal((await t.call(p.key, 'POST', '/v1/brains', { slug: 'beta' })).status, 201)
      await maintenance.on(t.db, t.clock(), { reason: 'update' })
      const pre = await backup.create(t.db, {
        dir: d,
        secret: TEST_SECRET,
        reason: 'pre-update',
        clock: t.clock,
        settleMs: 0,
      })
      const was = await state(t.db, { except: { installation: ['maintenance_until', 'maintenance_reason'] } })
      // A newer release migrated, then failed to start.
      await t.db.query('CREATE TABLE next_release_table (id int)')
      await t.db.query("INSERT INTO schema_migrations (id) VALUES ('9999_next_release')")
      await t.db.query("UPDATE brains SET name = 'changed by the new release'")
      const epoch = (await t.db.one('SELECT key_epoch FROM installation'))?.key_epoch
      // Keeping keys is only for the copy this installation made before an update, with its own key.
      const kept = await state(t.db)
      await assert.rejects(
        restore(t.db, {
          file: join(d, pre.file),
          key: TEST_SECRET,
          targetSecret: OTHER,
          keepKeys: true,
          clock: t.clock,
        }),
        isCode('keep_keys_refused'),
      )
      assert.deepEqual(await state(t.db), kept)
      const out = await restore(t.db, {
        file: join(d, pre.file),
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: true,
        clock: t.clock,
      })
      assert.equal(out.epoch, Number(epoch))
      const now = await state(t.db, { except: { installation: ['maintenance_until', 'maintenance_reason'] } })
      assert.deepEqual(now, was, 'everything as in the copy, the audit included')
      const ids = (await t.db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).map(
        (r) => r.id,
      )
      assert.deepEqual(ids, await knownMigrations())
      assert.equal(
        await maintenance.current(t.db, t.clock()),
        null,
        'the copy was made under maintenance; it ends',
      )
      t.advance(1000)
      assert.equal((await t.call(p.key, 'GET', '/v1/brains')).status, 200)
      assert.equal((await t.callWeb(web, 'GET', '/v1/me')).status, 200)
    } finally {
      await t.close()
      await rm(d, { recursive: true, force: true })
    }
  })

  it('risk 3: a copy of an older schema migrates to its migrations, loads, then migrates the rest', async () => {
    const old = await freshDatabase()
    const target = await freshDatabase()
    try {
      const known = await knownMigrations()
      // Before 0021, which moved the version of the mail password out of the mail settings into a column.
      const before = known.filter((m) => m < '0021')
      await migrate(old.db, MIGRATIONS_DIR, { until: before })
      const has = await old.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'installation' AND column_name = 'maintenance_until'",
      )
      assert.equal(has?.n, 0, 'migrated only up to the list')
      await old.db.query(
        `UPDATE installation SET name = 'Older', mail = '{"host": "smtp.test", "passwordVersion": 3}' WHERE id = 1`,
      )
      await old.db.query(
        "INSERT INTO accounts (id, kind, email, name, status, created_at) VALUES ('acc_000000000old', 'person', 'old@example.com', 'Old', 'active', now())",
      )
      // A copy as the older release wrote it: its tables, with the columns they had then.
      const sections: Section[] = []
      const counts: Array<Array<string | null>> = []
      for (const t of BACKUP_TABLES) {
        const cols = (
          await old.db.query<{ c: string }>(
            `SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
               AND attgenerated = ''`,
            [t.name],
          )
        )
          .map((r) => r.c)
          .filter((c) => t.columns.includes(c))
        const rows = await old.db.query<Record<string, string | null>>(
          `SELECT ${cols.map((c) => `"${c}"::text`).join(', ')} FROM "${t.name}"`,
        )
        sections.push({ table: t.name, columns: cols, rows: rows.map((r) => cols.map((c) => r[c] ?? null)) })
        counts.push([t.name, String(rows.length)])
      }
      const seqs = await old.db.query<{ n: string }>(
        "SELECT sequencename AS n FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1",
      )
      const seqRows: Array<Array<string | null>> = []
      for (const { n } of seqs) {
        const q = await old.db.one<{ v: string; c: boolean }>(
          `SELECT last_value::text AS v, is_called AS c FROM "${n}"`,
        )
        seqRows.push([n, String(q?.v), q?.c ? 't' : 'f'])
      }
      const header = {
        release: '0.0.9',
        migrations: before,
        createdAt: '2026-10-01T00:00:00.000Z',
        installation: { id: 1, name: 'Older' },
        reason: 'manual',
        tables: BACKUP_TABLES.map((t) => t.name),
        lastWriteAt: null,
      } as unknown as Header
      const file = join(dir, 'older.rscb')
      await craft(file, header, [
        { table: '_tables', columns: ['name', 'rows'], rows: counts },
        { table: '_sequences', columns: ['name', 'last_value', 'is_called'], rows: seqRows },
        ...sections,
      ])
      await restore(target.db, {
        file,
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: false,
        clock: () => new Date(),
      })
      const ids = (await target.db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).map(
        (r) => r.id,
      )
      assert.deepEqual(ids, known)
      const inst = await target.db.one(
        'SELECT name, maintenance_until, mail_password_version AS v FROM installation',
      )
      // Loaded at the copy's schema, then migrated: what 0021 does to the data was done to the copy's.
      assert.deepEqual([inst?.name, inst?.maintenance_until, inst?.v], ['Older', null, 3])
      assert.equal(
        (await target.db.one("SELECT name FROM accounts WHERE id = 'acc_000000000old'"))?.name,
        'Old',
      )
    } finally {
      await old.drop()
      await target.drop()
    }
  })

  it('--keep-keys with a copy that was not made before an update: refused; nothing changes', async () => {
    const before = await state(source.db)
    await assert.rejects(
      restore(source.db, {
        file: copy,
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: true,
        clock: source.clock,
      }),
      isCode('keep_keys_refused'),
    )
    assert.deepEqual(await state(source.db), before)
  })

  it('a copy before a restore needs maintenance on, like one before an update', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rsc-brain-prerestore-'))
    try {
      await assert.rejects(
        backup.create(source.db, { dir: d, secret: TEST_SECRET, reason: 'pre-restore', clock: source.clock }),
        (err: unknown) => {
          isCode('not_in_maintenance')(err)
          assert.match((err as AppError).howToProceed, /--reason restore/)
          return true
        },
      )
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('a database that is not rsc-brain’s is refused; nothing changes', async () => {
    const t = await freshDatabase()
    try {
      await t.db.query('CREATE TABLE someone_elses (id int)')
      await assert.rejects(
        restore(t.db, {
          file: copy,
          key: TEST_SECRET,
          targetSecret: TEST_SECRET,
          keepKeys: false,
          clock: () => new Date(),
        }),
        isCode('not_rsc_brain_database'),
      )
      assert.ok(await t.db.one("SELECT 1 FROM pg_tables WHERE tablename = 'someone_elses'"))
    } finally {
      await t.drop()
    }
  })

  it('the confirmation must be the name of the installation (or, when it has none yet, of the copy)', async () => {
    const before = await state(source.db)
    await assert.rejects(
      restore(source.db, {
        file: copy,
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: false,
        clock: source.clock,
        confirm: 'Not the name',
      }),
      isCode('confirm_mismatch'),
    )
    assert.deepEqual(await state(source.db), before)
    const empty = await freshDatabase()
    try {
      await restore(empty.db, {
        file: copy,
        key: TEST_SECRET,
        targetSecret: OTHER,
        keepKeys: false,
        clock: () => new Date(),
        confirm: 'Test',
      })
      assert.equal((await empty.db.one('SELECT name FROM installation'))?.name, 'Test')
    } finally {
      await empty.drop()
    }
  })
})

// Review of PR #30 (blocker): rows go in by batches and a link to the same table is checked per statement, so a row
// pointing to one in a later batch failed. Every such column (and the session ↔ entry link) goes in empty and is
// filled once the table is in, whatever the order of the ids.
describe('restore: links within a table across batches', { skip: skipPg }, () => {
  it('more than a thousand rows, each pointing to one that comes after it', async () => {
    const w = await world()
    const d = await mkdtemp(join(tmpdir(), 'rsc-brain-selflinks-'))
    try {
      const p = await w.person('Lia', { isAdmin: true })
      assert.equal((await w.call(p.key, 'POST', '/v1/brains', { slug: 'links' })).status, 201)
      const e = await w.call(p.key, 'POST', '/v1/brains/links/entries', {
        type: 'note',
        title: 'T',
        content: 'c',
      })
      assert.equal(e.status, 201, e.text)
      const brain = String((await w.db.one("SELECT id FROM brains WHERE slug = 'links'"))?.id)
      await w.db.query(
        `INSERT INTO pages (id, brain_id, address, type, title, body, created_at, updated_at)
         VALUES ('pag_template', $1, 'template', 'topic', 'T', '', now(), now())`,
        [brain],
      )
      await w.db.query(
        `INSERT INTO proposals (id, brain_id, title, author_id, credential_id, created_at)
         VALUES ('prp_template', $1, 'T', $2, 'crd_x', now())`,
        [brain, p.id],
      )
      const N = 1100
      // The parent's id sorts after every child's, so copies hold the children first, a batch or more ahead.
      const clone = async (table: string, template: string, set: Record<string, string>) => {
        const cols = (BACKUP_TABLES.find((t) => t.name === table)?.columns ?? []).filter((c) => !(c in set))
        const all = [...cols, ...Object.keys(set)]
        const exprs = [...cols.map((c) => `"${c}"`), ...Object.values(set)]
        await w.db.query(
          `INSERT INTO ${table} (${all.map((c) => `"${c}"`).join(', ')})
           SELECT ${exprs.join(', ')} FROM ${table}, generate_series(0, ${N}) AS g WHERE id = $1`,
          [template],
        )
      }
      const child = (prefix: string) =>
        `CASE WHEN g = 0 THEN '${prefix}_zzzz_parent' ELSE '${prefix}_0000_' || lpad(g::text, 5, '0') END`
      const parentOf = (prefix: string) => `CASE WHEN g = 0 THEN NULL ELSE '${prefix}_zzzz_parent' END`
      const token = String(
        (await w.db.one('SELECT id FROM credentials WHERE account_id = $1 LIMIT 1', [p.id]))?.id,
      )
      await clone('credentials', token, {
        id: child('crd'),
        secret_hash: `md5('crd' || g::text)`,
        parent_id: parentOf('crd'),
      })
      const entry = String((await w.db.one('SELECT id FROM entries LIMIT 1'))?.id)
      await clone('entries', entry, {
        id: child('ent'),
        norm_hash: `md5('ent' || g::text)`,
        superseded_by: parentOf('ent'),
      })
      await clone('pages', 'pag_template', {
        id: child('pag'),
        address: `'addr-' || g::text`,
        superseded_by: parentOf('pag'),
      })
      await clone('proposals', 'prp_template', {
        id: child('prp'),
        supersedes_id: parentOf('prp'),
        superseded_by: parentOf('prp'),
      })
      const info = await backup.create(w.db, {
        dir: d,
        secret: TEST_SECRET,
        reason: 'manual',
        clock: w.clock,
      })
      const was = await state(w.db)
      await w.db.query("UPDATE brains SET name = 'changed after the copy'")
      await restore(w.db, {
        file: join(d, info.file),
        key: TEST_SECRET,
        targetSecret: TEST_SECRET,
        keepKeys: false,
        clock: w.clock,
      })
      const now = await state(w.db)
      for (const t of ['credentials', 'entries', 'pages', 'proposals', 'sessions', 'brains'])
        assert.equal(now[t], was[t], `${t} as in the copy`)
      const linked = await w.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM credentials WHERE parent_id = 'crd_zzzz_parent'",
      )
      assert.equal(linked?.n, N)
    } finally {
      await w.close()
      await rm(d, { recursive: true, force: true })
    }
  })
})

// Review of PR #30: a restore held a whole table in memory. With the heap capped well under the size of the copy,
// it still restores: rows go in as they are read, and the count is checked at the end of each table.
describe('restore: a copy larger than the memory of the process', { skip: skipPg }, () => {
  it('restores a copy of some 150 MB of text with a 128 MB heap', { timeout: 600_000 }, async () => {
    const source = await freshDatabase()
    const target = await freshDatabase()
    const d = await mkdtemp(join(tmpdir(), 'rsc-brain-bigcopy-'))
    try {
      await migrate(source.db)
      await source.db.query(
        `INSERT INTO accounts (id, kind, email, name, status, created_at)
         VALUES ('acc_000000000big', 'person', 'big@example.com', 'Big', 'active', now())`,
      )
      await source.db.query(
        `INSERT INTO brains (id, slug, name, created_by, created_at, updated_at)
         VALUES ('brn_000000000big', 'big', 'Big', 'acc_000000000big', now(), now())`,
      )
      await source.db.query(
        `INSERT INTO meaning_vectors (kind, target_id, brain_id, provider, model, text_hash, vec, updated_at)
         SELECT 'entry', 'ent_' || g, 'brn_000000000big', 'p', 'm', md5(g::text),
                (SELECT array_agg(random()::real) FROM generate_series(1, 1536) WHERE g > 0), now()
           FROM generate_series(1, 9000) AS g`,
      )
      const info = await backup.create(source.db, {
        dir: d,
        secret: TEST_SECRET,
        reason: 'manual',
        clock: () => new Date(),
      })
      let plain = 0
      for await (const c of await openBackup(join(d, info.file), TEST_SECRET)) plain += c.length
      assert.ok(plain > 140 * 1024 * 1024, `the copy holds ${plain} bytes of text`)
      await writeFile(join(d, 'key'), TEST_SECRET, { mode: 0o600 })
      const cli = new URL('../../src/cli/main.ts', import.meta.url).pathname
      const r = await new Promise<{ code: number; err: string }>((resolve) => {
        const c = spawn(
          process.execPath,
          [
            '--max-old-space-size=128',
            cli,
            'restore',
            '--file',
            join(d, info.file),
            '--key-file',
            join(d, 'key'),
            '--confirm',
            '',
          ],
          {
            env: {
              ...process.env,
              RSC_BRAIN_DATABASE_URL: target.url,
              RSC_BRAIN_SECRET: TEST_SECRET,
              RSC_BRAIN_BACKUPS: join(d, 'pre'),
            },
          },
        )
        let err = ''
        c.stderr.on('data', (x) => {
          err += x
        })
        c.stdin.end()
        c.on('close', (code) => resolve({ code: code ?? -1, err }))
      })
      assert.equal(r.code, 0, r.err.slice(0, 2000))
      const n = await target.db.one<{ n: number }>('SELECT count(*)::int AS n FROM meaning_vectors')
      assert.equal(n?.n, 9000)
    } finally {
      await source.drop()
      await target.drop()
      await rm(d, { recursive: true, force: true })
    }
  })
})
