// Plan §3.4 (T016, spec B7 «Copias y restauración», «Salud y registros»): the copies, the installation key and the
// versions from the web. Only the administration, only signed in to the web (a key of an agent or a program gets
// 403 web_only, never the key), and the key and a restore only after typing the password again (401 reauth_failed
// without it). The installation key of the first-time setup is given once, to whoever ran it, right after.
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { silentLog } from '../../src/core/log.ts'
import { backup, backupJob, type CopyMemory, LOCK } from '../../src/ops/backup/backup.ts'
import { keyId } from '../../src/ops/backup/format.ts'
import { skipPg } from '../helpers/pg.ts'
import { TEST_SECRET, type World, world } from '../helpers/world.ts'

const PW = 'correct horse battery staple'
const OTHER_KEY = 'another-installation-key-of-at-least-32-chars'

describe('copies, the installation key and versions from the web (§3.4)', { skip: skipPg }, () => {
  let w: World
  let dir: string
  let admin: { id: string; key: string; email: string }
  let adminWeb: string
  let reader: { id: string; key: string }
  let readerWeb: string

  const withPassword = async (name: string, o: { isAdmin?: boolean } = {}) => {
    const p = await w.person(name, o)
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [p.id, await hashPassword(PW)])
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [p.id]))?.email)
    return { ...p, email }
  }
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await w.callWeb(adminWeb, 'GET', '/v1/admin/backups')
      if (r.body.running === false) return r
      await new Promise((x) => setTimeout(x, 25))
    }
    throw new Error('the copy never ended')
  }
  const copy = async () => {
    w.advance(2000)
    const r = await w.callWeb(adminWeb, 'POST', '/v1/admin/backups', {})
    assert.equal(r.status, 202, r.text)
    await settle()
    return String(r.body.id)
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-web-copies-'))
    w = await world({ backups: dir })
    admin = await withPassword('Ada', { isAdmin: true })
    adminWeb = await w.web(admin.id)
    reader = await withPassword('Rita')
    readerWeb = await w.web(reader.id)
  })
  after(async () => {
    await w?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('only the administration, only in the web: a member gets 403, a key 403 web_only, never a copy or the key', async () => {
    const id = await copy()
    for (const [method, path, body] of [
      ['GET', '/v1/admin/backups', undefined],
      ['POST', '/v1/admin/backups', {}],
      ['GET', `/v1/admin/backups/${id}/download`, undefined],
      ['GET', `/v1/admin/backups/${id}/impact`, undefined],
      ['POST', `/v1/admin/backups/${id}/restore`, { confirm: 'Test', password: PW }],
      ['POST', '/v1/admin/installation-key', { password: PW }],
    ] as const) {
      const member = await w.callWeb(readerWeb, method, path, body)
      assert.deepEqual(
        [member.status, member.body.error?.code],
        [403, 'forbidden'],
        `${path}: ${member.text}`,
      )
      const byKey = await w.call(admin.key, method, path, body)
      assert.deepEqual([byKey.status, byKey.body.error?.code], [403, 'web_only'], `${path}: ${byKey.text}`)
      assert.doesNotMatch(byKey.text + member.text, new RegExp(TEST_SECRET))
    }
  })

  it('lists the copies with their key id, whether they need an older key, the last good one and the schedule', async () => {
    w.advance(2000)
    await backup.create(w.db, { dir, secret: OTHER_KEY, reason: 'manual', clock: w.clock })
    const r = await w.callWeb(adminWeb, 'GET', '/v1/admin/backups')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.configured, true)
    assert.equal(r.body.keyId, keyId(TEST_SECRET))
    const items = r.body.items as Array<Record<string, unknown>>
    assert.ok(items.length >= 2)
    const old = items.find((i) => i.keyId === keyId(OTHER_KEY))
    const mine = items.find((i) => i.keyId === keyId(TEST_SECRET))
    assert.equal(old?.needsOldKey, true)
    assert.equal(mine?.needsOldKey, false)
    for (const i of items) {
      assert.deepEqual(Object.keys(i).sort(), ['bytes', 'createdAt', 'id', 'keyId', 'needsOldKey', 'reason'])
    }
    assert.ok((r.body.lastOk as { file: string }).file.endsWith('.rscb'))
    assert.equal(r.body.lastFailure, null)
    assert.deepEqual(r.body.schedule, { at: '03:00', keep: 14, timezone: 'UTC' })
    assert.equal(r.body.lastUpdate, null)
  })

  it('a copy by hand: 202 with its id at once, made in the process; a second meanwhile is 409 backup_running', async () => {
    w.advance(2000)
    const first = await w.callWeb(adminWeb, 'POST', '/v1/admin/backups', {})
    const second = await w.callWeb(adminWeb, 'POST', '/v1/admin/backups', {})
    assert.equal(first.status, 202, first.text)
    assert.match(String(first.body.id), /^rsc-brain-\d{8}T\d{6}Z-manual$/)
    assert.deepEqual([second.status, second.body.error?.code], [409, 'backup_running'])
    const done = await settle()
    assert.ok((done.body.items as Array<{ id: string }>).some((i) => i.id === first.body.id))
    const line = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'backup.create' AND actor_id = $1",
      [admin.id],
    )
    assert.ok((line?.n ?? 0) >= 1)
  })

  it('downloads a copy as a file, audited; an id that is not a copy here is 404', async () => {
    const id = await copy()
    const res = await fetch(`${w.base}/v1/admin/backups/${id}/download`, {
      headers: { cookie: `rscb_session=${adminWeb}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${id}.rscb"`)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const got = Buffer.from(await res.arrayBuffer())
    assert.deepEqual(got, await readFile(join(dir, `${id}.rscb`)))
    const line = await w.db.one<{ detail: string }>(
      "SELECT detail FROM audit WHERE action = 'backup.download' ORDER BY at DESC, id DESC LIMIT 1",
    )
    assert.match(String(line?.detail), new RegExp(id))
    for (const bad of ['nope', '..%2Fstatus.json', 'rsc-brain-20991231T000000Z-manual', `${id}.rscb`]) {
      const r = await w.callWeb(adminWeb, 'GET', `/v1/admin/backups/${bad}/download`)
      assert.deepEqual([r.status, r.body.error?.code], [404, 'not_found'], `${bad}: ${r.text}`)
    }
  })

  it('a download (an audit line) is not a write a restore loses', async () => {
    const id = await copy()
    w.advance(60_000)
    const dl = await fetch(`${w.base}/v1/admin/backups/${id}/download`, {
      headers: { cookie: `rscb_session=${adminWeb}` },
    })
    assert.equal(dl.status, 200)
    await dl.arrayBuffer()
    const r = await w.callWeb(adminWeb, 'GET', `/v1/admin/backups/${id}/impact`)
    assert.equal(r.body.lostWrites, false, r.text)
  })

  it('the impact of a restore: when the copy was made and the last write it would lose', async () => {
    const id = await copy()
    w.advance(60_000)
    const b = await w.call(admin.key, 'POST', '/v1/brains', {
      slug: 'later',
      purpose: 'Written after the copy.',
    })
    assert.equal(b.status, 201, b.text)
    const r = await w.callWeb(adminWeb, 'GET', `/v1/admin/backups/${id}/impact`)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.copyAt, (await backup.list(dir)).find((x) => x.id === id)?.createdAt)
    assert.ok(Date.parse(String(r.body.lastWriteAt)) > Date.parse(String(r.body.copyAt)))
    assert.equal(r.body.lostWrites, true)
  })

  it('the installation key: only with the password again (401 reauth_failed without it), never cached, audited', async () => {
    const none = await w.callWeb(adminWeb, 'POST', '/v1/admin/installation-key', {})
    assert.deepEqual([none.status, none.body.error?.code], [401, 'reauth_failed'], none.text)
    const wrong = await w.callWeb(adminWeb, 'POST', '/v1/admin/installation-key', {
      password: 'not it at all',
    })
    assert.deepEqual([wrong.status, wrong.body.error?.code], [401, 'reauth_failed'], wrong.text)
    assert.doesNotMatch(none.text + wrong.text, new RegExp(TEST_SECRET))
    const res = await fetch(`${w.base}/v1/admin/installation-key`, {
      method: 'POST',
      headers: {
        cookie: `rscb_session=${adminWeb}`,
        'x-requested-with': 'rsc-brain-web',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: PW }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await res.json(), { key: TEST_SECRET, keyId: keyId(TEST_SECRET) })
    const line = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'installation_key.download' AND actor_id = $1",
      [admin.id],
    )
    assert.equal(line?.n, 1)
    const failed = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'auth.failed' AND actor_id = $1",
      [admin.id],
    )
    assert.ok((failed?.n ?? 0) >= 1)
  })

  it('with a second factor the code is asked too; a wrong one is 401 reauth_failed', async () => {
    const mo = await withPassword('Mo', { isAdmin: true })
    const moWeb = await w.web(mo.id)
    const secret = String((await w.callWeb(moWeb, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(moWeb, 'POST', '/v1/me/totp/confirm', { code: totpAt(secret, stepOf(w.now)) })
    const noCode = await w.callWeb(moWeb, 'POST', '/v1/admin/installation-key', { password: PW })
    assert.deepEqual([noCode.status, noCode.body.error?.code], [401, 'reauth_failed'], noCode.text)
    const bad = await w.callWeb(moWeb, 'POST', '/v1/admin/installation-key', { password: PW, code: '000000' })
    assert.deepEqual([bad.status, bad.body.error?.code], [401, 'reauth_failed'], bad.text)
    w.advance(30_000)
    const ok = await w.callWeb(moWeb, 'POST', '/v1/admin/installation-key', {
      password: PW,
      code: totpAt(secret, stepOf(w.now)),
    })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.body.key, TEST_SECRET)
  })

  it('wrong passwords take their turn at the brake of signing in', async () => {
    const lou = await withPassword('Lou', { isAdmin: true })
    const louWeb = await w.web(lou.id)
    for (let i = 0; i < 5; i++)
      await w.callWeb(louWeb, 'POST', '/v1/admin/installation-key', { password: 'nope nope nope' })
    const braked = await w.callWeb(louWeb, 'POST', '/v1/admin/installation-key', { password: PW })
    assert.deepEqual([braked.status, braked.body.error?.code], [429, 'too_many_attempts'], braked.text)
  })

  it('a copy made with an older key: restoring it here is 409 wrong_key with the key it needs, nothing changed', async () => {
    const old = (await backup.list(dir)).find((b) => b.keyId === keyId(OTHER_KEY))
    assert.ok(old)
    const r = await w.callWeb(adminWeb, 'POST', `/v1/admin/backups/${old.id}/restore`, {
      confirm: 'Test',
      password: PW,
    })
    assert.deepEqual([r.status, r.body.error?.code], [409, 'wrong_key'], r.text)
    assert.equal((r.body.error as unknown as { needs?: string }).needs ?? r.body.needs, keyId(OTHER_KEY))
    assert.equal((await w.callWeb(adminWeb, 'GET', '/v1/me')).status, 200)
  })

  it('restoring: the password again, the name of the installation, then everything back and everyone signs in again', async () => {
    const id = await copy()
    w.advance(60_000)
    const later = await w.call(admin.key, 'POST', '/v1/brains', {
      slug: 'after-copy',
      purpose: 'Lost by the restore.',
    })
    assert.equal(later.status, 201, later.text)
    const path = `/v1/admin/backups/${id}/restore`
    const noPw = await w.callWeb(adminWeb, 'POST', path, { confirm: 'Test' })
    assert.deepEqual([noPw.status, noPw.body.error?.code], [401, 'reauth_failed'], noPw.text)
    const badName = await w.callWeb(adminWeb, 'POST', path, { confirm: 'test', password: PW })
    assert.deepEqual([badName.status, badName.body.error?.code], [400, 'confirm_mismatch'], badName.text)
    const noName = await w.callWeb(adminWeb, 'POST', path, { password: PW })
    assert.deepEqual([noName.status, noName.body.error?.code], [400, 'confirm_mismatch'], noName.text)
    assert.ok(await w.db.one("SELECT 1 FROM brains WHERE slug = 'after-copy'"), 'nothing changed yet')
    const before = (await readdir(dir)).filter((f) => f.endsWith('-pre-restore.rscb'))
    w.advance(2000)
    const ok = await w.callWeb(adminWeb, 'POST', path, { confirm: 'Test', password: PW })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.body.copyAt, (await backup.list(dir)).find((x) => x.id === id)?.createdAt)
    assert.match(String(ok.body.preRestore), /-pre-restore\.rscb$/)
    assert.equal(await w.db.one("SELECT 1 FROM brains WHERE slug = 'after-copy'"), undefined)
    const pre = (await readdir(dir)).filter((f) => f.endsWith('-pre-restore.rscb'))
    assert.equal(pre.length, before.length + 1)
    // The session that asked ended with every other key: the answer came first.
    assert.equal((await w.callWeb(adminWeb, 'GET', '/v1/me')).status, 401)
    assert.equal((await w.call(admin.key, 'GET', '/v1/me')).status, 401)
    const line = await w.db.one<{ actor_id: string }>(
      "SELECT actor_id FROM audit WHERE action = 'installation.restore' ORDER BY at DESC, id DESC LIMIT 1",
    )
    assert.equal(line?.actor_id, admin.id)
    adminWeb = await w.web(admin.id)
    readerWeb = await w.web(reader.id)
    admin.key = await w.token(admin.id)
  })

  it('the health of the system adds the copies, the key id and the release', async () => {
    const r = await w.callWeb(adminWeb, 'GET', '/v1/admin/system')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.keyId, keyId(TEST_SECRET))
    const b = r.body.backups as Record<string, unknown>
    assert.deepEqual(Object.keys(b).sort(), ['lastFailure', 'lastOk', 'lastWarning'])
    assert.ok(b.lastOk)
    assert.deepEqual(r.body.release, {
      installed: '0.1.0',
      latest: null,
      notes: null,
      checkedAt: null,
      newer: false,
    })
    assert.doesNotMatch(r.text, new RegExp(TEST_SECRET))
  })
})

describe('a copy that fails where its status cannot be written either: the web still says so', {
  skip: skipPg,
}, () => {
  let w: World
  let dir: string
  after(async () => {
    await w?.close()
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })

  it('the failure is kept in the memory of the process until a good copy', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-web-copies-ro-'))
    await writeFile(join(dir, 'status.json'), '{}')
    await chmod(dir, 0o500)
    w = await world({ backups: dir })
    const a = await w.person('Ada', { isAdmin: true })
    const web = await w.web(a.id)
    const r = await w.callWeb(web, 'POST', '/v1/admin/backups', {})
    assert.equal(r.status, 202, r.text)
    let got = await w.callWeb(web, 'GET', '/v1/admin/backups')
    for (let i = 0; got.body.running && i < 200; i++) {
      await new Promise((x) => setTimeout(x, 25))
      got = await w.callWeb(web, 'GET', '/v1/admin/backups')
    }
    assert.equal((got.body.lastFailure as { category: string } | null)?.category, 'no_permission', got.text)
    const sys = await w.callWeb(web, 'GET', '/v1/admin/system')
    assert.equal(
      (sys.body.backups as { lastFailure: { category: string } }).lastFailure.category,
      'no_permission',
    )
    await chmod(dir, 0o700)
    w.advance(2000)
    await w.callWeb(web, 'POST', '/v1/admin/backups', {})
    got = await w.callWeb(web, 'GET', '/v1/admin/backups')
    for (let i = 0; got.body.running && i < 200; i++) {
      await new Promise((x) => setTimeout(x, 25))
      got = await w.callWeb(web, 'GET', '/v1/admin/backups')
    }
    assert.equal(got.body.lastFailure, null, got.text)
  })

  it('without a folder for the copies: the list says so and a copy is refused with how to set it; a newer release is said', async () => {
    const latest = {
      latest: '0.2.0',
      notes: '## 0.2.0\n- Faster search.',
      checkedAt: '2026-11-02T10:00:00.000Z',
    }
    const v = await world({
      releases: {
        state: () => ({ installed: '0.1.0', ...latest }),
        check: async () => {},
        start: () => {},
        stop: () => {},
      },
    })
    try {
      const a = await v.person('Ada', { isAdmin: true })
      const web = await v.web(a.id)
      const sys = await v.callWeb(web, 'GET', '/v1/admin/system')
      assert.deepEqual(sys.body.release, { installed: '0.1.0', ...latest, newer: true })
      assert.deepEqual(sys.body.backups, { lastOk: null, lastFailure: null, lastWarning: null })
      const r = await v.callWeb(web, 'GET', '/v1/admin/backups')
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.configured, false)
      assert.deepEqual(r.body.items, [])
      const made = await v.callWeb(web, 'POST', '/v1/admin/backups', {})
      assert.deepEqual([made.status, made.body.error?.code], [409, 'backups_not_set_up'], made.text)
      assert.match(made.body.error?.howToProceed ?? '', /RSC_BRAIN_BACKUPS/)
    } finally {
      await v.close()
    }
  })
})

describe('the installation key of the first-time setup (wizard step «Installation key»)', {
  skip: skipPg,
}, () => {
  let w: World
  before(async () => {
    w = await world({ fresh: true })
  })
  after(async () => w?.close())

  const setup = async () => {
    const r = await w.raw('POST', '/v1/setup', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      body: {
        name: 'Fresh',
        publicUrl: 'http://localhost',
        admin: { name: 'Ada', email: 'ada@example.com', password: PW },
      },
    })
    assert.equal(r.status, 201, r.text)
    return /rscb_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? ''
  }

  it('whoever ran the setup gets it once, right after, as the process holds it; then 404', async () => {
    const session = await setup()
    const other = await w.person('Bo', { isAdmin: true })
    const otherWeb = await w.web(other.id)
    const notTheirs = await w.callWeb(otherWeb, 'POST', '/v1/setup/key', {})
    assert.deepEqual([notTheirs.status, notTheirs.body.error?.code], [404, 'not_found'], notTheirs.text)
    const byKey = await w.call(await w.token(other.id), 'POST', '/v1/setup/key', {})
    assert.deepEqual([byKey.status, byKey.body.error?.code], [403, 'web_only'], byKey.text)
    // A POST through the web's own header only (a page elsewhere cannot ask for it); GET is no longer an answer.
    const crossSite = await w.callWeb(session, 'POST', '/v1/setup/key', {}, { csrf: false })
    assert.deepEqual([crossSite.status, crossSite.body.error?.code], [403, 'csrf'], crossSite.text)
    assert.equal((await w.callWeb(session, 'GET', '/v1/setup/key')).status, 405)
    const first = await w.callWeb(session, 'POST', '/v1/setup/key', {})
    assert.equal(first.status, 200, first.text)
    assert.deepEqual(first.body, { key: TEST_SECRET, keyId: keyId(TEST_SECRET) })
    const second = await w.callWeb(session, 'POST', '/v1/setup/key', {})
    assert.deepEqual([second.status, second.body.error?.code], [404, 'not_found'], second.text)
    assert.match(second.body.error?.howToProceed ?? '', /Backups & system/)
    assert.doesNotMatch(second.text, new RegExp(TEST_SECRET))
    const line = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'installation_key.setup'",
    )
    assert.equal(line?.n, 1)
  })

  it('an hour after the setup it is no longer given, even to whoever ran it', async () => {
    const v = await world({ fresh: true })
    try {
      const r = await v.raw('POST', '/v1/setup', {
        headers: { 'x-requested-with': 'rsc-brain-web' },
        body: {
          name: 'Late',
          publicUrl: 'http://localhost',
          admin: { name: 'Ada', email: 'ada@example.com', password: PW },
        },
      })
      const session = /rscb_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? ''
      v.advance(3600_000 + 1000)
      const late = await v.callWeb(session, 'POST', '/v1/setup/key', {})
      assert.deepEqual([late.status, late.body.error?.code], [404, 'not_found'], late.text)
    } finally {
      await v.close()
    }
  })
})

describe('copies review: one copy at a time, said; a warning that retires', { skip: skipPg }, () => {
  let w: World
  let dir: string
  let web: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-web-copies-review-'))
    w = await world({ backups: dir })
    const a = await w.person('Ada', { isAdmin: true })
    web = await w.web(a.id)
  })
  after(async () => {
    await w?.close()
    await rm(dir, { recursive: true, force: true })
  })
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      if (!(await w.callWeb(web, 'GET', '/v1/admin/backups')).body.running) return
      await new Promise((x) => setTimeout(x, 25))
    }
    throw new Error('the copy never ended')
  }

  it('while the daily copy runs, a copy by hand is 409 backup_running at once, naming it', async () => {
    const memory = w.copies?.memory as { busy?: string | null }
    memory.busy = 'scheduled'
    try {
      const r = await w.callWeb(web, 'POST', '/v1/admin/backups', {})
      assert.deepEqual([r.status, r.body.error?.code], [409, 'backup_running'], r.text)
      assert.match(r.body.error?.message ?? '', /the daily one/)
      assert.equal((await w.callWeb(web, 'GET', '/v1/admin/backups')).body.running, true)
    } finally {
      memory.busy = null
    }
  })

  it('the daily copy of serve and the web share one memory: during a real daily copy, 409 naming it', async () => {
    let go: () => void = () => {}
    const gate = new Promise<void>((r) => {
      go = r
    })
    const slow = {
      ...backup.diskFiles,
      open: async (path: string) => {
        await gate
        return backup.diskFiles.open(path)
      },
    }
    w.advance(2000)
    const job = backupJob(w.db, {
      dir,
      secret: TEST_SECRET,
      keep: 99,
      clock: w.clock,
      log: silentLog,
      files: slow,
      memory: w.copies?.memory as CopyMemory,
    })
    const running = job()
    try {
      await new Promise((x) => setTimeout(x, 50))
      const r = await w.callWeb(web, 'POST', '/v1/admin/backups', {})
      assert.deepEqual([r.status, r.body.error?.code], [409, 'backup_running'], r.text)
      assert.match(r.body.error?.message ?? '', /the daily one/)
    } finally {
      // The daily copy goes on whatever the assertions said, so a failure here never hangs the file.
      go()
      await running
    }
    assert.equal((await w.callWeb(web, 'GET', '/v1/admin/backups')).body.running, false)
  })

  it('while another process holds the lock of the copies, a copy by hand is 409 before any 202', async () => {
    const pg = (await import('pg')).default
    const other = new pg.Client({ connectionString: w.url })
    await other.connect()
    try {
      await other.query('SELECT pg_advisory_lock($1)', [LOCK])
      const r = await w.callWeb(web, 'POST', '/v1/admin/backups', {})
      assert.deepEqual([r.status, r.body.error?.code], [409, 'backup_running'], r.text)
    } finally {
      await other.end()
    }
    w.advance(2000)
    const ok = await w.callWeb(web, 'POST', '/v1/admin/backups', {})
    assert.equal(ok.status, 202, ok.text)
    await idle()
  })

  it('a warning retires: a good copy without one clears it, and a later copy outdates the status that held it', async () => {
    w.advance(2000)
    const warnedAt = w.clock().toISOString()
    const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'))
    await writeFile(
      join(dir, 'status.json'),
      JSON.stringify({ ...status, lastWarning: { at: warnedAt, code: 'fsync_failed' } }),
    )
    const shown = await w.callWeb(web, 'GET', '/v1/admin/backups')
    assert.deepEqual(shown.body.lastWarning, { at: warnedAt, code: 'fsync_failed' })
    // A copy written later whose status was not saved (only in the folder): the old status is outdated.
    w.advance(2000)
    await backup.create(w.db, {
      dir,
      secret: TEST_SECRET,
      reason: 'manual',
      clock: w.clock,
      files: {
        ...backup.diskFiles,
        status: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })),
      },
    })
    const later = await w.callWeb(web, 'GET', '/v1/admin/backups')
    assert.equal(later.body.lastWarning, null, later.text)
    assert.equal(
      ((await w.callWeb(web, 'GET', '/v1/admin/system')).body.backups as { lastWarning: unknown })
        .lastWarning,
      null,
    )
    // A good copy with nothing to say clears it from status.json too.
    w.advance(2000)
    assert.equal((await w.callWeb(web, 'POST', '/v1/admin/backups', {})).status, 202)
    await idle()
    assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).lastWarning, null)
  })
})
