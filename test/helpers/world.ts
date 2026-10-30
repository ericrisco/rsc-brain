// A running server on a fresh database, with a movable clock and helpers to create accounts and keys
// and to call the API the way a client does.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hashSecret, newSecret } from '../../src/auth/secrets.ts'
import type { Clock } from '../../src/core/clock.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createAccount, type NewAccount } from '../../src/domain/accounts.ts'
import { addMember } from '../../src/domain/brains.ts'
import { mintMainKey, mintPersonToken, mintWebSession } from '../../src/domain/keys.ts'
import { createHandler, WEB_HEADER } from '../../src/http/app.ts'
import type { EventTimings } from '../../src/http/hub.ts'
import type { Message, Sender } from '../../src/mail/mail.ts'
import type { Providers } from '../../src/meaning/providers.ts'
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
  // The key of a connection made with the standard sign-in (an "app" key), for these brains, without
  // going through the consent screens.
  app(
    accountId: string,
    brainIds: string[],
    o?: { perm?: 'read' | 'write'; client?: string },
  ): Promise<string>
  call(key: string | null, method: string, path: string, body?: unknown): Promise<Call>
  // A person in the web: a session cookie (spec B2), and a call that presents it like the web does.
  web(personId: string): Promise<string>
  callWeb(
    session: string,
    method: string,
    path: string,
    body?: unknown,
    o?: { csrf?: boolean },
  ): Promise<Call>
  // Any request, with its own headers; the answer keeps its headers (cookies, Retry-After).
  raw(
    method: string,
    path: string,
    o?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<Call & { headers: Headers }>
  // Mail never leaves the tests: what would be sent is kept here. `mailFails` makes sending fail.
  mails: Array<Message & { from: Sender }>
  mailFails: boolean
  setUpMail(): Promise<void>
  // Waits until a mail to `to` arrives (sends that happen in the background).
  mailTo(to: string, subject?: RegExp): Promise<Message>
  close(): Promise<void>
}

// The installation secret of the tests (never a real one).
export const TEST_SECRET = 'test-secret-of-at-least-thirty-two-characters'

// `fresh`: leave the first-time setup undone (the setup tests). Otherwise the installation is set up.
// `localClients`: client documents of the standard sign-in may be served from this machine over http
// (only tests do that).
export async function world(
  o: { meaning?: Providers; fresh?: boolean; localClients?: boolean; events?: Partial<EventTimings> } = {},
): Promise<World> {
  const t = await freshDatabase()
  await migrate(t.db)
  if (!o.fresh)
    await t.db.query(
      "UPDATE installation SET name = 'Test', public_url = 'http://localhost', setup_done_at = now() WHERE id = 1",
    )
  const w = { now: new Date('2026-10-29T10:00:00.000Z'), mails: [], mailFails: false } as unknown as World
  w.clock = () => new Date(w.now.getTime())
  w.advance = (ms) => {
    w.now = new Date(w.now.getTime() + ms)
  }
  const server: Server = createServer(
    createHandler({
      db: t.db,
      clock: w.clock,
      meaning: o.meaning ?? {},
      secret: TEST_SECRET,
      trustedProxies: ['127.0.0.1'],
      ...(o.localClients ? { fetchPolicy: { allowLoopbackHttp: true } } : {}),
      ...(o.events ? { events: o.events } : {}),
      mailTransport: () => ({
        async send(m) {
          if (w.mailFails) throw new Error('connection refused by the test mail server')
          w.mails.push(m)
        },
      }),
      log: process.env.BRAIN_TEST_LOG ? (l) => process.stderr.write(`${l}\n`) : () => {},
    }),
  )
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
    async app(accountId: string, brainIds: string[], o: { perm?: 'read' | 'write'; client?: string } = {}) {
      n += 1
      const now = w.clock()
      const client = o.client ?? 'Claude Code'
      const clientId = `https://client${n}.example.com/meta.json`
      await t.db.query(
        "INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, created_at) VALUES ($1, 'cimd', $2, $3, $4)",
        [clientId, client, ['http://127.0.0.1/cb'], now],
      )
      const grantId = `app_test${n}`
      await t.db.query(
        `INSERT INTO oauth_grants (id, client_id, client_name, redirect_host, account_id, brain_ids, perm,
           refresh_hash, epoch, created_at, last_used_at, expires_max)
         VALUES ($1, $2, $3, '127.0.0.1', $4, $5, $6, $7, (SELECT key_epoch FROM installation WHERE id = 1),
           $8, $8, $9)`,
        [
          grantId,
          clientId,
          client,
          accountId,
          brainIds,
          o.perm ?? 'write',
          hashSecret(newSecret()),
          now,
          new Date(now.getTime() + 90 * 86_400_000),
        ],
      )
      const secret = newSecret()
      await t.db.query(
        `INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, all_brains, brain_ids,
           grant_id, created_at, expires_at, epoch)
         VALUES ($1, $2, 'app', $3, $4, $5, $6, false, $7, $8, $9, $10,
           (SELECT key_epoch FROM installation WHERE id = 1))`,
        [
          `crd_app_test${n}`,
          accountId,
          client,
          hashSecret(secret),
          secret.slice(-4),
          o.perm ?? 'write',
          brainIds,
          grantId,
          now,
          new Date(now.getTime() + 3_600_000),
        ],
      )
      return secret
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
    async web(personId: string) {
      return (await mintWebSession(t.db, w.clock, { accountId: personId })).secret
    },
    async callWeb(session: string, method: string, path: string, body?: unknown, o: { csrf?: boolean } = {}) {
      const res = await fetch(`${w.base}${path}`, {
        method,
        headers: {
          cookie: `rscb_session=${session}`,
          ...(o.csrf === false ? {} : { 'x-requested-with': WEB_HEADER }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : {}, text }
    },
    async raw(method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}) {
      const res = await fetch(`${w.base}${path}`, {
        method,
        headers: {
          ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(o.headers ?? {}),
        },
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : {}, text, headers: res.headers }
    },
    async setUpMail() {
      await t.db.query('UPDATE installation SET mail = $1 WHERE id = 1', [
        JSON.stringify({
          host: 'smtp.test',
          port: 587,
          secure: false,
          user: null,
          password: null,
          from: { name: 'Test Brain', address: 'brain@example.com' },
        }),
      ])
    },
    async mailTo(to: string, subject?: RegExp) {
      const end = Date.now() + 2000
      for (;;) {
        const m = [...w.mails].reverse().find((x) => x.to === to && (!subject || subject.test(x.subject)))
        if (m) return m
        if (Date.now() > end) throw new Error(`no mail to ${to}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()))
      await t.drop()
    },
  })
  return w
}
