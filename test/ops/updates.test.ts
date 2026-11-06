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
