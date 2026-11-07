// Updating from the web (rsc-updates §3.9, B3; spec CA27, CA28). The service has no Docker, no passphrase and no
// credential: the only thing it does is leave an empty mark in a folder (update/request: `request`, and `retry` after
// a failure) which a container of its own, the updater, looks at and answers by running `rsc-brain.sh update`. It
// never writes a version, an address or a command: the updater finds the newest published version itself and ignores
// what is in the mark (the mark is not even read). What the service learns about the update comes the other way, from
// the updater's report (update/report/updater.json), read only, as small text that is not trusted: a version has to be
// a published one, a time a time, a count a number.
//
// Three modes: `off` (no updater alive: the terminal command is shown), `on` (an updater beats), `companion` (rsc-brain
// was installed by rsc-factory, which updates it: this screen has no button and points there).
import { lstatSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock } from '../core/clock.ts'
import { AppError } from '../core/errors.ts'
import { instant, isPublished, type ReleaseView, readReport, updaterAlive } from './releases.ts'

// The updater's own limits (deploy/updater/loop.sh): a version that failed is tried again at most this many times.
export const MAX_RETRIES = 3
const REASON_MAX = 4000

export type UpdateMode = 'off' | 'on' | 'companion'
export type UpdateAttempt = {
  version: string
  failedAt: string
  reason: string
  retries: number
  // When the updater lets it be tried again; null once the limit is spent (only the terminal can then).
  retryFrom: string | null
}
// A request the launcher refused (nothing was stopped, no attempt spent): what was missing, as the launcher said it.
export type UpdateRefusal = { version: string; at: string; reason: string }
// A way back that could not restore the copy: the data may not be as it was, and only the terminal goes on from here.
export type RollbackFailed = { from: string; to: string; copy: string; restore: string }
export type UpdateState = {
  mode: UpdateMode
  factoryUrl: string | null
  // A request mark is waiting for the updater to take it.
  requested: boolean
  running: { to: string; startedAt: string | null } | null
  attempts: UpdateAttempt[]
  refused: UpdateRefusal | null
  rollbackFailed: RollbackFailed | null
}
export type UpdateConfig = {
  // The folder of the marks (update/request) and of the report (update/report); null where there is none.
  request?: string | null
  report?: string | null
}
export type Updates = {
  state(): UpdateState
  // Leaves the mark(s); `retry` also leaves the one that says «try again». 409 update_running when one is there.
  mark(retry: boolean): Promise<void>
  // Why this cannot be asked for now, or null when it can.
  refusal(view: ReleaseView, retry: boolean): AppError | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

const text = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(CONTROLS, '').slice(0, max) : null

const COMMAND = 'rsc-brain.sh update'
const terminal = `On the server, run: ${COMMAND}`

export function updates(
  o: UpdateConfig & { clock: Clock; factoryUrl: string | null; companion: boolean },
): Updates {
  const exists = (path: string) => {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  }
  const state = (): UpdateState => {
    const base: UpdateState = {
      mode: 'off',
      factoryUrl: o.companion ? o.factoryUrl : null,
      requested: false,
      running: null,
      attempts: [],
      refused: null,
      rollbackFailed: null,
    }
    if (o.companion) return { ...base, mode: 'companion' }
    if (!o.report || !o.request || !updaterAlive(o.report, o.clock().getTime())) return base
    const u = readReport(o.report, 'updater.json')
    const run = isRecord(u) && isRecord(u.running) ? u.running : null
    const to = typeof run?.to === 'string' && isPublished(run.to) ? run.to : null
    const attempts: UpdateAttempt[] = []
    if (isRecord(u) && isRecord(u.attempts)) {
      for (const [version, a] of Object.entries(u.attempts)) {
        if (!isPublished(version) || !isRecord(a)) continue
        const failedAt = instant(a.failedAt)
        const retries = a.retries
        if (failedAt === null || typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0)
          continue
        const reason = typeof a.reason === 'string' ? a.reason.replace(CONTROLS, '').slice(0, REASON_MAX) : ''
        attempts.push({ version, failedAt, reason, retries, retryFrom: instant(a.retryFrom) })
      }
    }
    let refused: UpdateRefusal | null = null
    if (isRecord(u) && isRecord(u.refused)) {
      const at = instant(u.refused.at)
      const reason = text(u.refused.reason, REASON_MAX)
      const to = u.refused.to
      if (typeof to === 'string' && isPublished(to) && at !== null && reason !== null)
        refused = { version: to, at, reason }
    }
    // The mark exists whenever the updater says so (it blocks on the file itself): fields that are missing or not
    // text are empty, and the page says the details could not be read.
    let rollbackFailed: RollbackFailed | null = null
    if (isRecord(u) && isRecord(u.rollbackFailed)) {
      const r = u.rollbackFailed
      const f = (v: unknown) => text(v, 1000) ?? ''
      rollbackFailed = { from: f(r.from), to: f(r.to), copy: f(r.copy), restore: f(r.restore) }
    }
    return {
      ...base,
      mode: 'on',
      refused,
      rollbackFailed,
      requested: exists(join(o.request, 'request')) || exists(join(o.request, 'retry')),
      running: to ? { to, startedAt: instant(run?.startedAt) } : null,
      attempts,
    }
  }

  const running = () =>
    new AppError(
      409,
      'update_running',
      'An update is already running.',
      'Wait for it to finish; this page shows how it goes.',
    )

  // A mark is made new (`wx`): one already there, a link included, is not written through and means an update is on
  // its way. Empty, readable by its owner only.
  const leave = async (name: string) => {
    if (!o.request) throw unavailable()
    let fh: Awaited<ReturnType<typeof open>> | undefined
    try {
      fh = await open(join(o.request, name), 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw running()
      throw unavailable()
    } finally {
      await fh?.close()
    }
  }
  const unavailable = () =>
    new AppError(
      503,
      'update_not_started',
      'The request could not be left for the updater.',
      `${terminal}. Or check that the folder update/request can be written by the service.`,
    )

  return {
    state,
    async mark(retry) {
      await leave('request')
      if (retry) await leave('retry')
    },
    refusal(view, retry) {
      const s = state()
      if (s.mode === 'companion') {
        return new AppError(
          409,
          'companion',
          'rsc-brain was installed by rsc-factory: update it from there.',
          s.factoryUrl
            ? `Open rsc-factory at ${s.factoryUrl} and update from Admin › Updates.`
            : 'Open rsc-factory and update from Admin › Updates.',
        )
      }
      if (s.mode === 'off') {
        return new AppError(
          409,
          'updates_off',
          'Updating from the web is off on this installation.',
          `${terminal}. To turn the button on: rsc-brain.sh web-updates enable`,
        )
      }
      if (s.requested || s.running) return running()
      if (s.rollbackFailed) {
        const { to, restore } = s.rollbackFailed
        return new AppError(
          409,
          'rollback_failed',
          `The last update${to ? ` to ${to}` : ''} failed, and rsc-brain could not go back by itself: the data may not be as it was.`,
          restore
            ? `Do not update again. On the server, restore the copy made before it (everyone signs in again afterwards): ${restore}`
            : 'Do not update again. On the server, run rsc-brain.sh status: it says what to restore (everyone signs in again afterwards).',
        )
      }
      if (!view.newer || !view.latest) {
        return new AppError(
          409,
          'nothing_to_update',
          'There is no newer version to update to.',
          'Nothing to do.',
        )
      }
      const failed = s.attempts.find((a) => a.version === view.latest)
      if (!retry) {
        if (!failed) return null
        // The page offers «Try again» only while the updater allows one; past its limit only the server can.
        const spent = failed.retries >= MAX_RETRIES || failed.retryFrom === null
        return new AppError(
          409,
          'update_failed',
          `The update to ${view.latest} failed.`,
          spent
            ? `${terminal}. It failed too many times from the web.`
            : `Use «Try again» on this page, or update on the server: ${COMMAND}`,
        )
      }
      if (!failed) {
        return new AppError(
          409,
          'nothing_to_retry',
          `The update to ${view.latest} has not failed.`,
          'Use «Update» instead.',
        )
      }
      if (failed.retries >= MAX_RETRIES || failed.retryFrom === null) {
        return new AppError(
          409,
          'retry_limit',
          `The update to ${view.latest} failed ${MAX_RETRIES + 1} times from the web.`,
          `${terminal}. It reports what went wrong.`,
        )
      }
      if (o.clock().getTime() < Date.parse(failed.retryFrom)) {
        return new AppError(
          409,
          'retry_later',
          'It is too soon to try again.',
          `Try again after ${failed.retryFrom}, or update on the server: ${COMMAND}`,
        )
      }
      return null
    },
  }
}
