// A running server on a fresh database, with a movable clock and helpers to create accounts and keys
// and to call the API the way a client does.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Clock } from '../../src/core/clock.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createAccount, type NewAccount } from '../../src/domain/accounts.ts'
import { addMember } from '../../src/domain/brains.ts'
import { mintMainKey, mintPersonToken } from '../../src/domain/keys.ts'
import { createHandler } from '../../src/http/app.ts'
import { freshDatabase, type TestDb } from './pg.ts'

export type Call = {
  status: number
  body: Record<string, unknown> & { error?: { code: string; message: string; howToProceed: string } }
  text: string
}

export type World = TestDb & {
  clock: Clock
  now: Date
  advance(ms: number): void
  base: string
  person(name: string, o?: Partial<NewAccount>): Promise<{ id: string; key: string }>
  service(name: string, o?: Partial<NewAccount>): Promise<{ id: string; key: string }>
  token(
    accountId: string,
    o?: { perm?: 'read' | 'write'; brainIds?: string[]; days?: number },
  ): Promise<string>
  member(brainSlug: string, accountId: string, role: 'curator' | 'contributor' | 'reader'): Promise<void>
  call(key: string | null, method: string, path: string, body?: unknown): Promise<Call>
  close(): Promise<void>
}

export async function world(): Promise<World> {
  const t = await freshDatabase()
  await migrate(t.db)
  const w = { now: new Date('2026-10-29T10:00:00.000Z') } as World
  w.clock = () => new Date(w.now.getTime())
  w.advance = (ms) => {
    w.now = new Date(w.now.getTime() + ms)
  }
  const server: Server = createServer(createHandler({ db: t.db, clock: w.clock, log: () => {} }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  let n = 0
  Object.assign(w, t, {
    base: `http://127.0.0.1:${port}`,
    async token(accountId: string, o: { perm?: 'read' | 'write'; brainIds?: string[]; days?: number } = {}) {
      const k = await mintPersonToken(t.db, w.clock, {
        accountId,
        name: 'test',
        perm: o.perm ?? 'write',
        ...(o.brainIds ? { brainIds: o.brainIds } : { allBrains: true }),
        days: o.days ?? 90,
      })
      return k.secret
    },
    async person(name: string, o: Partial<NewAccount> = {}) {
      n += 1
      const id = await createAccount(t.db, w.clock, {
        kind: 'person',
        name,
        email: `${name.toLowerCase()}${n}@example.com`,
        canCreateBrains: true,
        ...o,
      })
      return { id, key: await w.token(id) }
    },
    async service(name: string, o: Partial<NewAccount> = {}) {
      const id = await createAccount(t.db, w.clock, { kind: 'service', name, canCreateBrains: true, ...o })
      const k = await mintMainKey(t.db, w.clock, { accountId: id, name: 'main' })
      return { id, key: k.secret }
    },
    async member(slug: string, accountId: string, role: 'curator' | 'contributor' | 'reader') {
      const b = await t.db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [slug])
      if (!b) throw new Error(`no brain ${slug}`)
      await addMember(t.db, b.id, accountId, role, w.clock())
    },
    async call(key: string | null, method: string, path: string, body?: unknown): Promise<Call> {
      const res = await fetch(`${w.base}${path}`, {
        method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : {}, text }
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()))
      await t.drop()
    },
  })
  return w
}
