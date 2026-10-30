#!/usr/bin/env node
// rsc-brain command line. Each command says what it did, or what to do when it cannot.
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { readConfig } from '../config.ts'
import { systemClock } from '../core/clock.ts'
import { AppError } from '../core/errors.ts'
import { openPool } from '../db/db.ts'
import { migrate } from '../db/migrate.ts'
import { accountByEmail, createAccount } from '../domain/accounts.ts'
import { companionSetup, setupDone } from '../domain/installation.ts'
import { mintMainKey, mintPersonToken } from '../domain/keys.ts'
import { newReset, resetLink } from '../domain/login.ts'
import { embedRound } from '../domain/meaning.ts'
import { remindExpiringTokens } from '../domain/notices.ts'
import { closeIdle } from '../domain/sessions.ts'
import { foldTrail } from '../domain/trail.ts'
import { createHandler } from '../http/app.ts'
import { providersFromEnv } from '../meaning/providers.ts'
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
  rsc-brain help                                      show this help

Environment:
  RSC_BRAIN_DATABASE_URL   PostgreSQL connection URL (required)
  RSC_BRAIN_PORT           HTTP port (default 8090)
  RSC_BRAIN_HOST           address to listen on (default 127.0.0.1)
  RSC_BRAIN_SECRET         installation secret (32+ characters) that seals second factors and mail
  RSC_BRAIN_TRUSTED_PROXIES  proxies whose X-Forwarded-Proto/-For are believed (comma separated)
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
    // Providers of meaning come from the environment; meaning search stays off until the
    // administration turns it on in the web (spec B3).
    const meaning = providersFromEnv()
    const server = createServer(
      createHandler({
        db,
        clock: systemClock,
        tz: cfg.timezone,
        meaning,
        secret: cfg.secret,
        trustedProxies: cfg.trustedProxies,
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
    out(`rsc-brain listening on http://${cfg.host}:${cfg.port}\n`)
    // Sessions idle for 24 hours close themselves (spec B1); listings also sweep before they answer.
    // The trail older than 90 days folds into counters (spec B3).
    const sweep = setInterval(() => {
      closeIdle(db, systemClock()).catch(() => {})
      foldTrail(db, systemClock()).catch(() => {})
      // A week before a token ends, its person gets a mail (once).
      remindExpiringTokens(db, systemClock, { secret: cfg.secret }).catch(() => {})
    }, 10 * 60_000)
    sweep.unref()
    // What has no vector yet is sent to the provider in batches, one run a minute at most.
    let embedding = false
    const embed = setInterval(() => {
      if (embedding) return
      embedding = true
      embedRound(db, meaning, systemClock)
        .catch(() => {})
        .finally(() => {
          embedding = false
        })
    }, 60_000)
    embed.unref()
    const stop = () => {
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
