// The logic of Admin › Backups & system and of the wizard's step «Installation key» (spec B7 «Copias y
// restauración», plan §3.4; PR30), out of the screens so it is tested on its own: a failure and a warning in words,
// the band of the administration until a good copy, why a copy cannot be restored here, the name to type before a
// restore, and the file the installation key is saved in. Who may do what is the server's.

const FAILURES: Record<string, string> = {
  disk_full: 'the disk of the copies is full',
  no_permission: 'rsc-brain cannot write in the folder of the copies',
  no_installation_secret: 'the installation has no key (RSC_BRAIN_SECRET is not set)',
  weak_installation_key: 'the installation key is too short to protect a copy',
  database: 'the database did not answer as expected',
  busy: 'writes were still running after a minute',
  failed: 'it failed',
}
const HOW: Record<string, string> = {
  disk_full: 'Free space in the folder of the copies, or keep fewer, then make a copy again.',
  no_permission:
    'Let the user that runs rsc-brain write in the folder of the copies, then make a copy again.',
  no_installation_secret: 'Set RSC_BRAIN_SECRET for the service, restart it, then make a copy again.',
  weak_installation_key: 'Rotate to a long random key on the machine (rsc-brain.sh key rotate).',
  database: 'Make a copy again; if it fails again, look at the log of the service.',
  busy: 'Make a copy again in a few minutes.',
  failed: 'Make a copy again; if it fails again, look at the log of the service.',
}

// Why the last copy failed, in words; an unknown category still says it failed.
export function failureText(category: string): string {
  const why = FAILURES[category] ?? FAILURES.failed
  return `The last copy failed: ${why}. ${HOW[category] ?? HOW.failed}`
}

const WARNINGS: Record<string, string> = {
  fsync_failed: 'the folder could not be flushed to disk',
  status_not_saved: 'its status could not be saved next to the copies',
  disk_full: 'the disk of the copies filled up right after it',
  no_permission: 'rsc-brain could not write its status in the folder of the copies',
}

// A copy kept whole, but with something after it not done.
export function warningText(code: string): string {
  return `A copy was kept whole, but ${WARNINGS[code] ?? 'something after it was not done'}. Check the disk of the copies.`
}

const REASONS: Record<string, string> = {
  scheduled: 'Daily',
  manual: 'By hand',
  'pre-update': 'Before an update',
  'pre-restore': 'Before a restore',
}
export const reasonLabel = (reason: string) => REASONS[reason] ?? reason

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

type Ok = { at: string; file: string } | null
type Failure = { at: string; category: string } | null

// The band at the top of the administration: the last failure, until a good copy is made after it.
export function bandOf(s: { lastOk: Ok; lastFailure: Failure } | undefined): Failure {
  if (!s?.lastFailure) return null
  if (s.lastOk && s.lastOk.at > s.lastFailure.at) return null
  return s.lastFailure
}

// Why this copy cannot be restored from here now, or null.
export function restoreBlocked(
  item: { needsOldKey: boolean },
  o: { running: boolean; online: boolean },
): string | null {
  if (!o.online) return 'You are offline: restoring needs the server.'
  if (item.needsOldKey)
    return 'Made with an older key: restore it on the machine with that key (rsc-brain restore --key-file).'
  if (o.running) return 'A copy is being made: restore when it ends.'
  return null
}

// What is wrong with the name typed to confirm a restore, or null when it is the installation's, exactly.
export function confirmProblem(typed: string, name: string): string | null {
  if (typed === name) return null
  if (!typed) return `Type the name of this installation: ${name}`
  return `Type the name exactly as it is: ${name}`
}

// The file the installation key is saved in holds the key alone, so `rsc-brain restore --key-file <file>` reads it as
// it is; its name says which installation and which key (its id) it is.
export const keyFile = (key: string) => `${key}\n`

export function keyFileName(name: string, keyId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `rsc-brain-key-${slug ? `${slug}-` : ''}${keyId}.txt`
}

// The last update, as the launcher records it (plan §3.9): whether it went well, from and to which version, when, and
// for a failed one the service's last lines. Anything else is no update.
export type LastUpdate = { ok: boolean; from: string; to: string; at: string; log: string | null }
export function lastUpdateOf(x: unknown): LastUpdate | null {
  if (typeof x !== 'object' || x === null) return null
  const u = x as Record<string, unknown>
  if (typeof u.ok !== 'boolean' || typeof u.from !== 'string' || typeof u.to !== 'string') return null
  if (typeof u.at !== 'string' || Number.isNaN(Date.parse(u.at))) return null
  return { ok: u.ok, from: u.from, to: u.to, at: u.at, log: typeof u.log === 'string' ? u.log : null }
}
export function lastUpdateText(u: LastUpdate): string {
  if (u.ok) return `Updated from ${u.from} to ${u.to}.`
  return (
    `The update from ${u.from} to ${u.to} failed. rsc-brain went back to ${u.from} with the data as it was just ` +
    'before the update: nothing written was lost, and sessions and keys still work.'
  )
}
