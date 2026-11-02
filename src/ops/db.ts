// The PostgreSQL of an installation (spec B7 «Modos de instalación», C13, C14; plan §3.7).
//   check      whether a server can hold rsc-brain (version, unaccent) and what the given login may do there
//   provision  with an administration login: rsc-brain's own role and database, closed to everyone else and, on a
//              server shared with another program, that program's database closed to rsc-brain and back
//   drop       removes that database and that role, and nothing else (uninstall with --delete-data)
// The administration login is used for these alone and never kept (C13): the migrations need only the owner of the
// database (unaccent is a trusted extension since PostgreSQL 13).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'
import { AppError } from '../core/errors.ts'

export const MIN_POSTGRES = 17

export type DbCheck = {
  // The major version of the server.
  version: number
  // unaccent is in the database, or this login may create it there.
  unaccent: boolean
  // This login may create a database and a role (what provision needs).
  canCreate: boolean
  isSuper: boolean
  // This login owns the database it connected to.
  ownsDb: boolean
}
export type TooOld = { code: 'too_old'; min: number; version: number }

// Only the tests pretend another server: an older version, or no unaccent installed (CA21); and someone taking the
// database name in the moment between the checks and its creation.
export type Simulate = {
  serverVersionNum?: string
  availableExtensions?: string[]
  beforeDatabase?: () => Promise<void>
}

export type ProvisionInput = {
  database: string
  role: string
  password: string
  isolateFrom?: string | undefined
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const RESERVED = new Set(['postgres', 'template0', 'template1'])

const fail = (status: number, code: string, message: string, howToProceed: string) =>
  new AppError(status, code, message, howToProceed)

function plainName(what: 'database' | 'role', v: string): void {
  if (!IDENT.test(v) || RESERVED.has(v) || v.startsWith('pg_')) {
    throw fail(
      400,
      'invalid_name',
      `The ${what} name is not a plain lowercase name.`,
      'Use 1 to 63 lowercase letters, digits and underscores, starting with a letter (rsc_brain).',
    )
  }
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 })
  await c.connect()
  return c
}

async function checkOn(c: pg.Client, sim: Simulate = {}): Promise<DbCheck | TooOld> {
  const num =
    sim.serverVersionNum ??
    String((await c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]?.v)
  const version = Math.floor(Number(num) / 10_000)
  if (!Number.isFinite(version) || version < MIN_POSTGRES)
    return { code: 'too_old', min: MIN_POSTGRES, version }
  const me = (
    await c.query<{
      su: boolean
      cdb: boolean
      crole: boolean
      owns: boolean
      create_in: boolean
      installed: boolean
    }>(
      `SELECT r.rolsuper AS su, r.rolcreatedb AS cdb, r.rolcreaterole AS crole,
              d.datdba = r.oid AS owns,
              has_database_privilege(current_database(), 'CREATE') AS create_in,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS installed
         FROM pg_roles r, pg_database d
        WHERE r.rolname = current_user AND d.datname = current_database()`,
    )
  ).rows[0]
  if (!me) throw new Error('The login could not read its own role.')
  const available =
    sim.availableExtensions ??
    (
      await c.query<{ name: string }>("SELECT name FROM pg_available_extensions WHERE name = 'unaccent'")
    ).rows.map((r) => r.name)
  return {
    version,
    unaccent: me.installed || (available.includes('unaccent') && (me.su || me.create_in)),
    canCreate: me.su || (me.cdb && me.crole),
    isSuper: me.su,
    ownsDb: me.owns,
  }
}

async function check(url: string, sim?: Simulate): Promise<DbCheck | TooOld> {
  const c = await connect(url)
  try {
    return await checkOn(c, sim)
  } finally {
    await c.end()
  }
}

export function tooOldError(r: TooOld): AppError {
  const e = fail(
    422,
    'too_old',
    `This PostgreSQL is version ${r.version}; rsc-brain needs ${r.min} or newer.`,
    `Upgrade the server to PostgreSQL ${r.min} or newer, or install with the bundled PostgreSQL (--db bundled).`,
  )
  e.extra = { min: r.min, version: r.version }
  return e
}

// A SCRAM-SHA-256 verifier (RFC 5802/7677), the form PostgreSQL stores: the password is sent hashed, never in clear,
// so it is not in the server's statement log nor in what other sessions see running.
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest('base64')
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64')
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`
}

function urlFor(adminUrl: string, role: string, password: string, database: string): string {
  const u = new URL(adminUrl)
  u.username = role
  u.password = encodeURIComponent(password)
  u.pathname = `/${database}`
  return u.toString()
}

async function provision(
  adminUrl: string,
  input: ProvisionInput,
  sim?: Simulate,
): Promise<{ url: string; warnings: string[] }> {
  const { database, role, password, isolateFrom } = input
  plainName('database', database)
  plainName('role', role)
  if (
    isolateFrom !== undefined &&
    (isolateFrom === '' || isolateFrom.length > 63 || isolateFrom === database)
  ) {
    throw fail(
      400,
      'invalid_name',
      'The database to keep apart is not a database name.',
      'Pass its name as it is.',
    )
  }
  if (password.length < 16)
    throw fail(400, 'invalid_password', 'The password is too short.', 'Use 16 characters or more.')
  const c = await connect(adminUrl)
  try {
    const found = await checkOn(c, sim)
    if ('code' in found) throw tooOldError(found)
    if (!found.canCreate) {
      throw fail(
        422,
        'cannot_create_database',
        'This login cannot create a database and a role on this PostgreSQL.',
        'Use a login that can (CREATEDB and CREATEROLE), or create them yourself and pass an existing database (--db-url-file).',
      )
    }
    const taken = (
      await c.query<{ db: boolean; role: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS db,
                EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role`,
        [database, role],
      )
    ).rows[0]
    if (taken?.db || taken?.role) {
      throw fail(
        409,
        'already_exists',
        `The ${taken.db ? `database ${database}` : `role ${role}`} already exists on this PostgreSQL.`,
        'Pick other names, or pass that database as an existing one (--db-url-file).',
      )
    }
    const warnings: string[] = []
    let other: { owner: string; ownerSuper: boolean } | undefined
    if (isolateFrom !== undefined) {
      const o = (
        await c.query<{ owner: string; owner_super: boolean; may: boolean }>(
          `SELECT r.rolname AS owner, r.rolsuper AS owner_super, pg_has_role(current_user, r.oid, 'USAGE') AS may
             FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = $1`,
          [isolateFrom],
        )
      ).rows[0]
      if (!o) {
        throw fail(
          404,
          'not_found',
          `There is no database ${isolateFrom} on this PostgreSQL.`,
          'Check its name.',
        )
      }
      // Revoking what one may not revoke is only a warning in PostgreSQL: it is checked before anything is made.
      if (!found.isSuper && !o.may) {
        throw fail(
          422,
          'cannot_isolate',
          `This login cannot change who may connect to ${isolateFrom}.`,
          `Use a superuser, or a login that is a member of ${o.owner}, its owner.`,
        )
      }
      other = { owner: o.owner, ownerSuper: o.owner_super }
      if (o.owner_super) {
        warnings.push(
          `${isolateFrom} belongs to ${o.owner}, a superuser: a superuser can connect to any database, rsc-brain's ` +
            `too. rsc-brain cannot reach ${isolateFrom}, but the separation holds one way only until that program uses ` +
            'a login that is no superuser.',
        )
      }
    }
    const ident = (s: string) => c.escapeIdentifier(s)
    await c.query(
      `CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT ` +
        `PASSWORD ${c.escapeLiteral(scramVerifier(password))}`,
    )
    let createdDb = false
    try {
      // A login that is no superuser must act as the owner to give it the database and to close it (only the owner
      // changes who may connect); only for that moment.
      if (!found.isSuper) await c.query(`GRANT ${ident(role)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`)
      try {
        await sim?.beforeDatabase?.()
        await c.query(
          `CREATE DATABASE ${ident(database)} OWNER ${ident(role)} ENCODING 'UTF8' TEMPLATE template0`,
        )
        createdDb = true
        // Only its role (and superusers) may connect to rsc-brain's database.
        if (!found.isSuper) await c.query(`SET ROLE ${ident(role)}`)
        try {
          await c.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`)
        } finally {
          if (!found.isSuper) await c.query('RESET ROLE')
        }
      } finally {
        if (!found.isSuper) await c.query(`REVOKE ${ident(role)} FROM CURRENT_USER`)
      }
      // The other program's database: closed to everyone but its owner (who keeps its own privileges) and the
      // privileges given by name.
      if (isolateFrom !== undefined)
        await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(isolateFrom)} FROM PUBLIC`)
      // What was asked is what holds: no connection across, either way (CA3).
      const across = (
        await c.query<{ there: boolean; back: boolean; others: boolean }>(
          `SELECT ($3::text IS NOT NULL AND has_database_privilege($1, $3, 'CONNECT')) AS there,
                  ($4::text IS NOT NULL AND NOT $5 AND has_database_privilege($4, $2, 'CONNECT')) AS back,
                  has_database_privilege('public', $2, 'CONNECT') AS others`,
          [role, database, isolateFrom ?? null, other?.owner ?? null, other?.ownerSuper ?? false],
        )
      ).rows[0]
      if (!across || across.there || across.back || across.others) {
        throw fail(
          500,
          'cannot_isolate',
          'The databases could not be kept apart: a connection across is still allowed.',
          'Check the privileges given on both databases, then try again.',
        )
      }
    } catch (err) {
      // Nothing half made stays behind.
      if (createdDb) await c.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`).catch(() => {})
      await c.query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {})
      throw err
    }
    return { url: urlFor(adminUrl, role, password, database), warnings }
  } finally {
    await c.end()
  }
}

async function drop(adminUrl: string, input: { database: string; role: string }): Promise<void> {
  plainName('database', input.database)
  plainName('role', input.role)
  const c = await connect(adminUrl)
  try {
    const s = (
      await c.query<{ owner: string | null; role_super: boolean | null; me: string; here: string }>(
        `SELECT (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1) AS owner,
                (SELECT rolsuper FROM pg_roles WHERE rolname = $2) AS role_super,
                current_user AS me, current_database() AS here`,
        [input.database, input.role],
      )
    ).rows[0]
    if (!s) throw new Error('The login could not read the catalog.')
    const notOurs = (what: string) =>
      fail(
        409,
        'not_ours',
        `${what}, so it is not rsc-brain's and nothing was removed.`,
        'Check the database and role names of this installation.',
      )
    if (s.owner !== null && s.owner !== input.role)
      throw notOurs(`The database ${input.database} belongs to ${s.owner}`)
    if (s.role_super || input.role === s.me)
      throw notOurs(`The role ${input.role} is a superuser or the login in use`)
    if (input.database === s.here)
      throw notOurs(`The database ${input.database} is the one this login is connected to`)
    if (s.owner !== null) await c.query(`DROP DATABASE ${c.escapeIdentifier(input.database)} WITH (FORCE)`)
    if (s.role_super !== null) await c.query(`DROP ROLE ${c.escapeIdentifier(input.role)}`)
  } finally {
    await c.end()
  }
}

export const db = { check, provision, drop }
