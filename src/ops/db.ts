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

// Only the tests pretend another server: an older version, or no unaccent installed (CA21); someone taking the
// database name in the moment between the checks and its creation; a failure once the database is made.
export type Simulate = {
  serverVersionNum?: string
  availableExtensions?: string[]
  beforeDatabase?: () => Promise<void>
  afterDatabase?: () => Promise<void>
  afterIsolation?: () => Promise<void>
}

// What provision writes on the database and the role it makes, and what drop requires before removing anything.
export const MARK = 'rsc-brain'

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

// What the driver (pg-connection-string) reads about TLS: with any of them, the administration URL used it, and the new
// one must the same way, or rsc-brain would talk to its database in clear.
const TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation', 'uselibpqcompat']

// The URL of the new role, made from scratch: the scheme, host and port of the administration URL, the new role, its
// password and its database, and of the query only how to reach the server safely (TLS_PARAMS) and, for a socket,
// its folder and port. Anything else in the query (user, password, dbname, options, passfile) would override the rest
// for the driver: an administration login kept in the URL rsc-brain runs with.
export function connectionUrl(adminUrl: string, role: string, password: string, database: string): string {
  const { url: a, host } = parseUrl(adminUrl)
  const q = new URLSearchParams()
  for (const k of TLS_PARAMS) {
    const v = a.searchParams.get(k)
    if (v !== null) q.set(k, v)
  }
  const socket = a.searchParams.get('host')
  if (socket?.startsWith('/')) {
    q.set('host', socket)
    const port = a.searchParams.get('port')
    if (port && /^\d{1,5}$/.test(port)) q.set('port', port)
  }
  const query = q.size ? `?${q}` : ''
  return `${a.protocol}//${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}/${database}${query}`
}

// A URL as the driver reads it, the socket form with a login and no host (postgres://u:p@/db?host=/run) included,
// which the URL standard refuses.
function parseUrl(url: string): { url: URL; host: string } {
  try {
    const u = new URL(url)
    return { url: u, host: u.host }
  } catch {
    const m = /^(postgres(?:ql)?:\/\/[^/@]*@)\//.exec(url)
    if (!m) throw fail(400, 'invalid_url', 'That is not a PostgreSQL connection URL.', 'Use postgres://…')
    return { url: new URL(`${m[1]}socket.invalid/${url.slice(m[0].length)}`), host: '' }
  }
}

const ident = (c: pg.Client, s: string) => c.escapeIdentifier(s)

// A login that is no superuser holds the role it created WITH ADMIN only; for `fn` it may also act as it (to give it a
// database), and then not any more.
async function withMembership<T>(
  c: pg.Client,
  role: string,
  isSuper: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (isSuper) return fn()
  await c.query(`GRANT ${ident(c, role)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`)
  try {
    return await fn()
  } finally {
    await c.query(`REVOKE ${ident(c, role)} FROM CURRENT_USER`)
  }
}

// As the owner (inside withMembership): only the owner closes its database, comments it or removes it.
async function actAs<T>(c: pg.Client, role: string, isSuper: boolean, fn: () => Promise<T>): Promise<T> {
  if (isSuper) return fn()
  await c.query(`SET ROLE ${ident(c, role)}`)
  try {
    return await fn()
  } finally {
    await c.query('RESET ROLE')
  }
}

const asOwner = <T>(c: pg.Client, role: string, isSuper: boolean, fn: () => Promise<T>) =>
  withMembership(c, role, isSuper, () => actAs(c, role, isSuper, fn))

// Removes the database (as its owner) and then the role; says what could not be removed, never hides it.
async function removeBoth(
  c: pg.Client,
  database: string | null,
  role: string | null,
  isSuper: boolean,
): Promise<string[]> {
  const left: string[] = []
  if (database && role) {
    try {
      await asOwner(c, role, isSuper, () =>
        c.query(`DROP DATABASE IF EXISTS ${ident(c, database)} WITH (FORCE)`),
      )
    } catch {
      left.push(`the database ${database}`)
    }
  }
  if (role) {
    try {
      await c.query(`DROP ROLE IF EXISTS ${ident(c, role)}`)
    } catch {
      left.push(`the role ${role}`)
    }
  }
  return left
}

// What closing the other program's database changed: the privileges given by name, and what PUBLIC had.
type Isolation = {
  database: string
  connect: string[]
  temp: string[]
  public: { connect: boolean; temp: boolean }
}

// Puts the other program's database back as it was: PUBLIC first (nobody is locked out meanwhile), then the
// privileges given by name taken away. Says what could not be put back.
async function undoIsolation(c: pg.Client, x: Isolation): Promise<string[]> {
  const on = `ON DATABASE ${ident(c, x.database)}`
  const list = (names: string[]) => names.map((g) => ident(c, g)).join(', ')
  try {
    const back = [x.public.connect && 'CONNECT', x.public.temp && 'TEMPORARY'].filter(Boolean)
    if (back.length) await c.query(`GRANT ${back.join(', ')} ${on} TO PUBLIC`)
    if (x.connect.length) await c.query(`REVOKE CONNECT ${on} FROM ${list(x.connect)}`)
    if (x.temp.length) await c.query(`REVOKE TEMPORARY ${on} FROM ${list(x.temp)}`)
    return []
  } catch {
    return [`the privileges on ${x.database}`]
  }
}

async function provision(
  adminUrl: string,
  input: ProvisionInput,
  sim?: Simulate,
): Promise<{ url: string; warnings: string[]; granted: string[] }> {
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
    await c.query(
      `CREATE ROLE ${ident(c, role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT ` +
        `PASSWORD ${c.escapeLiteral(scramVerifier(password))}`,
    )
    let createdDb = false
    let granted: string[] = []
    let changed: Isolation | undefined
    try {
      await c.query(`COMMENT ON ROLE ${ident(c, role)} IS ${c.escapeLiteral(MARK)}`)
      await withMembership(c, role, found.isSuper, async () => {
        await sim?.beforeDatabase?.()
        await c.query(
          `CREATE DATABASE ${ident(c, database)} OWNER ${ident(c, role)} ENCODING 'UTF8' TEMPLATE template0`,
        )
        createdDb = true
        await actAs(c, role, found.isSuper, async () => {
          await c.query(`COMMENT ON DATABASE ${ident(c, database)} IS ${c.escapeLiteral(MARK)}`)
          // Only its role (and superusers) may connect to rsc-brain's database.
          await c.query(`REVOKE ALL ON DATABASE ${ident(c, database)} FROM PUBLIC`)
        })
      })
      await sim?.afterDatabase?.()
      // The other program's database: every login keeps exactly what it may do there now (CONNECT, TEMPORARY, each
      // on its own), given by name where it has it only through PUBLIC; except rsc-brain's (this one and any other
      // installation's). Then it is closed to PUBLIC. What was changed is kept, to put it back if a later step fails.
      if (isolateFrom !== undefined) {
        const plan = (
          await c.query<{ name: string | null; connect: boolean; temp: boolean }>(
            `WITH acl AS (
               SELECT (aclexplode(coalesce(datacl, acldefault('d', datdba)))).* FROM pg_database WHERE datname = $2)
             SELECT NULL AS name,
                    EXISTS (SELECT 1 FROM acl WHERE grantee = 0 AND privilege_type = 'CONNECT') AS connect,
                    EXISTS (SELECT 1 FROM acl WHERE grantee = 0 AND privilege_type = 'TEMPORARY') AS temp
             UNION ALL
             SELECT * FROM (
               SELECT r.rolname,
                      has_database_privilege(r.oid, $2, 'CONNECT')
                        AND NOT EXISTS (SELECT 1 FROM acl WHERE grantee = r.oid AND privilege_type = 'CONNECT'),
                      has_database_privilege(r.oid, $2, 'TEMPORARY')
                        AND NOT EXISTS (SELECT 1 FROM acl WHERE grantee = r.oid AND privilege_type = 'TEMPORARY')
                 FROM pg_roles r
                WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> $1 AND r.rolname !~ '^pg_'
                  AND coalesce(shobj_description(r.oid, 'pg_authid'), '') <> $3
                ORDER BY 1) x`,
            [role, isolateFrom, MARK],
          )
        ).rows
        const pub = plan[0] ?? { connect: false, temp: false }
        const by = (what: 'connect' | 'temp') =>
          plan
            .slice(1)
            .filter((r) => r[what])
            .map((r) => r.name as string)
        changed = { database: isolateFrom, connect: by('connect'), temp: by('temp'), public: pub }
        granted = [...new Set([...changed.connect, ...changed.temp])].sort()
        const list = (names: string[]) => names.map((g) => ident(c, g)).join(', ')
        if (changed.connect.length)
          await c.query(`GRANT CONNECT ON DATABASE ${ident(c, isolateFrom)} TO ${list(changed.connect)}`)
        if (changed.temp.length)
          await c.query(`GRANT TEMPORARY ON DATABASE ${ident(c, isolateFrom)} TO ${list(changed.temp)}`)
        await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(c, isolateFrom)} FROM PUBLIC`)
        await sim?.afterIsolation?.()
      }
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
      // Nothing half made stays behind; what cannot be removed is said.
      const left = changed ? await undoIsolation(c, changed) : []
      left.push(...(await removeBoth(c, createdDb ? database : null, role, found.isSuper)))
      if (left.length === 0) throw err
      const e = fail(
        500,
        'left_behind',
        `${err instanceof Error ? err.message : String(err)} Removing what was made failed too: ${left.join(' and ')} ${left.length > 1 ? 'are' : 'is'} still there.`,
        `Put ${left.length > 1 ? 'them' : 'it'} right as a superuser (DROP DATABASE ${database}; DROP ROLE ${role}; the privileges on ${isolateFrom ?? 'the other database'} as they were), then try again.`,
      )
      e.cause = err
      throw e
    }
    return { url: connectionUrl(adminUrl, role, password, database), warnings, granted }
  } finally {
    await c.end()
  }
}

// What was removed. Only what provision made and marked: a database not owned by the role, or either without the
// mark, is someone else's.
async function drop(
  adminUrl: string,
  input: { database: string; role: string },
): Promise<{ database: boolean; role: boolean }> {
  plainName('database', input.database)
  plainName('role', input.role)
  const c = await connect(adminUrl)
  try {
    const s = (
      await c.query<{
        owner: string | null
        db_mark: string | null
        role_found: boolean
        role_super: boolean | null
        role_mark: string | null
        me: string
        here: string
        is_super: boolean
      }>(
        `SELECT (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1) AS owner,
                (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = $1) AS db_mark,
                EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_found,
                (SELECT rolsuper FROM pg_roles WHERE rolname = $2) AS role_super,
                (SELECT shobj_description(oid, 'pg_authid') FROM pg_roles WHERE rolname = $2) AS role_mark,
                current_user AS me, current_database() AS here,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`,
        [input.database, input.role],
      )
    ).rows[0]
    if (!s) throw new Error('The login could not read the catalog.')
    const dbFound = s.owner !== null
    const notOurs = (what: string) =>
      fail(
        409,
        'not_ours',
        `${what}. Nothing was removed.`,
        'Check the database and role names of this installation: drop removes only what rsc-brain db provision made.',
      )
    if (dbFound && s.owner !== input.role)
      throw notOurs(`The database ${input.database} belongs to ${s.owner}, not to ${input.role}`)
    if (dbFound && s.db_mark !== MARK)
      throw notOurs(`The database ${input.database} was not made by rsc-brain`)
    if (s.role_found && (s.role_super || input.role === s.me))
      throw notOurs(`The role ${input.role} is a superuser or the login in use`)
    if (s.role_found && s.role_mark !== MARK)
      throw notOurs(`The role ${input.role} was not made by rsc-brain`)
    if (input.database === s.here)
      throw notOurs(`The database ${input.database} is the one this login is connected to`)
    if (!dbFound && !s.role_found) return { database: false, role: false }
    const left = await removeBoth(
      c,
      dbFound ? input.database : null,
      s.role_found ? input.role : null,
      s.is_super,
    )
    if (left.length) {
      throw fail(
        500,
        'not_removed',
        `Could not remove ${left.join(' and ')}.`,
        'Remove what is left as a superuser, or with the login that made it.',
      )
    }
    return { database: dbFound, role: s.role_found }
  } finally {
    await c.end()
  }
}

export const db = { check, provision, drop }
