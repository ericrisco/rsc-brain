// The health address (spec B7 «Salud y registros», C20; plan §3.4): public, for an outside watcher — whether
// the service answers, whether its database answers, whether it is under maintenance. 503 when the database
// does not answer. Without a valid key never the version, nor anything private; with one, the version (rsc-updates
// §3.9: rsc-factory shows it). And G14 for the administration: free disk where
// the copies go, the size of the database, the maintenance under way.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { KEY_PREFIX } from '../../src/auth/secrets.ts'
import { silentLog } from '../../src/core/log.ts'
import { VERSION } from '../../src/core/version.ts'
import type { Db } from '../../src/db/db.ts'
import { createHandler, HEALTH_TIMEOUT_MS } from '../../src/http/app.ts'
import { maintenance } from '../../src/http/maintenance.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const NOW = new Date('2026-11-01T10:00:00.000Z')

async function serve(db: Db): Promise<{ base: string; server: Server }> {
  const server = createServer(createHandler({ db, clock: () => NOW, web: false, log: silentLog }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}
const fakeDb = (answer: () => Promise<unknown>): Db => {
  const db = {
    query: async () => [await answer()],
    one: async () => await answer(),
    tx: (f: (d: Db) => Promise<unknown>) => f(db as unknown as Db),
  }
  return db as unknown as Db
}
const get = async (base: string, method = 'GET') => {
  const res = await fetch(`${base}/v1/health`, { method })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text, res }
}

describe('GET /v1/health without PostgreSQL', () => {
  it('the database answers: 200 { ok, database: "ok", maintenance: false }, no version', async () => {
    const s = await serve(fakeDb(async () => ({ maintenance_until: null })))
    try {
      const r = await get(s.base)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { ok: true, database: 'ok', maintenance: false })
      assert.equal(r.res.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(r.text, /version|0\.1\.0/)
    } finally {
      s.server.close()
    }
  })

  it('under maintenance it still answers 200, and says so', async () => {
    const s = await serve(fakeDb(async () => ({ maintenance_until: new Date(NOW.getTime() + 60_000) })))
    try {
      assert.deepEqual((await get(s.base)).body, { ok: true, database: 'ok', maintenance: true })
    } finally {
      s.server.close()
    }
  })

  it('an expired maintenance is none', async () => {
    const s = await serve(fakeDb(async () => ({ maintenance_until: new Date(NOW.getTime() - 1) })))
    try {
      assert.deepEqual((await get(s.base)).body, { ok: true, database: 'ok', maintenance: false })
    } finally {
      s.server.close()
    }
  })

  it('the database fails: 503 { ok: false, database: "down" }, and nothing of the error', async () => {
    const s = await serve(
      fakeDb(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2')
      }),
    )
    try {
      const r = await get(s.base)
      assert.equal(r.status, 503)
      assert.deepEqual(r.body, { ok: false, database: 'down', maintenance: false })
      assert.doesNotMatch(r.text, /ECONNREFUSED|hunter2|10\.0\.0\.7/)
      const head = await get(s.base, 'HEAD')
      assert.equal(head.status, 503)
      assert.equal(head.text, '')
    } finally {
      s.server.close()
    }
  })

  it('the database hangs: 503 once the health check gives up', async () => {
    assert.ok(HEALTH_TIMEOUT_MS <= 3000)
    const s = await serve(fakeDb(() => new Promise(() => {})))
    try {
      const t0 = Date.now()
      const r = await get(s.base)
      assert.equal(r.status, 503)
      assert.equal(r.body.database, 'down')
      assert.ok(Date.now() - t0 < HEALTH_TIMEOUT_MS + 1500)
    } finally {
      s.server.closeAllConnections()
      s.server.close()
    }
  })

  it('a database down with a key: the same answer, in the same time', async () => {
    const s = await serve(fakeDb(() => new Promise(() => {})))
    try {
      const t0 = Date.now()
      const res = await fetch(`${s.base}/v1/health`, {
        headers: { authorization: `Bearer ${KEY_PREFIX}a_key` },
      })
      assert.equal(res.status, 503)
      assert.deepEqual(await res.json(), { ok: false, database: 'down', maintenance: false })
      assert.ok(Date.now() - t0 < HEALTH_TIMEOUT_MS + 1500)
    } finally {
      s.server.closeAllConnections()
      s.server.close()
    }
  })

  it('a key whose check hangs or fails: the health stands, without the version', async () => {
    let calls = 0
    const hanging = fakeDb(async () => {
      calls++
      if (calls === 1) return { maintenance_until: null }
      return new Promise(() => {})
    })
    const failing = fakeDb(async () => {
      calls++
      if (calls === 1) return { maintenance_until: null }
      throw new Error('connect ECONNREFUSED password=hunter2')
    })
    for (const db of [hanging, failing]) {
      calls = 0
      const s = await serve(db)
      try {
        const res = await fetch(`${s.base}/v1/health`, {
          headers: { authorization: `Bearer ${KEY_PREFIX}a_key` },
        })
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), { ok: true, database: 'ok', maintenance: false })
      } finally {
        s.server.closeAllConnections()
        s.server.close()
      }
    }
  })
})

describe('health on PostgreSQL', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backups-'))
    w = await world({ backups: dir })
    admin = await w.person('Ada', { isAdmin: true })
  })
  after(async () => {
    await w.close()
    await rm(dir, { recursive: true })
  })

  it('GET /v1/health: 200 with the database, and the maintenance as it is', async () => {
    const r = await w.raw('GET', '/v1/health')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, database: 'ok', maintenance: false })
    await maintenance.on(w.db, w.clock(), { reason: 'update' })
    assert.deepEqual((await w.raw('GET', '/v1/health')).body, { ok: true, database: 'ok', maintenance: true })
    await maintenance.off(w.db)
  })

  it('with a valid key it says the version; with none, a wrong one or a web session, it does not', async () => {
    const r = await w.call(admin.key, 'GET', '/v1/health')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, database: 'ok', maintenance: false, version: VERSION })
    const plain = { ok: true, database: 'ok', maintenance: false }
    assert.deepEqual((await w.raw('GET', '/v1/health')).body, plain)
    assert.deepEqual((await w.call(`${KEY_PREFIX}not_a_key`, 'GET', '/v1/health')).body, plain)
    const web = await w.web(admin.id)
    assert.deepEqual((await w.callWeb(web, 'GET', '/v1/health')).body, plain)
    assert.deepEqual((await w.call(web, 'GET', '/v1/health')).body, plain, 'a session is no key')
  })

  it('with a valid key under maintenance: the version too', async () => {
    await maintenance.on(w.db, w.clock(), { reason: 'update' })
    try {
      const r = await w.call(admin.key, 'GET', '/v1/health')
      assert.deepEqual(r.body, { ok: true, database: 'ok', maintenance: true, version: VERSION })
    } finally {
      await maintenance.off(w.db)
    }
  })

  it('G14: the system screen adds the disk and the maintenance', async () => {
    const web = await w.web(admin.id)
    const r = await w.callWeb(web, 'GET', '/v1/admin/system')
    assert.equal(r.status, 200, r.text)
    const disk = r.body.disk as { backupsFree: number; databaseBytes: number }
    assert.ok(Number.isInteger(disk.databaseBytes) && disk.databaseBytes > 1_000_000, JSON.stringify(disk))
    assert.ok(Number.isInteger(disk.backupsFree) && disk.backupsFree > 0, JSON.stringify(disk))
    assert.equal(r.body.maintenance, null)
    await maintenance.on(w.db, w.clock(), { seconds: 600, reason: 'restore' })
    const on = await w.callWeb(web, 'GET', '/v1/admin/system')
    assert.deepEqual(on.body.maintenance, {
      until: new Date(w.clock().getTime() + 600_000).toISOString(),
      reason: 'restore',
    })
    await maintenance.off(w.db)
  })
})

describe('G14 without a folder for copies', { skip: skipPg }, () => {
  it('backupsFree is null when no folder is set', async () => {
    const w = await world()
    try {
      const a = await w.person('Ada', { isAdmin: true })
      const r = await w.callWeb(await w.web(a.id), 'GET', '/v1/admin/system')
      assert.equal((r.body.disk as Record<string, unknown>).backupsFree, null)
    } finally {
      await w.close()
    }
  })
})
