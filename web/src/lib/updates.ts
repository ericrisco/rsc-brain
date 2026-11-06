// What the version part of Admin › Backups & system offers (rsc-updates B3). Out of the screen so each case is tested on
// its own (test/web/updates-logic.test.ts). The server decides what is allowed; this says only what to show.

export type UpdateAttempt = {
  version: string
  failedAt: string
  reason: string
  retries: number
  retryFrom: string | null
}
export type UpdateInfo = {
  mode: 'off' | 'on' | 'companion'
  factoryUrl: string | null
  requested: boolean
  running: { to: string; startedAt: string | null } | null
  attempts: UpdateAttempt[]
  last: { ok: boolean; from: string; to: string; at: string } | null
}

export type UpdateView =
  // Only the command: no updater runs, there is nothing newer, or the server does not say.
  | { kind: 'terminal' }
  // Installed by rsc-factory: it updates rsc-brain.
  | { kind: 'companion'; factoryUrl: string | null }
  | { kind: 'available'; to: string }
  | { kind: 'waiting' }
  | { kind: 'running'; to: string }
  | {
      kind: 'failed'
      to: string
      failedAt: string
      reason: string
      // now: the button works; {from}: after that time; server: the web cannot try again, only the server.
      retry: 'now' | 'server' | { from: string }
    }

export function updateView(
  release: { installed: string; latest: string | null; newer: boolean },
  u: UpdateInfo | undefined,
  now: Date,
): UpdateView {
  if (!u || u.mode === 'off') return { kind: 'terminal' }
  if (u.mode === 'companion') return { kind: 'companion', factoryUrl: u.factoryUrl }
  if (u.running) return { kind: 'running', to: u.running.to }
  if (u.requested) return { kind: 'waiting' }
  if (!release.newer || !release.latest) return { kind: 'terminal' }
  const failed = u.attempts.find((a) => a.version === release.latest)
  if (!failed) return { kind: 'available', to: release.latest }
  const retry =
    failed.retryFrom === null
      ? ('server' as const)
      : Date.parse(failed.retryFrom) > now.getTime()
        ? { from: failed.retryFrom }
        : ('now' as const)
  return { kind: 'failed', to: release.latest, failedAt: failed.failedAt, reason: failed.reason, retry }
}

const bare = (v: string) => v.replace(/^v/, '')

// The last update the launcher recorded, when it is about the version running: it went well and this is where it
// went (CA17), or it failed and this is where it came back to.
export function lastUpdateFor(
  installed: string,
  last: UpdateInfo['last'] | undefined,
): NonNullable<UpdateInfo['last']> | null {
  if (!last) return null
  return (last.ok ? bare(last.to) : bare(last.from)) === bare(installed) ? last : null
}
