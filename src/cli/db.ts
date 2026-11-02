// `rsc-brain db check|provision|drop` (plan §3.7): what the launcher runs to prepare an existing or shared PostgreSQL.
// A connection URL holds a password, so it never comes on the command line: from a file, the standard input or (for
// check) RSC_BRAIN_DATABASE_URL. The password of the new role is generated here and leaves once: written to a new
// file only its owner reads (0600), or printed on standard output. Exit codes: 0 done, 2 usage, 3 a missing
// requirement (nothing changed), 1 anything else.
import { randomBytes } from 'node:crypto'
import { type FileHandle, open, readFile, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { AppError } from '../core/errors.ts'
import { db, tooOldError } from '../ops/db.ts'

const USAGE = `Usage:
  rsc-brain db check [--db-url-file F] [--json]
  rsc-brain db provision --database D --role R [--isolate-from NAME] [--db-admin-url-file F] [--url-file OUT] [--json]
  rsc-brain db drop --database D --role R --confirm D [--db-admin-url-file F]
A connection URL is read from a file or the standard input, never from the command line.`

const MISSING = new Set(['too_old', 'cannot_create_database', 'cannot_isolate'])

const out = (s: string) => process.stdout.write(s)
const say = (s: string) => process.stderr.write(s)

function usage(why: string): number {
  say(`${why}\n${USAGE}\n`)
  return 2
}

// Parsed strictly; a wrong option or a stray argument (perhaps a URL with its password) is never repeated back.
function strict<T>(
  args: string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>['options'],
): T | null {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as T
  } catch {
    return null
  }
}

class InputError extends Error {}
async function readUrl(file: string | undefined, fallback?: string): Promise<string> {
  let text: string | undefined
  if (file !== undefined) {
    try {
      text = await readFile(file, 'utf8')
    } catch {
      throw new InputError(`The file ${file} cannot be read.`)
    }
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    text = Buffer.concat(chunks).toString('utf8')
  }
  const url = text?.trim() || fallback
  if (!url) throw new InputError('No connection URL: pass it in a file or on the standard input.')
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new InputError('That is not a PostgreSQL connection URL (postgres://…).')
  return url
}

function failed(err: unknown): number {
  if (err instanceof AppError) {
    say(`${err.message} ${err.howToProceed}\n`)
    return MISSING.has(err.code) ? 3 : 1
  }
  // A connection failure says what PostgreSQL said; pg never puts the password in it.
  say(`${err instanceof Error ? err.message : String(err)}\n`)
  return 1
}

export async function dbCommand(which: string | undefined, args: string[]): Promise<number> {
  try {
    if (which === 'check') return await checkCommand(args)
    if (which === 'provision') return await provisionCommand(args)
    if (which === 'drop') return await dropCommand(args)
  } catch (err) {
    if (err instanceof InputError) return usage(err.message)
    return failed(err)
  }
  return usage('Say check, provision or drop.')
}

async function checkCommand(args: string[]): Promise<number> {
  const v = strict<{ 'db-url-file'?: string; json?: boolean }>(args, {
    'db-url-file': { type: 'string' },
    json: { type: 'boolean' },
  })
  if (!v) return usage('Unknown option or argument.')
  const url = await readUrl(v['db-url-file'], process.env.RSC_BRAIN_DATABASE_URL || undefined)
  const r = await db.check(url)
  if ('code' in r) return failed(tooOldError(r))
  if (v.json) out(`${JSON.stringify(r)}\n`)
  else {
    out(
      `PostgreSQL ${r.version}; unaccent ${r.unaccent ? 'available' : 'missing'}; ` +
        `this login ${r.isSuper ? 'is a superuser' : 'is no superuser'}, ${r.canCreate ? 'can' : 'cannot'} create ` +
        `databases and roles, and ${r.ownsDb ? 'owns' : 'does not own'} this database.\n`,
    )
  }
  if (!r.unaccent) {
    say(
      'The unaccent extension is missing and this login cannot create it. Install the PostgreSQL contrib ' +
        'extensions on the server, or have the owner of the database run CREATE EXTENSION unaccent.\n',
    )
    return 3
  }
  return 0
}

async function provisionCommand(args: string[]): Promise<number> {
  const v = strict<{
    database?: string
    role?: string
    'isolate-from'?: string
    'db-admin-url-file'?: string
    'url-file'?: string
    json?: boolean
  }>(args, {
    database: { type: 'string' },
    role: { type: 'string' },
    'isolate-from': { type: 'string' },
    'db-admin-url-file': { type: 'string' },
    'url-file': { type: 'string' },
    json: { type: 'boolean' },
  })
  if (!v) return usage('Unknown option or argument.')
  if (!v.database || !v.role) return usage('Pass --database and --role.')
  const adminUrl = await readUrl(v['db-admin-url-file'])
  // The file is made first, new and only for its owner: an existing one is never overwritten, and nothing is
  // created on the server when it cannot be written.
  let file: FileHandle | undefined
  const target = v['url-file']
  if (target !== undefined) {
    try {
      file = await open(target, 'wx', 0o600)
    } catch {
      say(`The file ${target} exists already or cannot be created. Nothing was changed.\n`)
      return 1
    }
  }
  try {
    const password = randomBytes(32).toString('base64url')
    const r = await db.provision(adminUrl, {
      database: v.database,
      role: v.role,
      password,
      isolateFrom: v['isolate-from'],
    })
    for (const w of r.warnings) say(`Warning: ${w}\n`)
    if (file) {
      await file.writeFile(`${r.url}\n`)
      await file.close()
      file = undefined
    }
    if (v.json) {
      const summary = {
        database: v.database,
        role: v.role,
        ...(target ? { urlFile: target } : { url: r.url }),
      }
      out(`${JSON.stringify({ ...summary, warnings: r.warnings })}\n`)
    } else if (target) {
      out(`Created the role ${v.role} and the database ${v.database}; the connection URL is in ${target}.\n`)
    } else {
      out(`${r.url}\n`)
      say(
        `Created the role ${v.role} and the database ${v.database}. The URL above is printed once and saved nowhere.\n`,
      )
    }
    return 0
  } catch (err) {
    if (file) {
      await file.close().catch(() => {})
      await rm(target as string, { force: true })
    }
    throw err
  }
}

async function dropCommand(args: string[]): Promise<number> {
  const v = strict<{ database?: string; role?: string; confirm?: string; 'db-admin-url-file'?: string }>(
    args,
    {
      database: { type: 'string' },
      role: { type: 'string' },
      confirm: { type: 'string' },
      'db-admin-url-file': { type: 'string' },
    },
  )
  if (!v) return usage('Unknown option or argument.')
  if (!v.database || !v.role) return usage('Pass --database and --role.')
  if (v.confirm !== v.database) {
    return usage(
      `This removes the database ${v.database} and everything in it: pass --confirm ${v.database}.`,
    )
  }
  const adminUrl = await readUrl(v['db-admin-url-file'])
  await db.drop(adminUrl, { database: v.database, role: v.role })
  out(`Removed the database ${v.database} and the role ${v.role}.\n`)
  return 0
}
