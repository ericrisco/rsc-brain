#!/usr/bin/env node
// rsc-brain command line. Each command says what it did, or what to do when it cannot.
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { resealV1 } from '../auth/reseal.ts'
import { readConfig } from '../config.ts'
import { systemClock } from '../core/clock.ts'
import { AppError } from '../core/errors.ts'
import { failureFields, stdoutLog as log } from '../core/log.ts'
import { VERSION } from '../core/version.ts'
import { openPool } from '../db/db.ts'
import { migrate } from '../db/migrate.ts'
import { accountByEmail, createAccount } from '../domain/accounts.ts'
import { companionSetup, setupDone } from '../domain/installation.ts'
import { mintMainKey, mintPersonToken } from '../domain/keys.ts'
import { newReset, resetLink } from '../domain/login.ts'
import { type MaintenanceReason, maintenance, whenOpen } from '../domain/maintenance.ts'
import { embedRound } from '../domain/meaning.ts'
import { remindExpiringTokens } from '../domain/notices.ts'
import { closeIdle } from '../domain/sessions.ts'
import { foldTrail } from '../domain/trail.ts'
import { createHandler } from '../http/app.ts'
import { providersFromEnv } from '../meaning/providers.ts'
import { applyStored } from '../meaning/stored.ts'
import { backup, backupJob, readStatus } from '../ops/backup/backup.ts'
import { BACKUP_REASONS, type BackupReason } from '../ops/backup/format.ts'
import { createScheduler } from '../ops/backup/schedule.ts'
import { runBridge } from './bridge.ts'
import { sessionStart, stop } from './hooks.ts'
import { mcpAddress, NO_TOKEN, readToken, UsageError } from './remote.ts'

const HELP = `rsc-brain — self-hosted knowledge server for AI agents

Usage:
  rsc-brain migrate                                   apply pending database migrations
  rsc-brain serve                                     start the HTTP server
  rsc-brain setup --from-env                          prepare the installation from RSC_BRAIN_SETUP_URL,
                                                      RSC_BRAIN_ADMIN_NAME/_EMAIL/_PASSWORD [RSC_BRAIN_SETUP_NAME,
                                                      RSC_BRAIN_SERVICE_NAME]; prints Factory's service key once
  rsc-brain admin bootstrap --email E --name N        create the first administrator and print a key
  rsc-brain admin reset-link --email E                print a single-use link to set a password
  rsc-brain service create --name N [--can-create-brains] [--can-invite]
                                                      create a service account and print its main key
  rsc-brain bridge --url U [--token-file F]           MCP over stdio for local agents, carried to the
                                                      installation at U; the token comes from
                                                      RSC_BRAIN_TOKEN or a file (~/.config/rsc-brain/token)
  rsc-brain hook session-start --url U [--brain B]    Claude Code hook: the brain's context at the start
  rsc-brain hook stop --url U                         Claude Code hook: ask once for the session summary
  rsc-brain maintenance on [--seconds N] [--reason R] refuse writes for N seconds (60 to 1800, default 1800);
                                                      R is update, restore or manual (default manual)
  rsc-brain maintenance off                           take writes again
  rsc-brain maintenance status [--json]               whether writes are refused, until when and why
  rsc-brain backup [--reason R] [--json]              make an encrypted copy of everything now, in
                                                      RSC_BRAIN_BACKUPS; R is manual (default), pre-update
                                                      (under maintenance) or pre-restore
  rsc-brain backups list [--json]                     the copies, newest first, and whether the last failed
  rsc-brain version                                   print the version of rsc-brain
  rsc-brain help                                      show this help

Environment:
  RSC_BRAIN_DATABASE_URL   PostgreSQL connection URL (required)
  RSC_BRAIN_PORT           HTTP port (default 8090)
  RSC_BRAIN_HOST           address to listen on (default 127.0.0.1)
  RSC_BRAIN_SECRET         installation secret (32+ characters) that seals second factors and mail
  RSC_BRAIN_TRUSTED_PROXIES  proxies whose X-Forwarded-Proto/-For are believed (comma separated)
  RSC_BRAIN_BACKUPS        folder of the copies; with it, serve makes a copy every day
  RSC_BRAIN_BACKUP_AT      time of the daily copy, HH:MM in RSC_BRAIN_TIMEZONE (default 03:00)
  RSC_BRAIN_BACKUP_KEEP    daily copies kept (default 14); copies made by hand are never removed
`

const out = (s: string) => process.stdout.write(s)

async function withDb<T>(fn: (db: ReturnType<typeof openPool>) => Promise<T>): Promise<T> {
  const db = openPool(readConfig().databaseUrl, { max: 2 })
  try {
    return await fn(db)
  } finally {
    await db.close()
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(HELP)
    return 0
  }
  if (cmd === 'version' || cmd === '--version') {
    out(`${VERSION}\n`)
    return 0
  }
  if (cmd === 'maintenance') return maintenanceCommand(sub, rest)
  if (cmd === 'backup') return backupCommand([sub, ...rest].filter((x) => x !== undefined))
  if (cmd === 'backups') return backupsCommand(sub, rest)
  if (cmd === 'bridge') return bridgeCommand([sub, ...rest].filter((x) => x !== undefined))
  if (cmd === 'hook') return hookCommand(sub, rest)
  if (cmd === 'migrate') {
    return withDb(async (db) => {
      const applied = await migrate(db)
      out(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is up to date.\n')
      return 0
    })
  }
  if (cmd === 'serve') {
    const cfg = readConfig()
    const db = openPool(cfg.databaseUrl)
    await migrate(db)
    // What was sealed before purposes is sealed again, bound to its column (once; logged).
    const resealed = await resealV1(db, cfg.secret)
    if (resealed) log.info('resealed', { count: resealed })
    // Providers of meaning come from the environment, and from what the administration set in the web;
    // meaning search stays off until the administration turns it on there (spec B3).
    const meaning = providersFromEnv()
    await applyStored(db, meaning, cfg.secret)
    const server = createServer(
      createHandler({
        db,
        clock: systemClock,
        tz: cfg.timezone,
        meaning,
        secret: cfg.secret,
        trustedProxies: cfg.trustedProxies,
        backups: cfg.backups,
        log,
      }),
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `Port ${cfg.port} is already in use. Stop the other process or set RSC_BRAIN_PORT.`
              : err.message,
          ),
        )
      })
      server.listen(cfg.port, cfg.host, resolve)
    })
    log.info('listening', { port: cfg.port })
    // Sessions idle for 24 hours close themselves (spec B1); listings also sweep before they answer.
    // The trail older than 90 days folds into counters (spec B3).
    // During maintenance they all wait for the next round (spec B7 C12).
    const sweep = setInterval(() => {
      const failed = (err: unknown) => log.warn('sweep_failed', failureFields(err))
      whenOpen(db, systemClock, async () => {
        await closeIdle(db, systemClock()).catch(failed)
        await foldTrail(db, systemClock()).catch(failed)
        // A week before a token ends, its person gets a mail (once).
        await remindExpiringTokens(db, systemClock, { secret: cfg.secret }).catch(failed)
      }).catch(failed)
    }, 10 * 60_000)
    sweep.unref()
    // What has no vector yet is sent to the provider in batches, one run a minute at most.
    let embedding = false
    const embed = setInterval(() => {
      if (embedding) return
      embedding = true
      whenOpen(db, systemClock, () => embedRound(db, meaning, systemClock))
        .catch((err: unknown) => log.warn('sweep_failed', failureFields(err)))
        .finally(() => {
          embedding = false
        })
    }, 60_000)
    embed.unref()
    // The daily copy (spec B7 C2), with the folder of the copies set; checked every minute.
    if (cfg.backups) {
      // Started more than a day after the last daily copy (it was down at that time): one copy now.
      const lastScheduled = await backup.lastScheduledAt(cfg.backups, systemClock()).catch(() => null)
      const daily = createScheduler({
        at: cfg.backupAt,
        tz: cfg.timezone,
        clock: systemClock,
        lastScheduledAt: lastScheduled,
        run: backupJob(db, {
          dir: cfg.backups,
          secret: cfg.secret,
          keep: cfg.backupKeep,
          clock: systemClock,
          log,
        }),
      })
      let copying = false
      const copies = setInterval(() => {
        if (copying) return
        copying = true
        daily
          .check()
          .catch((err: unknown) => log.warn('backup_failed', failureFields(err)))
          .finally(() => {
            copying = false
          })
      }, 60_000)
      copies.unref()
    }
    const stop = () => {
      log.info('stopping')
      server.close(() => {
        db.close().then(
          () => process.exit(0),
          () => process.exit(1),
        )
      })
      // Requests under way get two seconds to finish; event streams never finish on their own, so what
      // is still open then is closed (their clients reconnect with the last event id).
      server.closeIdleConnections()
      setTimeout(() => server.closeAllConnections(), 2000).unref()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    return new Promise<number>(() => {})
  }
  // Companion mode (spec B4 CA24): the installer of Factory prepares Brain from environment variables
  // and gets the main key of Factory's service account, printed once as JSON.
  if (cmd === 'setup' && sub === '--from-env') {
    const env = process.env
    const missing = [
      'RSC_BRAIN_SETUP_URL',
      'RSC_BRAIN_ADMIN_NAME',
      'RSC_BRAIN_ADMIN_EMAIL',
      'RSC_BRAIN_ADMIN_PASSWORD',
    ].filter((k) => !env[k])
    if (missing.length > 0) {
      process.stderr.write(`Set ${missing.join(', ')} to prepare the installation.\n`)
      return 2
    }
    return withDb(async (pool) => {
      await migrate(pool)
      if (await setupDone(pool)) {
        process.stderr.write('This installation is already set up.\n')
        return 1
      }
      const made = await companionSetup(pool, systemClock, {
        name: env.RSC_BRAIN_SETUP_NAME ?? 'rsc-brain',
        publicUrl: env.RSC_BRAIN_SETUP_URL,
        admin: {
          name: env.RSC_BRAIN_ADMIN_NAME,
          email: env.RSC_BRAIN_ADMIN_EMAIL,
          password: env.RSC_BRAIN_ADMIN_PASSWORD,
        },
        serviceName: env.RSC_BRAIN_SERVICE_NAME ?? 'RSC Factory',
      })
      out(
        `${JSON.stringify({ adminId: made.adminId, serviceId: made.serviceId, serviceKey: made.serviceKey })}\n`,
      )
      return 0
    })
  }
  // A single-use link to set a password, for a person who cannot sign in (spec B4 «Entrar»).
  if (cmd === 'admin' && sub === 'reset-link') {
    const { values } = parseArgs({ args: rest, options: { email: { type: 'string' } } })
    if (!values.email) {
      process.stderr.write('Pass --email, for example: rsc-brain admin reset-link --email ana@x.com\n')
      return 2
    }
    return withDb(async (pool) => {
      await migrate(pool)
      const a = await accountByEmail(pool, values.email as string)
      if (!a) {
        process.stderr.write('There is no person with that email.\n')
        return 1
      }
      out(
        `${await resetLink(pool, await newReset(pool, a.id, null, systemClock()))}\n(valid once, for one hour)\n`,
      )
      return 0
    })
  }
  if (cmd === 'admin' && sub === 'bootstrap') {
    const { values } = parseArgs({
      args: rest,
      options: { email: { type: 'string' }, name: { type: 'string' } },
    })
    if (!values.email || !values.name) {
      process.stderr.write(
        'Pass --email and --name, for example: rsc-brain admin bootstrap --email ana@x.com --name Ana\n',
      )
      return 2
    }
    return withDb(async (pool) => {
      await migrate(pool)
      // One bootstrap at a time: two runs at once must not both create an administrator.
      return pool.tx(async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(7310420002)')
        const any = await db.one("SELECT 1 FROM accounts WHERE is_admin AND status = 'active'")
        if (any) {
          process.stderr.write('This installation already has an administrator. Ask them for an account.\n')
          return 1
        }
        const id = await createAccount(db, systemClock, {
          kind: 'person',
          email: values.email as string,
          name: values.name as string,
          isAdmin: true,
          canCreateBrains: true,
          canInvite: true,
        })
        const k = await mintPersonToken(db, systemClock, {
          accountId: id,
          name: 'bootstrap',
          perm: 'write',
          allBrains: true,
          days: 90,
        })
        // A bootstrapped installation counts as set up: there is an administrator, who sets a password
        // for the web with a single-use link.
        await db.query('UPDATE installation SET setup_done_at = coalesce(setup_done_at, $1) WHERE id = 1', [
          systemClock(),
        ])
        const link = await resetLink(db, await newReset(db, id, null, systemClock()))
        out(
          `Administrator created (${id}).\nKey (shown once, valid until ${k.expiresAt}):\n${k.secret}\n` +
            `Set a password for the web within an hour: ${link}\n`,
        )
        return 0
      })
    })
  }
  if (cmd === 'service' && sub === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: 'string' },
        'can-create-brains': { type: 'boolean' },
        'can-invite': { type: 'boolean' },
      },
    })
    if (!values.name) {
      process.stderr.write('Pass --name, for example: rsc-brain service create --name "RSC Factory"\n')
      return 2
    }
    return withDb(async (db) => {
      await migrate(db)
      const id = await createAccount(db, systemClock, {
        kind: 'service',
        name: values.name as string,
        canCreateBrains: Boolean(values['can-create-brains']),
        canInvite: Boolean(values['can-invite']),
      })
      const k = await mintMainKey(db, systemClock, { accountId: id, name: 'main' })
      out(`Service account created (${id}).\nMain key (shown once):\n${k.secret}\n`)
      return 0
    })
  }
  process.stderr.write(`Unknown command "${argv.join(' ')}". Run "rsc-brain help" to see the commands.\n`)
  return 2
}

// Maintenance around an update or a restore (spec B7 C12): writes are refused until it is turned off or
// expires on its own (30 minutes at most).
async function maintenanceCommand(which: string | undefined, args: string[]): Promise<number> {
  const usage = (why: string) => {
    process.stderr.write(
      `${why} Usage: rsc-brain maintenance on [--seconds 60..1800] [--reason update|restore|manual] | off | status [--json]\n`,
    )
    return 2
  }
  let values: { seconds?: string; reason?: string; json?: boolean }
  try {
    values = parseArgs({
      args,
      options: { seconds: { type: 'string' }, reason: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
    }).values
  } catch (err) {
    return usage(`${(err as Error).message}.`)
  }
  if (which !== 'on' && which !== 'off' && which !== 'status') return usage('Say on, off or status.')
  const seconds = values.seconds === undefined ? undefined : Number(values.seconds)
  const reason = (values.reason ?? 'manual') as MaintenanceReason
  if (which === 'on') {
    if (seconds !== undefined && !(Number.isInteger(seconds) && seconds >= 60 && seconds <= 1800))
      return usage('--seconds is a whole number from 60 to 1800.')
    if (!['update', 'restore', 'manual'].includes(reason))
      return usage('--reason is update, restore or manual.')
  }
  return withDb(async (db) => {
    if (which === 'on') {
      // Only `on` needs this release's schema; a second `on` replaces the end and the reason (and says so).
      await migrate(db)
      const before = await maintenance.current(db, systemClock())
      const { until } = await maintenance.on(db, systemClock(), {
        reason,
        ...(seconds === undefined ? {} : { seconds }),
      })
      out(`Maintenance is on until ${until.toISOString()} (${reason}). Writes are refused; reads work.\n`)
      if (before) out(`It replaces the one until ${before.until.toISOString()} (${before.reason}).\n`)
      return 0
    }
    // `off` and `status` never migrate: they work on a database a newer release migrated (off only clears two
    // columns), and on one from before maintenance existed (nothing to clear, nothing on).
    const noMaintenance = (err: unknown) => {
      const code = (err as { code?: string }).code
      if (code === '42703' || code === '42P01') return null
      throw err
    }
    if (which === 'off') {
      await maintenance.off(db).catch(noMaintenance)
      out('Maintenance is off. Writes are taken again.\n')
      return 0
    }
    const now = systemClock()
    const m = await maintenance.current(db, now).catch(noMaintenance)
    const last = m ? null : await maintenance.last(db).catch(noMaintenance)
    if (values.json) {
      out(
        `${JSON.stringify({
          until: m ? m.until.toISOString() : null,
          reason: m ? m.reason : null,
          ...(last ? { expiredAt: last.until.toISOString() } : {}),
        })}\n`,
      )
    } else if (m) {
      out(`Maintenance is on until ${m.until.toISOString()} (${m.reason}). Writes are refused; reads work.\n`)
    } else if (last) {
      out(
        `Maintenance is off. The last one (${last.reason}) expired at ${last.until.toISOString()} without being turned off.\n`,
      )
    } else {
      out('Maintenance is off.\n')
    }
    return 0
  })
}

// The folder of the copies, or why there is none (exit 2).
function backupsDir(): string | null {
  const dir = process.env.RSC_BRAIN_BACKUPS
  if (dir) return dir
  process.stderr.write('Set RSC_BRAIN_BACKUPS to the folder of the copies (in the container, /backups).\n')
  return null
}

// A copy now (plan §3.3). The installation key comes from RSC_BRAIN_SECRET only; the output says its id.
async function backupCommand(args: string[]): Promise<number> {
  const usage = (why: string) => {
    process.stderr.write(`${why} Usage: rsc-brain backup [--reason manual|pre-update|pre-restore] [--json]\n`)
    return 2
  }
  let values: { reason?: string; json?: boolean }
  try {
    values = parseArgs({
      args,
      options: { reason: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
    }).values
  } catch (err) {
    return usage(`${(err as Error).message}.`)
  }
  const reason = (values.reason ?? 'manual') as BackupReason
  // Scheduled copies are the daily ones of serve: only they are pruned.
  if (!BACKUP_REASONS.includes(reason) || reason === 'scheduled')
    return usage('--reason is manual, pre-update or pre-restore.')
  const dir = backupsDir()
  if (!dir) return 2
  return withDb(async (db) => {
    const info = await backup.create(db, { dir, secret: readConfig().secret, reason, clock: systemClock })
    // Whole and kept, but its status or the folder were not saved: said, and still a success.
    if (info.warning) process.stderr.write(`${info.warning}\n`)
    out(
      values.json
        ? `${JSON.stringify(info)}\n`
        : `Copy written: ${info.file} (${info.bytes} bytes, key id ${info.keyId}).\n` +
            'Keep the installation key: without it this copy cannot be restored.\n',
    )
    return 0
  })
}

async function backupsCommand(which: string | undefined, args: string[]): Promise<number> {
  let values: { json?: boolean }
  try {
    values = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true }).values
  } catch (err) {
    process.stderr.write(`${(err as Error).message}. Usage: rsc-brain backups list [--json]\n`)
    return 2
  }
  if (which !== 'list') {
    process.stderr.write('Usage: rsc-brain backups list [--json]\n')
    return 2
  }
  const dir = backupsDir()
  if (!dir) return 2
  const items = await backup.list(dir)
  const status = await readStatus(dir)
  if (values.json) {
    out(
      `${JSON.stringify({ items, lastOk: status.lastOk, lastFailure: status.lastFailure, keyId: status.keyId })}\n`,
    )
    return 0
  }
  if (status.lastFailure)
    out(`The last copy failed at ${status.lastFailure.at} (${status.lastFailure.category}).\n`)
  if (items.length === 0) {
    out(`No copies yet in ${dir}.\n`)
    return 0
  }
  for (const b of items)
    out(
      `${b.createdAt}  ${b.reason.padEnd(11)}  ${String(b.bytes).padStart(12)} bytes  key id ${b.keyId}  ${b.file}\n`,
    )
  return 0
}

// The bridge: a wrong option or a missing token stops it before the agent sends anything.
async function bridgeCommand(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: { url: { type: 'string' }, 'token-file': { type: 'string' } },
      strict: true,
    })
    const url = mcpAddress(values.url)
    const token = readToken(values['token-file'])
    if (!token) throw new UsageError(NO_TOKEN)
    return await runBridge({
      url,
      token,
      input: process.stdin,
      out: (line) => process.stdout.write(`${line}\n`),
      log: (s) => process.stderr.write(s),
    })
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
    if ((err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(
        `${(err as Error).message}. Usage: rsc-brain bridge --url <address> [--token-file <file>]; the token is read from RSC_BRAIN_TOKEN or a file, never from the command line.\n`,
      )
      return 2
    }
    throw err
  }
}

// The hooks never hold up the agent: any failure exits 0 with nothing on stdout (a note on stderr).
async function hookCommand(which: string | undefined, args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: { url: { type: 'string' }, 'token-file': { type: 'string' }, brain: { type: 'string' } },
      strict: true,
    })
    const url = mcpAddress(values.url)
    const token = readToken(values['token-file'])
    if (!token) throw new UsageError(NO_TOKEN)
    const out = (s: string) => process.stdout.write(s)
    if (which === 'session-start')
      await sessionStart({ url, token, brain: values.brain, input: process.stdin, out })
    else if (which === 'stop') await stop({ url, token, input: process.stdin, out })
    else throw new UsageError('Use "rsc-brain hook session-start" or "rsc-brain hook stop".')
  } catch (err) {
    process.stderr.write(
      `rsc-brain hook ${which ?? ''}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
  return 0
}

main(process.argv.slice(2)).then(
  // Exit once stdout is written out: a pipe on macOS takes it asynchronously, and process.exit would
  // cut a large answer of the bridge.
  (code) => process.stdout.write('', () => process.exit(code)),
  (err: unknown) => {
    const msg =
      err instanceof AppError
        ? `${err.message} ${err.howToProceed}`
        : err instanceof Error
          ? err.message
          : String(err)
    process.stderr.write(`${msg}\n`)
    process.exit(1)
  },
)
