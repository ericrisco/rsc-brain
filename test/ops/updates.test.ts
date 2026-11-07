// The mark that asks the updater to update (rsc-updates B3; CA20, CA21, CA24), at the point where the file is made, with
// no database and no server: it is made new (`wx`) and empty, so two askers at once leave one mark and the other hears
// that an update is on its way; a link or a folder at its name is never written through; a folder that cannot be written
// is said without telling where it is.
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { AppError } from '../../src/core/errors.ts'
import { updates } from '../../src/ops/updates.ts'

describe('the request mark', () => {
  let tmp: string
  let request: string
  let report: string
  const make = (o: { request?: string | null } = {}) =>
    updates({
      request: o.request === undefined ? request : o.request,
      report,
      clock: () => new Date('2026-11-05T10:00:00.000Z'),
      companion: false,
      factoryUrl: null,
    })
  const code = async (p: Promise<unknown>) => {
    try {
      await p
      return 'made'
    } catch (e) {
      return e instanceof AppError ? e.code : `other: ${e}`
    }
  }
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-updates-mark-'))
    request = join(tmp, 'request')
    report = join(tmp, 'report')
    mkdirSync(request)
    mkdirSync(report)
  })
  after(() => rmSync(tmp, { recursive: true, force: true }))

  it('is an empty file for its owner only; the retry mark is another, also empty', async () => {
    await make().mark(true)
    for (const name of ['request', 'retry']) {
      const st = lstatSync(join(request, name))
      assert.ok(st.isFile())
      assert.equal(st.size, 0)
      assert.equal(st.mode & 0o777, 0o600)
    }
    rmSync(join(request, 'request'))
    rmSync(join(request, 'retry'))
  })

  it('made new: a second one is update_running, and the first is as it was', async () => {
    await make().mark(false)
    writeFileSync(join(request, 'request'), 'kept')
    assert.equal(await code(make().mark(false)), 'update_running')
    assert.equal(readFileSync(join(request, 'request'), 'utf8'), 'kept')
    rmSync(join(request, 'request'))
  })

  it('at once: exactly one is made, the others hear that one is on its way', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => code(make().mark(false))))
    assert.equal(results.filter((r) => r === 'made').length, 1, results.join(','))
    assert.equal(results.filter((r) => r === 'update_running').length, 11, results.join(','))
    assert.deepEqual(await readdir(request), ['request'])
    rmSync(join(request, 'request'))
  })

  it('a link at its name is not written through, not even a dangling one', async () => {
    const target = join(tmp, 'target')
    writeFileSync(target, 'keep')
    symlinkSync(target, join(request, 'request'))
    assert.equal(await code(make().mark(false)), 'update_running')
    assert.equal(readFileSync(target, 'utf8'), 'keep')
    rmSync(join(request, 'request'))
    symlinkSync(join(tmp, 'not-there'), join(request, 'request'))
    assert.equal(await code(make().mark(false)), 'update_running')
    assert.deepEqual(await readdir(tmp).then((l) => l.filter((f) => f === 'not-there')), [])
    rmSync(join(request, 'request'))
  })

  it('a folder that is not there, or no folder at all: update_not_started, without saying where', async () => {
    const gone = make({ request: join(tmp, 'nowhere') })
    const err = await gone.mark(false).catch((e: unknown) => e)
    assert.ok(err instanceof AppError)
    assert.equal(err.code, 'update_not_started')
    assert.equal(err.message.includes(tmp) || err.howToProceed.includes(tmp), false)
    assert.equal(await code(make({ request: null }).mark(false)), 'update_not_started')
  })
})

describe('what the updater reports besides the attempts (closing review, findings 2 and 3)', () => {
  let tmp: string
  const NOW = new Date('2026-11-05T10:00:00.000Z')
  const view = { installed: 'v0.2.0', latest: 'v0.3.0', newer: true } as never
  const make = () =>
    updates({
      request: join(tmp, 'request'),
      report: join(tmp, 'report'),
      clock: () => NOW,
      companion: false,
      factoryUrl: null,
    })
  const says = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(tmp, 'report', 'updater.json'),
      JSON.stringify({ enabled: true, beatAt: NOW.toISOString(), attempts: {}, ...extra }),
    )
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-updates-report-'))
    mkdirSync(join(tmp, 'request'))
    mkdirSync(join(tmp, 'report'))
  })
  after(() => rmSync(tmp, { recursive: true, force: true }))

  it('a refused request: the version, when and why come through, trimmed and cleaned', () => {
    says({
      refused: {
        to: 'v0.3.0',
        at: '2026-11-05T09:58:00.000Z',
        reason: 'Cannot update: not enough disk.\u0007',
      },
    })
    assert.deepEqual(make().state().refused, {
      version: 'v0.3.0',
      at: '2026-11-05T09:58:00.000Z',
      reason: 'Cannot update: not enough disk.',
    })
    assert.equal(
      make().refusal(view, false),
      null,
      'a refusal is not a failed attempt: it can be asked again',
    )
  })

  it('a refusal that is not shaped right is ignored', () => {
    for (const refused of [
      null,
      'x',
      { to: 'latest', at: '2026-11-05T09:58:00.000Z', reason: 'x' },
      { to: 'v0.3.0', at: 'yesterday', reason: 'x' },
      { to: 'v0.3.0', at: '2026-11-05T09:58:00.000Z', reason: 5 },
    ]) {
      says({ refused })
      assert.equal(make().state().refused, null, JSON.stringify(refused))
    }
  })

  const wrecked = {
    from: '0.2.0',
    to: '0.3.0',
    copy: 'rsc-brain-1-pre-update.rscb',
    restore: 'sh rsc-brain.sh restore --file x.rscb --confirm <name> --dir "/srv/b"',
  }
  it('a way back that could not restore: the state says so, and neither Update nor Try again is allowed', () => {
    says({ rollbackFailed: wrecked })
    const u = make()
    assert.deepEqual(u.state().rollbackFailed, wrecked)
    for (const retry of [false, true]) {
      const no = u.refusal(view, retry)
      assert.equal(no?.code, 'rollback_failed', String(retry))
      assert.equal(no?.status, 409)
      assert.match(no?.howToProceed ?? '', /restore --file x\.rscb/)
    }
    // Even with a failed attempt that would otherwise allow a retry.
    says({
      rollbackFailed: wrecked,
      attempts: {
        'v0.3.0': {
          failedAt: '2026-11-05T09:00:00.000Z',
          reason: 'x',
          retries: 0,
          retryFrom: '2026-11-05T09:15:00.000Z',
        },
      },
    })
    assert.equal(make().refusal(view, true)?.code, 'rollback_failed')
  })

  it('without it, or with a bad one, nothing changes', () => {
    says({})
    assert.equal(make().state().rollbackFailed, null)
    says({ rollbackFailed: { from: 1 } })
    assert.equal(make().state().rollbackFailed, null)
    assert.equal(make().refusal(view, false), null)
  })
})
