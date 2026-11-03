// `rsc-brain restore`, `rsc-brain key id` and `rsc-brain key reseal` (plan §3.3, T014): what the launcher runs in the
// container. A key is read from a file or from the standard input, never from the command line, and never printed:
// only its id. A restore asks for the name of the installation; without it, or with another, it exits 2 and nothing
// changes. Before replacing anything it makes a copy of what is there.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { seal, unseal } from '../../src/auth/vault.ts'
import type { Db } from '../../src/db/db.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createAccount } from '../../src/domain/accounts.ts'
import { mintPersonToken } from '../../src/domain/keys.ts'
import { backup } from '../../src/ops/backup/backup.ts'
import { keyId } from '../../src/ops/backup/format.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const SOURCE_KEY = 'source-installation-key-of-more-than-32-chars'
const TARGET_KEY = 'target-installation-key-of-more-than-32-chars'
const NEW_KEY = 'a-rotated-installation-key-longer-than-32-chars'
const MAIL_PW = 'cli-mail-password-canary-7d21'
const KEYS = [SOURCE_KEY, TARGET_KEY, NEW_KEY]

function run(
  args: string[],
  env: Record<string, string>,
  input = '',
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    p.stdin.end(input)
  })
}

const noKeyIn = (r: { out: string; err: string }) => {
  for (const k of KEYS) assert.ok(!r.out.includes(k) && !r.err.includes(k), 'a key was printed')
}

// Every table, row by row: what "nothing changed" means.
async function state(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const { t } of await db.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
  )) {
    const r = await db.one<{ h: string }>(
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`,
    )
    out[t] = String(r?.h)
  }
  return out
}

describe('rsc-brain key id and restore options (no database needed)', () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-cli-key-'))
    await writeFile(join(dir, 'key'), `${SOURCE_KEY}\n`, { mode: 0o600 })
  })
  after(async () => rm(dir, { recursive: true, force: true }))
  const env = { RSC_BRAIN_DATABASE_URL: 'postgres://nowhere/x', RSC_BRAIN_SECRET: TARGET_KEY }

  it('key id: the id of this installation key, of a key in a file, or of one on the standard input', async () => {
    const own = await run(['key', 'id'], env)
    assert.equal(own.code, 0, own.err)
    assert.equal(own.out.trim(), keyId(TARGET_KEY))
    const file = await run(['key', 'id', '--key-file', join(dir, 'key')], env)
    assert.equal(file.out.trim(), keyId(SOURCE_KEY))
    const piped = await run(['key', 'id'], env, `${NEW_KEY}\n`)
    assert.equal(piped.out.trim(), keyId(NEW_KEY))
    for (const r of [own, file, piped]) noKeyIn(r)
  })

  it('a key on the command line is refused (exit 2) and never repeated back', async () => {
    for (const args of [
      ['restore', '--file', 'x.rscb', '--confirm', 'Test', '--key', SOURCE_KEY],
      ['restore', '--file', 'x.rscb', '--confirm', 'Test', SOURCE_KEY],
      ['key', 'id', SOURCE_KEY],
      ['key', 'id', `--key=${SOURCE_KEY}`],
      ['key', 'reseal', '--from', SOURCE_KEY, '--to-file', 'x'],
    ]) {
      const r = await run(args, env)
      assert.equal(r.code, 2, `${args[0]} ${args[1]}: ${r.err}`)
      assert.match(r.err, /never on the command line|Usage/)
      noKeyIn(r)
    }
  })

  it('restore without --file or --confirm: exit 2, saying what to pass', async () => {
    const a = await run(['restore', '--confirm', 'Test'], env)
    assert.equal(a.code, 2)
    assert.match(a.err, /--file/)
    const b = await run(['restore', '--file', 'x.rscb'], env)
    assert.equal(b.code, 2)
    assert.match(b.err, /--confirm/)
  })

  it('a key file that cannot be read, or holds no key: exit 2', async () => {
    const r = await run(['key', 'id', '--key-file', join(dir, 'missing')], env)
    assert.equal(r.code, 2)
    await writeFile(join(dir, 'empty'), '\n')
    assert.equal((await run(['key', 'id', '--key-file', join(dir, 'empty')], env)).code, 2)
  })
})

describe('rsc-brain restore and key reseal', { skip: skipPg }, () => {
  let source: TestDb
  let target: TestDb
  let dir: string
  let copies: string
  let copy: string
  let env: Record<string, string>
  const keyFile = (k: string) => join(dir, `key-${keyId(k)}`)

  before(async () => {
    source = await freshDatabase()
    target = await freshDatabase()
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-cli-restore-'))
    copies = join(dir, 'backups')
    for (const k of KEYS) await writeFile(keyFile(k), `${k}\n`, { mode: 0o600 })
    await migrate(source.db)
    await source.db.query("UPDATE installation SET name = 'Source', setup_done_at = now(), mail = $1", [
      JSON.stringify({ host: 'smtp.test', port: 587, password: seal(SOURCE_KEY, MAIL_PW, 'mail.password') }),
    ])
    const id = await createAccount(source.db, () => new Date(), {
      kind: 'person',
      name: 'Ada',
      email: 'ada@example.com',
      isAdmin: true,
    })
    await mintPersonToken(source.db, () => new Date(), {
      accountId: id,
      name: 't',
      perm: 'write',
      allBrains: true,
      days: 9,
    })
    const info = await backup.create(source.db, {
      dir: join(dir, 'source'),
      secret: SOURCE_KEY,
      reason: 'manual',
      clock: () => new Date(),
    })
    copy = join(dir, 'source', info.file)
    await migrate(target.db)
    await target.db.query("UPDATE installation SET name = 'Target', setup_done_at = now()")
    env = { RSC_BRAIN_DATABASE_URL: target.url, RSC_BRAIN_SECRET: TARGET_KEY, RSC_BRAIN_BACKUPS: copies }
  })
  after(async () => {
    await source.drop()
    await target.drop()
    await rm(dir, { recursive: true, force: true })
  })

  it('without the name of the installation, or with another: exit 2, no copy made, nothing changed', async () => {
    const before = await state(target.db)
    const none = await run(['restore', '--file', copy, '--key-file', keyFile(SOURCE_KEY)], env)
    assert.equal(none.code, 2)
    const wrong = await run(
      ['restore', '--file', copy, '--key-file', keyFile(SOURCE_KEY), '--confirm', 'Source'],
      env,
    )
    assert.equal(wrong.code, 2, wrong.err)
    assert.match(wrong.err, /"Target"/)
    for (const r of [none, wrong]) noKeyIn(r)
    assert.deepEqual(await state(target.db), before)
    assert.deepEqual(await readdir(copies).catch(() => []), [])
  })

  it('--keep-keys with a copy not made before an update of this installation: exit 2; nothing changed', async () => {
    const before = await state(target.db)
    const r = await run(
      ['restore', '--file', copy, '--key-file', keyFile(SOURCE_KEY), '--confirm', 'Target', '--keep-keys'],
      env,
    )
    assert.equal(r.code, 2, r.err)
    assert.match(r.err, /--keep-keys/)
    noKeyIn(r)
    assert.deepEqual(await state(target.db), before)
  })

  it('another key: exit 1 with the id of the key the copy needs; nothing changed', async () => {
    const before = await state(target.db)
    const r = await run(
      ['restore', '--file', copy, '--key-file', keyFile(NEW_KEY), '--confirm', 'Target'],
      env,
    )
    assert.equal(r.code, 1)
    assert.match(r.err, new RegExp(keyId(SOURCE_KEY)))
    noKeyIn(r)
    assert.deepEqual(await state(target.db), before)
  })

  it('--check says whether the restore would go ahead (name, key, version), and changes nothing', async () => {
    const before = await state(target.db)
    const ok = await run(
      ['restore', '--check', '--file', copy, '--key-file', keyFile(SOURCE_KEY), '--confirm', 'Target'],
      env,
    )
    assert.equal(ok.code, 0, ok.err)
    assert.match(ok.out, /can be restored/)
    const wrongName = await run(
      ['restore', '--check', '--file', copy, '--key-file', keyFile(SOURCE_KEY), '--confirm', 'Source'],
      env,
    )
    assert.equal(wrongName.code, 2)
    const wrongKey = await run(
      ['restore', '--check', '--file', copy, '--key-file', keyFile(NEW_KEY), '--confirm', 'Target'],
      env,
    )
    assert.equal(wrongKey.code, 1)
    assert.match(wrongKey.err, new RegExp(keyId(SOURCE_KEY)))
    for (const r of [ok, wrongName, wrongKey]) noKeyIn(r)
    assert.deepEqual(await state(target.db), before)
    assert.deepEqual(await readdir(copies).catch(() => []), [], 'no pre-restore copy')
  })

  it('restores with the key from a file: a copy of what was there first, secrets sealed with this key', async () => {
    const r = await run(
      ['restore', '--file', copy, '--key-file', keyFile(SOURCE_KEY), '--confirm', 'Target'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    noKeyIn(r)
    assert.match(r.out, /Restored the copy of/)
    assert.match(r.out, /sign in again/)
    const pre = await backup.list(copies)
    assert.deepEqual(
      pre.map((b) => [b.reason, b.keyId]),
      [['pre-restore', keyId(TARGET_KEY)]],
    )
    assert.match(r.out, new RegExp(pre[0]?.file ?? 'none'))
    const inst = await target.db.one<{ name: string; mail: { password: string } }>(
      'SELECT name, mail FROM installation',
    )
    assert.equal(inst?.name, 'Source')
    assert.equal(unseal(TARGET_KEY, String(inst?.mail.password), 'mail.password'), MAIL_PW)
  })

  it('restores with the key on the standard input, --json', async () => {
    await new Promise((r) => setTimeout(r, 1100)) // copies are named by the second
    const r = await run(['restore', '--file', copy, '--confirm', 'Source', '--json'], env, `${SOURCE_KEY}\n`)
    assert.equal(r.code, 0, r.err)
    noKeyIn(r)
    const j = JSON.parse(r.out)
    assert.equal(typeof j.copyAt, 'string')
    assert.equal(typeof j.epoch, 'number')
    assert.match(String(j.preRestore), /pre-restore\.rscb$/)
  })

  it('a new installation (an empty database): confirmed with the name in the copy', async () => {
    const empty = await freshDatabase()
    try {
      const r = await run(
        ['restore', '--file', copy, '--key-file', keyFile(SOURCE_KEY), '--confirm', 'Source'],
        { ...env, RSC_BRAIN_DATABASE_URL: empty.url },
      )
      assert.equal(r.code, 0, r.err)
      assert.equal((await empty.db.one('SELECT name FROM installation'))?.name, 'Source')
    } finally {
      await empty.drop()
    }
  })

  it('key reseal with an old key that opens nothing sealed here: exit 1, nothing changed, no switch advised', async () => {
    const before = await state(target.db)
    const r = await run(
      ['key', 'reseal', '--from-file', keyFile(SOURCE_KEY), '--to-file', keyFile(NEW_KEY)],
      env,
    )
    assert.equal(r.code, 1, r.out + r.err)
    assert.match(r.err, new RegExp(keyId(SOURCE_KEY)))
    assert.doesNotMatch(r.out + r.err, /Set RSC_BRAIN_SECRET/)
    noKeyIn(r)
    assert.deepEqual(await state(target.db), before)
  })

  it('key reseal: everything sealed opens with the new key; run again, nothing left to do', async () => {
    const args = ['key', 'reseal', '--from-file', keyFile(TARGET_KEY), '--to-file', keyFile(NEW_KEY)]
    const r = await run(args, env)
    assert.equal(r.code, 0, r.err)
    noKeyIn(r)
    assert.match(r.out, new RegExp(`key id ${keyId(TARGET_KEY)} to key id ${keyId(NEW_KEY)}`))
    const inst = await target.db.one<{ mail: { password: string } }>('SELECT mail FROM installation')
    assert.equal(unseal(NEW_KEY, String(inst?.mail.password), 'mail.password'), MAIL_PW)
    const again = await run(args, env)
    assert.equal(again.code, 0, again.err)
    assert.match(again.out, /Resealed 0 values/)
    const same = await run(
      ['key', 'reseal', '--from-file', keyFile(NEW_KEY), '--to-file', keyFile(NEW_KEY)],
      env,
    )
    assert.equal(same.code, 2)
  })
})
