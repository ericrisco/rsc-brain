// Settings come from the environment, read once at start. Nothing secret has a default.
import { SERVICE_INVITES_PER_HOUR } from './domain/invite-quota.ts'
import { DEFAULT_BACKUP_AT, DEFAULT_BACKUP_KEEP, parseBackupAt } from './ops/backup/schedule.ts'

export type Config = {
  databaseUrl: string
  port: number
  host: string
  timezone: string
  // Seals what the server must read back (second-factor seeds, the mail password). Optional; without
  // it those features say how to turn them on.
  secret: string | undefined
  // Proxies in front of Brain whose X-Forwarded-Proto / X-Forwarded-For are believed.
  trustedProxies: string[]
  // «This machine only» (spec B7 C19): in a container published on 127.0.0.1 alone, a plain request from the
  // container's gateway counts as this machine (src/http/conn.ts).
  localOnly: boolean
  // The folder of the copies (in the container, /backups); unset, nothing is said about its free space.
  backups: string | undefined
  // The daily copy: at HH:MM of the time zone, keeping this many (spec B7 C2).
  backupAt: string
  backupKeep: number
  // How many invitation mails one service account may make rsc-brain send in an hour (F1-PR2 review).
  serviceInvitesPerHour: number
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.RSC_BRAIN_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('RSC_BRAIN_DATABASE_URL is not set. Point it at the PostgreSQL database for rsc-brain.')
  }
  const port = Number(env.RSC_BRAIN_PORT ?? 8090)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`RSC_BRAIN_PORT must be a port number, got "${env.RSC_BRAIN_PORT}".`)
  }
  const timezone = env.RSC_BRAIN_TIMEZONE ?? 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
  } catch {
    throw new Error(
      `RSC_BRAIN_TIMEZONE "${timezone}" is not a time zone. Use a name such as Europe/Madrid or UTC.`,
    )
  }
  const secret = env.RSC_BRAIN_SECRET
  if (secret !== undefined && secret.length < 32) {
    throw new Error('RSC_BRAIN_SECRET must have at least 32 characters. Generate a long random value.')
  }
  const backupAt = parseBackupAt(env.RSC_BRAIN_BACKUP_AT ?? DEFAULT_BACKUP_AT)
  const keepText = env.RSC_BRAIN_BACKUP_KEEP ?? String(DEFAULT_BACKUP_KEEP)
  const backupKeep = Number(keepText)
  if (!/^\d+$/.test(keepText) || backupKeep < 1 || backupKeep > 365) {
    throw new Error(`RSC_BRAIN_BACKUP_KEEP must be a whole number from 1 to 365, got "${keepText}".`)
  }
  const perHourText = env.RSC_BRAIN_SERVICE_INVITES_PER_HOUR ?? String(SERVICE_INVITES_PER_HOUR)
  const serviceInvitesPerHour = Number(perHourText)
  if (!/^\d+$/.test(perHourText) || serviceInvitesPerHour < 1 || serviceInvitesPerHour > 100_000) {
    throw new Error(
      `RSC_BRAIN_SERVICE_INVITES_PER_HOUR must be a whole number from 1 to 100000, got "${perHourText}".`,
    )
  }
  const localOnly = readLocalOnly(env)
  return {
    databaseUrl,
    port,
    host: env.RSC_BRAIN_HOST ?? '127.0.0.1',
    timezone,
    secret,
    trustedProxies: (env.RSC_BRAIN_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    localOnly,
    backups: env.RSC_BRAIN_BACKUPS || undefined,
    backupAt,
    backupKeep,
    serviceInvitesPerHour,
  }
}

// RSC_BRAIN_LOCAL_ONLY trusts the container's gateway as this machine, which is only true when the port is published
// on the loopback address alone (RSC_BRAIN_PUBLISH, the address the launcher publishes on). Published to the network,
// everyone would arrive from the gateway and a password would cross it in clear: the service does not start.
function readLocalOnly(env: NodeJS.ProcessEnv): boolean {
  const flag = env.RSC_BRAIN_LOCAL_ONLY ?? ''
  if (flag === '' || flag === '0') return false
  if (flag !== '1') throw new Error(`RSC_BRAIN_LOCAL_ONLY must be 1 or 0, got "${flag}".`)
  const publish = env.RSC_BRAIN_PUBLISH ?? ''
  if (!/^(127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(publish)) {
    throw new Error(
      'RSC_BRAIN_LOCAL_ONLY=1 needs RSC_BRAIN_PUBLISH set to 127.0.0.1:<port> (or [::1]:<port>): this machine only ' +
        'is true only when the port is published on the loopback address alone. Publish it there, or remove ' +
        'RSC_BRAIN_LOCAL_ONLY and give rsc-brain a domain with HTTPS.',
    )
  }
  return true
}
