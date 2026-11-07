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
  // The launcher refused the last request (nothing was stopped): what was missing.
  refused: { version: string; at: string; reason: string } | null
  // A way back that could not restore: the data may not be as it was. Null when none.
  rollbackFailed: { from: string; to: string; copy: string; restore: string } | null
  last: { ok: boolean; from: string; to: string; at: string } | null
}

export type UpdateView =
  // Only the command: no updater runs, there is nothing newer, or the server does not say.
  | { kind: 'terminal' }
  // Installed by rsc-factory: it updates rsc-brain.
  | { kind: 'companion'; factoryUrl: string | null }
  | { kind: 'available'; to: string; refused?: { at: string; reason: string } }
  // A way back that could not restore the copy: no button, no retry; what happened and the steps on the server.
  | { kind: 'unsafe'; from: string; to: string; restore: string }
  | { kind: 'waiting' }
  | { kind: 'running'; to: string }
  | {
      kind: 'failed'
      to: string
      failedAt: string
      reason: string
      // The launcher refused a request after this failure (nothing was stopped): what was missing.
      refused?: { at: string; reason: string }
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
  if (u.rollbackFailed) {
    const { from, to, restore } = u.rollbackFailed
    return { kind: 'unsafe', from, to, restore }
  }
  if (!release.newer || !release.latest) return { kind: 'terminal' }
  const failed = u.attempts.find((a) => a.version === release.latest)
  if (!failed) {
    const r = u.refused?.version === release.latest ? u.refused : null
    return r
      ? { kind: 'available', to: release.latest, refused: { at: r.at, reason: r.reason } }
      : { kind: 'available', to: release.latest }
  }
  const retry =
    failed.retryFrom === null
      ? ('server' as const)
      : Date.parse(failed.retryFrom) > now.getTime()
        ? { from: failed.retryFrom }
        : ('now' as const)
  const r = u.refused?.version === release.latest ? u.refused : null
  const out = {
    kind: 'failed' as const,
    to: release.latest,
    failedAt: failed.failedAt,
    reason: failed.reason,
    retry,
  }
  return r ? { ...out, refused: { at: r.at, reason: r.reason } } : out
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
