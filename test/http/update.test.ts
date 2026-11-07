// Plan T062/T063 (rsc-updates B3; CA27, CA28): the administration asks for an update from the web. The service has no
// Docker, no passphrase and no credential: all it can do is leave an empty mark in a folder (update/request) and read
// the updater's report (update/report). What this pins, against a real PostgreSQL:
//   - only an administrator signed in to the web, and only after typing the password again (a wrong one counts as a
//     failed attempt and leaves no mark); a key, an app, a token, a service or a member never reaches it;
//   - the mark is an empty file made with `wx`, whatever else the request says (a version, an address, a command are
//     ignored: nothing from the request reaches the updater);
//   - two administrators at once: one mark, and the other is told an update is already on its way;
//   - off (no updater alive), companion mode (update it from rsc-factory) and nothing newer refuse with a reason;
//   - «Try again» only for a version that failed, within the updater's own limits;
//   - GET /v1/admin/system says what the screen needs and nothing more.
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { VERSION } from '../../src/core/version.ts'
import { recordUpdate } from '../../src/ops/backup/backup.ts'
import type { ReleaseChecker } from '../../src/ops/releases.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const PW = 'correct horse battery staple'
const NEWER = 'v9.9.9'

const checker = (latest: string | null): ReleaseChecker => ({
  state: () => ({
    installed: `v${VERSION}`,
    latest,
    notes: latest ? '- Faster search.' : null,
    checkedAt: latest ? '2026-10-29T09:00:00.000Z' : null,
    error: null,
    lastAttemptAt: latest ? '2026-10-29T09:00:00.000Z' : null,
  }),
  check: async () => {},
  start: () => {},
  stop: () => {},
})

describe('updating from the web: the request and the screen (rsc-updates B3)', { skip: skipPg }, () => {
  let w: World
  let tmp: string
  let request: string
  let report: string
  let ada: { id: string; key: string; email: string }
  let adaWeb: string
  let bob: { id: string; key: string }
  let bobWeb: string
  let rita: { id: string; key: string }
  let ritaWeb: string

  const withPassword = async (name: string, o: { isAdmin?: boolean } = {}) => {
    const p = await w.person(name, o)
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [p.id, await hashPassword(PW)])
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [p.id]))?.email)
    return { ...p, email }
  }
  // The updater is alive: it said so just now (the clock of the tests does not move by itself).
  const updaterSays = async (extra: Record<string, unknown> = {}) =>
    writeFile(
      join(report, 'updater.json'),
      JSON.stringify({ enabled: true, beatAt: w.now.toISOString(), attempts: {}, ...extra }),
    )
  const marks = async () => (await readdir(request)).sort()
  const clean = async () => {
    for (const f of await readdir(request)) await rm(join(request, f), { recursive: true, force: true })
    await rm(join(report, 'updater.json'), { force: true })
  }
  const asked = async (web: string, path = '/v1/admin/update', body: unknown = { password: PW }) =>
    w.callWeb(web, 'POST', path, body)
  const auditCount = async (action: string, outcome?: string) =>
    Number(
      (
        await w.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM audit WHERE action = $1 AND ($2::text IS NULL OR outcome = $2)',
          [action, outcome ?? null],
        )
      )?.n,
    )
  const failure = (to: string, retries: number, retryFrom: string | null) => ({
    attempts: {
      [to]: { failedAt: '2026-10-29T09:30:00.000Z', reason: 'the image did not build', retries, retryFrom },
    },
  })

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'brain-update-route-'))
    request = join(tmp, 'request')
    report = join(tmp, 'report')
    await mkdir(request)
    await mkdir(report)
    w = await world({ releases: checker(NEWER), update: { request, report } })
    ada = await withPassword('Ada', { isAdmin: true })
    adaWeb = await w.web(ada.id)
    bob = await withPassword('Bob', { isAdmin: true })
    bobWeb = await w.web(bob.id)
    rita = await withPassword('Rita')
    ritaWeb = await w.web(rita.id)
  })
  after(async () => {
    await w?.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('only an administrator in the web: a member 403, a key, a service, a token and an app 403 web_only; no mark', async () => {
    await clean()
    await updaterSays()
    const svc = await w.service('Robot')
    const app = await w.app(ada.id, [])
    const token = await w.token(ada.id)
    for (const path of ['/v1/admin/update', '/v1/admin/update/retry']) {
      const member = await asked(ritaWeb, path)
      assert.deepEqual(
        [member.status, member.body.error?.code],
        [403, 'forbidden'],
        `${path}: ${member.text}`,
      )
      for (const [who, key] of [
        ['main key', ada.key],
        ['service', svc.key],
        ['token', token],
        ['app', app],
      ] as const) {
        const r = await w.call(key, 'POST', path, { password: PW })
        assert.equal(r.status, 403, `${who} ${path}: ${r.text}`)
        assert.ok(['web_only', 'forbidden'].includes(String(r.body.error?.code)), `${who}: ${r.text}`)
      }
      const nobody = await w.call(null, 'POST', path, { password: PW })
      assert.equal(nobody.status, 401, nobody.text)
    }
    assert.deepEqual(await marks(), [])
  })

  it('the password is asked again: none or a wrong one is 401 reauth_failed, counted and audited, and no mark', async () => {
    await clean()
    await updaterSays()
    const failed0 = await auditCount('auth.failed')
    const none = await asked(adaWeb, '/v1/admin/update', {})
    assert.deepEqual([none.status, none.body.error?.code], [401, 'reauth_failed'], none.text)
    const wrong = await asked(adaWeb, '/v1/admin/update', { password: 'not it at all' })
    assert.deepEqual([wrong.status, wrong.body.error?.code], [401, 'reauth_failed'], wrong.text)
    assert.ok((await auditCount('auth.failed')) > failed0, 'a wrong password counts as a failed attempt')
    assert.deepEqual(await marks(), [])
    assert.equal(await auditCount('update.request', 'ok'), 0)
  })

  it('the right password leaves one empty mark, audited; the answer says what was asked for', async () => {
    await clean()
    await updaterSays()
    const r = await asked(adaWeb)
    assert.equal(r.status, 202, r.text)
    assert.deepEqual(r.body, { requested: true, to: NEWER })
    assert.deepEqual(await marks(), ['request'])
    const st = await lstat(join(request, 'request'))
    assert.ok(st.isFile())
    assert.equal(st.size, 0)
    assert.equal(await auditCount('update.request', 'ok'), 1)
    const line = await w.db.one<{ actor_id: string; detail: string }>(
      "SELECT actor_id, detail FROM audit WHERE action = 'update.request' ORDER BY at DESC, id DESC LIMIT 1",
    )
    assert.equal(line?.actor_id, ada.id)
    assert.doesNotMatch(String(line?.detail), new RegExp(PW))
  })

  it('whatever else the request carries is ignored: the mark stays empty and nothing else is made', async () => {
    await clean()
    await updaterSays()
    const r = await asked(bobWeb, '/v1/admin/update', {
      password: PW,
      version: 'v0.0.1',
      to: 'v0.0.1',
      repo: 'https://evil.example/x.git',
      url: 'https://evil.example/x.git',
      command: 'rm -rf /',
      args: ['--version', 'v0.0.1'],
      retry: true,
    })
    assert.equal(r.status, 202, r.text)
    assert.equal(r.body.to, NEWER)
    assert.deepEqual(await marks(), ['request'])
    assert.equal((await readFile(join(request, 'request'))).length, 0)
  })

  it('two administrators at once: one mark, and the other is told one is already running', async () => {
    await clean()
    await updaterSays()
    const both = await Promise.all([asked(adaWeb), asked(bobWeb)])
    const codes = both.map((x) => x.status).sort()
    assert.deepEqual(codes, [202, 409], both.map((x) => x.text).join(' | '))
    const loser = both.find((x) => x.status === 409)
    assert.equal(loser?.body.error?.code, 'update_running')
    assert.deepEqual(await marks(), ['request'])
    // And later, with the mark still there (the updater has not taken it yet).
    const again = await asked(adaWeb)
    assert.deepEqual([again.status, again.body.error?.code], [409, 'update_running'], again.text)
  })

  it('an update that is running (the updater says so) is not asked for again', async () => {
    await clean()
    await updaterSays({ running: { to: NEWER, startedAt: '2026-10-29T09:59:00.000Z' } })
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'update_running'], r.text)
    assert.deepEqual(await marks(), [])
  })

  it('a link or a folder at the name of the mark is never written through', async () => {
    await clean()
    await updaterSays()
    const target = join(tmp, 'elsewhere')
    await writeFile(target, 'keep')
    await symlink(target, join(request, 'request'))
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'update_running'], r.text)
    assert.equal(await readFile(target, 'utf8'), 'keep')
  })

  it('off: no updater alive (never run, stopped, or a beat too old) is 409 updates_off with the terminal command', async () => {
    await clean()
    const never = await asked(adaWeb)
    assert.deepEqual([never.status, never.body.error?.code], [409, 'updates_off'], never.text)
    assert.match(never.body.error?.howToProceed ?? '', /rsc-brain\.sh update/)
    await updaterSays({ beatAt: new Date(w.now.getTime() - 10 * 60_000).toISOString() })
    const stale = await asked(adaWeb)
    assert.deepEqual([stale.status, stale.body.error?.code], [409, 'updates_off'], stale.text)
    assert.deepEqual(await marks(), [])
    // A wrong password is still a wrong password first: the state is not told to whoever cannot prove who they are.
    const wrong = await asked(adaWeb, '/v1/admin/update', { password: 'nope' })
    assert.equal(wrong.status, 401, wrong.text)
  })

  it('nothing newer: 409 nothing_to_update', async () => {
    const v = await world({
      releases: checker(`v${VERSION}`),
      update: { request, report },
    })
    try {
      await clean()
      await updaterSays()
      const a = await v.person('Ada', { isAdmin: true })
      await v.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [a.id, await hashPassword(PW)])
      const web = await v.web(a.id)
      const r = await v.callWeb(web, 'POST', '/v1/admin/update', { password: PW })
      assert.deepEqual([r.status, r.body.error?.code], [409, 'nothing_to_update'], r.text)
      assert.deepEqual(await marks(), [])
    } finally {
      await v.close()
    }
  })

  it('companion mode: no button of its own, the answer sends to rsc-factory (CA28)', async () => {
    const v = await world({
      releases: checker(NEWER),
      update: { request, report },
      companion: {
        token: 'c'.repeat(40),
        network: '172.30.0.0/24',
        gateway: null,
        factoryUrl: 'https://factory.example.test',
        publicUrl: null,
      },
    })
    try {
      await clean()
      await updaterSays()
      const a = await v.person('Ada', { isAdmin: true })
      await v.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [a.id, await hashPassword(PW)])
      const web = await v.web(a.id)
      const r = await v.callWeb(web, 'POST', '/v1/admin/update', { password: PW })
      assert.deepEqual([r.status, r.body.error?.code], [409, 'companion'], r.text)
      assert.match(r.body.error?.message ?? '', /installed by rsc-factory: update it from there/)
      assert.match(r.body.error?.howToProceed ?? '', /factory\.example\.test/)
      assert.deepEqual(await marks(), [])
      const sys = await v.callWeb(web, 'GET', '/v1/admin/system')
      assert.equal((sys.body.update as { mode: string }).mode, 'companion')
      assert.equal((sys.body.update as { factoryUrl: string }).factoryUrl, 'https://factory.example.test')
    } finally {
      await v.close()
    }
  })

  it('try again: only for a version that failed, with both marks; not before the updater allows it, not past 3', async () => {
    await clean()
    const nothing = await (async () => {
      await updaterSays()
      return asked(adaWeb, '/v1/admin/update/retry')
    })()
    assert.deepEqual([nothing.status, nothing.body.error?.code], [409, 'nothing_to_retry'], nothing.text)

    const later = new Date(w.now.getTime() + 10 * 60_000).toISOString()
    await updaterSays(failure(NEWER, 0, later))
    const early = await asked(adaWeb, '/v1/admin/update/retry')
    assert.deepEqual([early.status, early.body.error?.code], [409, 'retry_later'], early.text)

    await updaterSays(failure(NEWER, 3, null))
    const spent = await asked(adaWeb, '/v1/admin/update/retry')
    assert.deepEqual([spent.status, spent.body.error?.code], [409, 'retry_limit'], spent.text)
    assert.match(spent.body.error?.howToProceed ?? '', /rsc-brain\.sh update/)

    // Another version's failure is not this one's.
    await updaterSays(failure('v9.9.8', 0, new Date(w.now.getTime() - 60_000).toISOString()))
    const other = await asked(adaWeb, '/v1/admin/update/retry')
    assert.deepEqual([other.status, other.body.error?.code], [409, 'nothing_to_retry'], other.text)
    assert.deepEqual(await marks(), [])

    await updaterSays(failure(NEWER, 1, new Date(w.now.getTime() - 60_000).toISOString()))
    const wrong = await asked(adaWeb, '/v1/admin/update/retry', { password: 'nope' })
    assert.equal(wrong.status, 401, wrong.text)
    assert.deepEqual(await marks(), [])
    const ok = await asked(adaWeb, '/v1/admin/update/retry', { password: PW, retries: 0, version: 'v1.0.0' })
    assert.equal(ok.status, 202, ok.text)
    assert.deepEqual(ok.body, { requested: true, to: NEWER })
    assert.deepEqual(await marks(), ['request', 'retry'])
    for (const f of await marks()) assert.equal((await readFile(join(request, f))).length, 0)
    assert.equal(await auditCount('update.retry', 'ok'), 1)
  })

  it('a plain request for a version that failed is not a retry: the updater would ignore it, so it is refused', async () => {
    await clean()
    await updaterSays(failure(NEWER, 1, new Date(w.now.getTime() - 60_000).toISOString()))
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'update_failed'], r.text)
    assert.deepEqual(await marks(), [])
  })

  it('the system answer says what the screen needs: mode, running, requested, failures and the last update; no paths', async () => {
    await clean()
    const off = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.deepEqual(off.body.update, {
      mode: 'off',
      factoryUrl: null,
      requested: false,
      running: null,
      attempts: [],
      refused: null,
      last: null,
    })

    await updaterSays({
      running: { to: NEWER, startedAt: '2026-10-29T09:59:00.000Z' },
      ...failure('v9.9.8', 2, '2026-10-29T10:15:00.000Z'),
    })
    await writeFile(join(request, 'request'), '')
    const on = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.deepEqual(on.body.update, {
      mode: 'on',
      factoryUrl: null,
      requested: true,
      running: { to: NEWER, startedAt: '2026-10-29T09:59:00.000Z' },
      attempts: [
        {
          version: 'v9.9.8',
          failedAt: '2026-10-29T09:30:00.000Z',
          reason: 'the image did not build',
          retries: 2,
          retryFrom: '2026-10-29T10:15:00.000Z',
        },
      ],
      refused: null,
      last: null,
    })
    assert.doesNotMatch(on.text, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const member = await w.callWeb(ritaWeb, 'GET', '/v1/admin/system')
    assert.equal(member.status, 403)
  })

  it('a refusal is shown and spends nothing; a way back that failed stops both Update and Try again (closing review)', async () => {
    await clean()
    await updaterSays({
      refused: { to: NEWER, at: '2026-10-29T09:58:00.000Z', reason: 'Cannot update: not enough disk.' },
    })
    const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.deepEqual((sys.body as { update: { refused: unknown } }).update.refused, {
      version: NEWER,
      at: '2026-10-29T09:58:00.000Z',
      reason: 'Cannot update: not enough disk.',
    })
    const again = await asked(adaWeb)
    assert.equal(again.status, 202, again.text)
  })

  it('what the report says is not trusted: a version that is not a published one, a huge or broken file is nothing', async () => {
    await clean()
    await updaterSays({
      running: { to: '$(rm -rf /)', startedAt: 'yesterday' },
      attempts: {
        // Well formed, but not a published version.
        'v1.2': { failedAt: '2026-10-29T09:30:00.000Z', reason: 'r', retries: 0, retryFrom: null },
        'v1.2.3; rm -rf /': {
          failedAt: '2026-10-29T09:30:00.000Z',
          reason: 'r',
          retries: 0,
          retryFrom: null,
        },
        // A published version, but a count and a time that are not.
        'v1.2.3': { failedAt: 'x', reason: 'r', retries: 'many', retryFrom: 'later' },
        'v1.2.4': { failedAt: '2026-10-29T09:30:00.000Z', reason: 'r', retries: -1, retryFrom: null },
        'v1.2.5': { failedAt: '2026-10-29T09:30:00.000Z', reason: 'r', retries: 1.5, retryFrom: null },
      },
    })
    const odd = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    const u = odd.body.update as { running: unknown; attempts: unknown[]; mode: string }
    assert.equal(u.running, null)
    assert.deepEqual(u.attempts, [])
    await writeFile(join(report, 'updater.json'), '{ not json')
    const broken = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.equal((broken.body.update as { mode: string }).mode, 'off')
  })

  it('the last update the launcher recorded is told in outcome, versions and time, never its log', async () => {
    const copies = await mkdtemp(join(tmpdir(), 'brain-update-last-'))
    const v = await world({ backups: copies, releases: checker(NEWER), update: { request, report } })
    try {
      const a = await v.person('Ada', { isAdmin: true })
      const web = await v.web(a.id)
      await recordUpdate(
        copies,
        { ok: false, from: '0.2.0', to: '0.3.0', log: 'migration 0025 failed: secret-ish line' },
        new Date('2026-10-29T09:00:00.000Z'),
      )
      const sys = await v.callWeb(web, 'GET', '/v1/admin/system')
      assert.deepEqual((sys.body.update as { last: unknown }).last, {
        ok: false,
        from: '0.2.0',
        to: '0.3.0',
        at: '2026-10-29T09:00:00.000Z',
      })
      assert.doesNotMatch(sys.text, /secret-ish/)
    } finally {
      await v.close()
      await rm(copies, { recursive: true, force: true })
    }
  })

  it('with a second factor the code is asked too: a missing or wrong one is 401 and leaves no mark; the right one is 202', async () => {
    await clean()
    await updaterSays()
    const mo = await withPassword('Mo', { isAdmin: true })
    const moWeb = await w.web(mo.id)
    const secret = String((await w.callWeb(moWeb, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(moWeb, 'POST', '/v1/me/totp/confirm', { code: totpAt(secret, stepOf(w.now)) })
    for (const path of ['/v1/admin/update', '/v1/admin/update/retry']) {
      const none = await asked(moWeb, path, { password: PW })
      assert.deepEqual([none.status, none.body.error?.code], [401, 'reauth_failed'], `${path}: ${none.text}`)
      const bad = await asked(moWeb, path, { password: PW, code: '000000' })
      assert.deepEqual([bad.status, bad.body.error?.code], [401, 'reauth_failed'], `${path}: ${bad.text}`)
    }
    assert.deepEqual(await marks(), [])
    w.advance(30_000)
    await updaterSays()
    const ok = await asked(moWeb, '/v1/admin/update', { password: PW, code: totpAt(secret, stepOf(w.now)) })
    assert.equal(ok.status, 202, ok.text)
    assert.deepEqual(await marks(), ['request'])
  })

  it('what the updater gave as a reason is cut at 4000 characters and loses control characters, but not tabs or line ends', async () => {
    await clean()
    await updaterSays(failure(NEWER, 0, null))
    const set = async (reason: string) =>
      updaterSays({
        attempts: {
          [NEWER]: { failedAt: '2026-10-29T09:30:00.000Z', reason, retries: 0, retryFrom: null },
        },
      })
    const reasonOf = async () => {
      const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
      return (sys.body.update as { attempts: Array<{ reason: string }> }).attempts[0]?.reason
    }
    await set('a'.repeat(4000))
    assert.equal((await reasonOf())?.length, 4000)
    await set('a'.repeat(5000))
    assert.equal((await reasonOf())?.length, 4000)
    await set('\u001b[31mred\u001b[0m\u0007\u0000\u007f\u0085 ok\tone\ntwo')
    assert.equal(await reasonOf(), '[31mred[0m ok\tone\ntwo')
  })

  it('the edges of the control characters: 0x08, 0x0B, 0x1F, 0x9F go; 0x09, 0x0A, 0x20, 0xA0 stay; a carriage return goes like the launcher drops it', async () => {
    await clean()
    await updaterSays(failure(NEWER, 0, null))
    const reasonOf = async (reason: string) => {
      await updaterSays({
        attempts: { [NEWER]: { failedAt: '2026-10-29T09:30:00.000Z', reason, retries: 0, retryFrom: null } },
      })
      const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
      return (sys.body.update as { attempts: Array<{ reason: string }> }).attempts[0]?.reason
    }
    const gone = ['\u0008', '\u000b', '\u001f', '\u009f']
    const stays = ['\u0009', '\u000a', '\u0020', '\u00a0']
    for (const c of gone)
      assert.equal(await reasonOf(`a${c}b`), 'ab', `U+${c.charCodeAt(0).toString(16)} goes`)
    for (const c of stays)
      assert.equal(await reasonOf(`a${c}b`), `a${c}b`, `U+${c.charCodeAt(0).toString(16)} stays`)
    // A carriage return is a control character like the others: removed, so «a\r\nb» reads «a\nb» (the launcher's
    // `printable` removes it too, so the web and the terminal show the same).
    assert.equal(await reasonOf('a\r\nb'), 'a\nb')
  })

  it('the limits are exact: 3 tries spent is the limit even when the time has passed; the time itself allows, a moment before does not', async () => {
    await clean()
    await updaterSays(failure(NEWER, 3, new Date(w.now.getTime() - 60_000).toISOString()))
    const spent = await asked(adaWeb, '/v1/admin/update/retry')
    assert.deepEqual([spent.status, spent.body.error?.code], [409, 'retry_limit'], spent.text)
    await updaterSays(failure(NEWER, 2, new Date(w.now.getTime() + 1).toISOString()))
    const early = await asked(adaWeb, '/v1/admin/update/retry')
    assert.deepEqual([early.status, early.body.error?.code], [409, 'retry_later'], early.text)
    await updaterSays(failure(NEWER, 2, w.now.toISOString()))
    const exact = await asked(adaWeb, '/v1/admin/update/retry')
    assert.equal(exact.status, 202, exact.text)
  })

  it('retries left but no time given (retryFrom null) is not an open door: the retry is refused as past the limit, and a plain request says only the server can', async () => {
    await clean()
    await updaterSays(failure(NEWER, 1, null))
    const retry = await asked(adaWeb, '/v1/admin/update/retry')
    assert.deepEqual([retry.status, retry.body.error?.code], [409, 'retry_limit'], retry.text)
    const plain = await asked(adaWeb)
    assert.deepEqual([plain.status, plain.body.error?.code], [409, 'update_failed'], plain.text)
    assert.doesNotMatch(plain.body.error?.howToProceed ?? '', /Try again/)
    assert.deepEqual(await marks(), [])
  })

  it('a mark that is only the retry mark still counts as a request waiting', async () => {
    await clean()
    await updaterSays()
    await writeFile(join(request, 'retry'), '')
    const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.equal((sys.body.update as { requested: boolean }).requested, true)
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'update_running'], r.text)
  })

  it('a plain request for a version out of retries says only the server can update, not «Try again»', async () => {
    await clean()
    await updaterSays(failure(NEWER, 3, null))
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'update_failed'], r.text)
    assert.doesNotMatch(r.body.error?.howToProceed ?? '', /Try again/)
    assert.match(r.body.error?.howToProceed ?? '', /rsc-brain\.sh update/)
    await updaterSays(failure(NEWER, 3, new Date(w.now.getTime() - 60_000).toISOString()))
    const past = await asked(adaWeb)
    assert.doesNotMatch(past.body.error?.howToProceed ?? '', /Try again/)
    // While it can still be tried again, the page says so.
    await updaterSays(failure(NEWER, 1, new Date(w.now.getTime() - 60_000).toISOString()))
    const can = await asked(adaWeb)
    assert.match(can.body.error?.howToProceed ?? '', /Try again/)
  })

  it('an update that has been running far longer than the beat limit, with the updater still beating, reads running and a second request is update_running', async () => {
    await clean()
    const long = new Date(w.now.getTime() - 45 * 60_000).toISOString()
    await updaterSays({ running: { to: NEWER, startedAt: long } })
    const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    const u = sys.body.update as { mode: string; running: { to: string; startedAt: string } | null }
    assert.equal(u.mode, 'on')
    assert.deepEqual(u.running, { to: NEWER, startedAt: long })
    const again = await asked(adaWeb)
    assert.deepEqual([again.status, again.body.error?.code], [409, 'update_running'], again.text)
    assert.deepEqual(await marks(), [])
  })

  it('an updater that died mid-update stops beating: after the limit the mode is off and nothing is running, and a request is updates_off', async () => {
    await clean()
    const limit = 120_000
    await updaterSays({ running: { to: NEWER, startedAt: new Date(w.now.getTime() - 60_000).toISOString() } })
    w.advance(limit)
    const edge = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.equal((edge.body.update as { mode: string }).mode, 'on', 'at the limit it still counts as alive')
    w.advance(1000)
    const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    const u = sys.body.update as { mode: string; running: unknown }
    assert.deepEqual([u.mode, u.running], ['off', null])
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'updates_off'], r.text)
  })

  it('an updater that is being turned off (enabled:false, disabling:true) reads as off, however fresh its beat', async () => {
    await clean()
    await updaterSays({ enabled: false, disabling: true })
    const sys = await w.callWeb(adaWeb, 'GET', '/v1/admin/system')
    assert.equal((sys.body.update as { mode: string }).mode, 'off')
    const r = await asked(adaWeb)
    assert.deepEqual([r.status, r.body.error?.code], [409, 'updates_off'], r.text)
    assert.deepEqual(await marks(), [])
  })
})
