// The database of an installation (plan §3.7, spec B7 CA3, CA21, C13, C14). `check` says whether a PostgreSQL can hold
// rsc-brain (version 17 or newer, `unaccent` available) and what the given user may do there. `provision` creates the
// role and the database of rsc-brain with an administration login: a role that is no superuser and cannot create
// databases or roles, a database only it (and its administration) can connect to, and, on a server shared with another
// program, that program's database closed to it and the other way round. `drop` removes both, and only those.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { openPool } from '../../src/db/db.ts'
import { migrate } from '../../src/db/migrate.ts'
import { db as dbOps, MIN_POSTGRES, scramVerifier } from '../../src/ops/db.ts'
import { PG_URL, skipPg } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const tag = randomBytes(4).toString('hex')
const name = (what: string) => `rscbt_${tag}_${what}`
const as = (role: string, database: string) => {
  const u = new URL(PG_URL as string)
  u.username = role
  u.password = ''
  u.pathname = `/${database}`
  return u.toString()
}

async function sql(text: string, url = PG_URL as string) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return (await c.query(text)).rows
  } finally {
    await c.end()
  }
}
// Connecting as a role to a database: null when it worked, the refusal otherwise.
async function connectError(url: string): Promise<string | null> {
  const c = new pg.Client({ connectionString: url })
  try {
    await c.connect()
    await c.end()
    return null
  } catch (err) {
    return (err as Error).message
  }
}
const roleFlags = async (role: string) =>
  (
    await sql(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = '${role}'`,
    )
  )[0]
const exists = async (kind: 'role' | 'database', n: string) =>
  (
    await sql(
      kind === 'role'
        ? `SELECT 1 FROM pg_roles WHERE rolname = '${n}'`
        : `SELECT 1 FROM pg_database WHERE datname = '${n}'`,
    )
  ).length === 1

function run(args: string[], input = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, RSC_BRAIN_DATABASE_URL: '' } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    p.stdin.end(input)
  })
}

// What a SCRAM-SHA-256 verifier for this password and this salt is (RFC 5802/7677, as PostgreSQL stores it).
function scramOf(stored: string, password: string): string {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(stored)
  assert.ok(m, 'stored as SCRAM-SHA-256')
  const [, iter, salt] = m as unknown as [string, string, string]
  const salted = pbkdf2Sync(password, Buffer.from(salt, 'base64'), Number(iter), 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest('base64')
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64')
  return `SCRAM-SHA-256$${iter}:${salt}$${storedKey}:${serverKey}`
}

describe('the password verifier', () => {
  it('is the SCRAM-SHA-256 of RFC 7677 (user / pencil)', () => {
    assert.equal(
      scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096),
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    )
  })
})

describe('db.check', { skip: skipPg }, () => {
  const noCreate = name('nocreate')
  const plainDb = name('plaindb')
  before(async () => {
    await sql(`CREATE ROLE ${noCreate} LOGIN`)
    await sql(`CREATE DATABASE ${plainDb}`)
    await sql(`GRANT CONNECT ON DATABASE ${plainDb} TO ${noCreate}`)
  })
  after(async () => {
    await sql(`DROP DATABASE IF EXISTS ${plainDb} WITH (FORCE)`)
    await sql(`DROP ROLE IF EXISTS ${noCreate}`)
  })

  it('PostgreSQL 17 with unaccent and an administration login: everything is there', async () => {
    const r = await dbOps.check(PG_URL as string)
    assert.ok(!('code' in r))
    assert.ok(r.version >= MIN_POSTGRES)
    assert.deepEqual([r.unaccent, r.canCreate, r.isSuper], [true, true, true])
  })

  it('CA21: PostgreSQL 16 is too old, and says the minimum', async () => {
    const r = await dbOps.check(PG_URL as string, { serverVersionNum: '160004' })
    assert.deepEqual(r, { code: 'too_old', min: 17, version: 16 })
    assert.equal(MIN_POSTGRES, 17)
  })

  it('CA21: without unaccent (not installed on the server), it says so', async () => {
    const r = await dbOps.check(PG_URL as string, { availableExtensions: [] })
    assert.ok(!('code' in r))
    assert.equal(r.unaccent, false)
  })

  it('CA21: a user who cannot create unaccent in its database (not its owner, no CREATE) has no unaccent', async () => {
    const r = await dbOps.check(as(noCreate, plainDb))
    assert.ok(!('code' in r))
    assert.deepEqual([r.unaccent, r.canCreate, r.isSuper, r.ownsDb], [false, false, false, false])
  })

  it('unaccent already in the database counts, whoever asks', async () => {
    await sql('CREATE EXTENSION IF NOT EXISTS unaccent', as(new URL(PG_URL as string).username, plainDb))
    const r = await dbOps.check(as(noCreate, plainDb))
    assert.ok(!('code' in r))
    assert.equal(r.unaccent, true)
  })
})

describe('db.provision and db.drop', { skip: skipPg }, () => {
  const factoryRole = name('factory')
  const factoryDb = name('factorydb')
  const superOwnedDb = name('superdb')
  const outsider = name('outsider')
  const limitedAdmin = name('limitedadmin')
  const noCreate = name('cannot')
  const made: { database: string; role: string }[] = []

  before(async () => {
    // Factory with a normal user that owns its database (CA3, C14).
    await sql(`CREATE ROLE ${factoryRole} LOGIN`)
    await sql(`CREATE DATABASE ${factoryDb} OWNER ${factoryRole}`)
    await sql(`CREATE DATABASE ${superOwnedDb}`)
    await sql(`CREATE ROLE ${outsider} LOGIN`)
    await sql(`CREATE ROLE ${limitedAdmin} LOGIN CREATEDB CREATEROLE`)
    // Its sessions would hash a password sent in clear as MD5: what is stored shows whether it was sent hashed.
    await sql(`ALTER ROLE ${limitedAdmin} SET password_encryption = 'md5'`)
    await sql(`CREATE ROLE ${noCreate} LOGIN`)
  })
  after(async () => {
    for (const m of made) {
      await sql(`DROP DATABASE IF EXISTS ${m.database} WITH (FORCE)`)
      await sql(`DROP ROLE IF EXISTS ${m.role}`)
    }
    for (const d of [factoryDb, superOwnedDb]) await sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
    for (const r of [factoryRole, outsider, limitedAdmin, noCreate]) await sql(`DROP ROLE IF EXISTS ${r}`)
  })

  it('CA3: its own role and database, no superuser or creator on either side, no connection across', async () => {
    const database = name('brain')
    const role = name('brainrole')
    made.push({ database, role })
    const password = randomBytes(18).toString('base64url')
    const r = await dbOps.provision(PG_URL as string, { database, role, password, isolateFrom: factoryDb })
    assert.deepEqual(r.warnings, [])
    const url = new URL(r.url)
    assert.deepEqual(
      [url.username, decodeURIComponent(url.password), url.pathname],
      [role, password, `/${database}`],
    )
    for (const who of [role, factoryRole]) {
      const f = await roleFlags(who)
      assert.deepEqual(
        [f?.rolsuper, f?.rolcreatedb, f?.rolcreaterole, f?.rolreplication, f?.rolbypassrls, f?.rolcanlogin],
        [false, false, false, false, false, true],
        who,
      )
    }
    assert.equal(
      (await sql(`SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = '${database}'`))[0]?.o,
      role,
    )
    // Its own database: it connects, and the migrations run with it (C13: unaccent is created by the owner).
    assert.equal(await connectError(as(role, database)), null)
    const pool = openPool(as(role, database), { max: 1 })
    try {
      assert.ok((await migrate(pool)).length > 0)
    } finally {
      await pool.close()
    }
    // Across: rsc-brain cannot enter Factory's database, nor Factory rsc-brain's, nor anyone else rsc-brain's.
    assert.match(String(await connectError(as(role, factoryDb))), /permission denied for database/)
    assert.match(String(await connectError(as(factoryRole, database))), /permission denied for database/)
    assert.match(String(await connectError(as(outsider, database))), /permission denied for database/)
    // Factory still enters its own.
    assert.equal(await connectError(as(factoryRole, factoryDb)), null)
    // The password is stored as a SCRAM verifier made from it (sent hashed, never in clear).
    const stored = String(
      (await sql(`SELECT rolpassword FROM pg_authid WHERE rolname = '${role}'`))[0]?.rolpassword,
    )
    assert.equal(stored, scramOf(stored, password))
  })

  it('C14: when the other database belongs to a superuser, it warns that the separation is one way', async () => {
    const database = name('brain2')
    const role = name('brainrole2')
    made.push({ database, role })
    const r = await dbOps.provision(PG_URL as string, {
      database,
      role,
      password: randomBytes(18).toString('base64url'),
      isolateFrom: superOwnedDb,
    })
    assert.equal(r.warnings.length, 1)
    assert.match(
      String(r.warnings[0]),
      new RegExp(`${superOwnedDb}.*superuser.*connect to any database`, 's'),
    )
    assert.match(String(await connectError(as(role, superOwnedDb))), /permission denied for database/)
  })

  it('an administration login that is no superuser (CREATEDB and CREATEROLE) also provisions, and keeps nothing of it', async () => {
    const database = name('brain3')
    const role = name('brainrole3')
    made.push({ database, role })
    const password = randomBytes(18).toString('base64url')
    const r = await dbOps.provision(as(limitedAdmin, 'postgres'), { database, role, password })
    assert.deepEqual(r.warnings, [])
    const stored = String(
      (await sql(`SELECT rolpassword FROM pg_authid WHERE rolname = '${role}'`))[0]?.rolpassword,
    )
    assert.equal(stored, scramOf(stored, password), 'the password was sent hashed (SCRAM), not in clear')
    assert.equal(
      (await sql(`SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = '${database}'`))[0]?.o,
      role,
    )
    assert.equal(await connectError(as(role, database)), null)
    assert.match(String(await connectError(as(outsider, database))), /permission denied for database/)
    // The administration login is not left a member of rsc-brain's role.
    const member = await sql(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE r.rolname = '${role}' AND u.rolname = '${limitedAdmin}' AND (m.set_option OR m.inherit_option)`,
    )
    assert.equal(member.length, 0)
  })

  it('a login that cannot change who connects to the other database is refused before anything is made', async () => {
    const database = name('brain4')
    const role = name('brainrole4')
    made.push({ database, role }) // removed after, even if a broken build makes them
    await assert.rejects(
      dbOps.provision(as(limitedAdmin, 'postgres'), {
        database,
        role,
        password: randomBytes(18).toString('base64url'),
        isolateFrom: factoryDb,
      }),
      (err: Error & { code?: string }) => err.code === 'cannot_isolate',
    )
    assert.deepEqual([await exists('database', database), await exists('role', role)], [false, false])
  })

  it('when the database cannot be created after all (its name taken meanwhile), the new role is removed', async () => {
    const database = name('race')
    const role = name('racerole')
    made.push({ database, role })
    await assert.rejects(
      dbOps.provision(
        PG_URL as string,
        { database, role, password: randomBytes(18).toString('base64url') },
        { beforeDatabase: async () => void (await sql(`CREATE DATABASE ${database}`)) },
      ),
      /already exists/,
    )
    assert.equal(await exists('role', role), false)
    // What someone else made is not removed.
    assert.equal(await exists('database', database), true)
  })

  it('without permission to create a database: cannot_create_database, pointing at an existing one; nothing made', async () => {
    const database = name('never')
    const role = name('neverrole')
    made.push({ database, role }) // removed after, even if a broken build makes them
    await assert.rejects(
      dbOps.provision(as(noCreate, 'postgres'), {
        database,
        role,
        password: randomBytes(18).toString('base64url'),
      }),
      (err: Error & { code?: string; howToProceed?: string }) =>
        err.code === 'cannot_create_database' && /--db-url-file/.test(String(err.howToProceed)),
    )
    assert.deepEqual([await exists('database', database), await exists('role', role)], [false, false])
  })

  it('CA21: on a server too old, nothing is created', async () => {
    const database = name('old')
    const role = name('oldrole')
    made.push({ database, role }) // removed after, even if a broken build makes them
    await assert.rejects(
      dbOps.provision(
        PG_URL as string,
        { database, role, password: 'x'.repeat(24) },
        { serverVersionNum: '160004' },
      ),
      (err: Error & { code?: string }) => err.code === 'too_old' && /17/.test(err.message),
    )
    assert.deepEqual([await exists('database', database), await exists('role', role)], [false, false])
  })

  it('refuses names that are not plain identifiers, and a database or role that already exists', async () => {
    made.push({ database: name('fresh2'), role: name('fresh') }, { database: name('ok'), role: name('ok') })
    for (const bad of ['Brain', 'a-b', 'x; DROP DATABASE postgres', '', 'a'.repeat(64), '1abc']) {
      await assert.rejects(
        dbOps.provision(PG_URL as string, { database: bad, role: name('ok'), password: 'x'.repeat(24) }),
        (err: Error & { code?: string }) => err.code === 'invalid_name',
      )
    }
    await assert.rejects(
      dbOps.provision(PG_URL as string, {
        database: factoryDb,
        role: name('fresh'),
        password: 'x'.repeat(24),
      }),
      (err: Error & { code?: string }) => err.code === 'already_exists',
    )
    await assert.rejects(
      dbOps.provision(PG_URL as string, {
        database: name('fresh2'),
        role: factoryRole,
        password: 'x'.repeat(24),
      }),
      (err: Error & { code?: string }) => err.code === 'already_exists',
    )
    assert.equal(await exists('role', name('fresh')), false)
    assert.equal(await exists('database', name('fresh2')), false)
  })

  it('drop removes the database and the role, and refuses a database its role does not own', async () => {
    const database = name('gone')
    const role = name('gonerole')
    made.push({ database, role })
    await dbOps.provision(PG_URL as string, {
      database,
      role,
      password: randomBytes(18).toString('base64url'),
    })
    await assert.rejects(
      dbOps.drop(PG_URL as string, { database: factoryDb, role }),
      (err: Error & { code?: string }) => err.code === 'not_ours',
    )
    assert.equal(await exists('database', factoryDb), true)
    await dbOps.drop(PG_URL as string, { database, role })
    assert.deepEqual([await exists('database', database), await exists('role', role)], [false, false])
    // Again: nothing left to remove is not a failure.
    await dbOps.drop(PG_URL as string, { database, role })
  })

  it('the command line: the admin login on the standard input, the URL to a 0600 file, no secret in the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rscb-db-'))
    try {
      const database = name('cli')
      const role = name('clirole')
      made.push({ database, role })
      const file = join(dir, 'db-url')
      const r = await run(
        [
          'db',
          'provision',
          '--database',
          database,
          '--role',
          role,
          '--url-file',
          file,
          '--isolate-from',
          factoryDb,
          '--json',
        ],
        PG_URL,
      )
      assert.equal(r.code, 0, r.err)
      const url = (await readFile(file, 'utf8')).trim()
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      const password = decodeURIComponent(new URL(url).password)
      assert.ok(password.length >= 32)
      assert.ok(!r.out.includes(password) && !r.err.includes(password), 'the password was printed')
      assert.deepEqual(JSON.parse(r.out), { database, role, urlFile: file, warnings: [] })
      assert.equal(await connectError(as(role, database)), null)
      // An existing file is never overwritten.
      made.push(
        { database: name('cli2'), role: name('clirole2') },
        { database: name('cli4'), role: name('clirole4') },
      )
      const again = await run(
        ['db', 'provision', '--database', name('cli2'), '--role', name('clirole2'), '--url-file', file],
        PG_URL,
      )
      assert.notEqual(again.code, 0)
      assert.equal(await exists('role', name('clirole2')), false)
      // `check` reads the URL from a file and says what it found.
      const checked = await run(['db', 'check', '--db-url-file', file, '--json'])
      assert.equal(checked.code, 0, checked.err)
      assert.deepEqual(Object.keys(JSON.parse(checked.out)).sort(), [
        'canCreate',
        'isSuper',
        'ownsDb',
        'unaccent',
        'version',
      ])
      assert.ok(!checked.out.includes(password))
      // A password or URL on the command line is refused, and never repeated back.
      const argv = await run(
        ['db', 'provision', '--database', database, '--role', role, '--password', 'hunter2-canary'],
        PG_URL,
      )
      assert.equal(argv.code, 2)
      assert.ok(!argv.err.includes('hunter2-canary') && !argv.out.includes('hunter2-canary'))
      const stray = await run(['db', 'check', 'postgres://u:pw-canary@localhost/x'])
      assert.equal(stray.code, 2)
      assert.ok(!stray.err.includes('pw-canary'))
      // Without a file, the URL is printed once on standard output (for a program to read), the rest on stderr.
      const once = await run(
        ['db', 'provision', '--database', name('cli3'), '--role', name('clirole3')],
        PG_URL,
      )
      made.push({ database: name('cli3'), role: name('clirole3') })
      assert.equal(once.code, 0, once.err)
      assert.equal(new URL(once.out.trim()).username, name('clirole3'))
      // drop asks for the name of the database.
      const noConfirm = await run(
        ['db', 'drop', '--database', name('cli3'), '--role', name('clirole3')],
        PG_URL,
      )
      assert.equal(noConfirm.code, 2)
      assert.equal(await exists('database', name('cli3')), true)
      const dropped = await run(
        ['db', 'drop', '--database', name('cli3'), '--role', name('clirole3'), '--confirm', name('cli3')],
        PG_URL,
      )
      assert.equal(dropped.code, 0, dropped.err)
      assert.equal(await exists('database', name('cli3')), false)
      // Without permission to create: exit 3 (a missing requirement; nothing changed).
      const denied = await run(
        ['db', 'provision', '--database', name('cli4'), '--role', name('clirole4')],
        as(noCreate, 'postgres'),
      )
      assert.equal(denied.code, 3)
      assert.match(denied.err, /--db-url-file/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
