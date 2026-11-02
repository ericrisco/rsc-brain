// Connections with the standard sign-in of MCP (spec B4 «Conexiones»): an agent opens the person's
// browser, the person signs in and consents to some brains, read or read + write, and the agent gets
// an access key of one hour and a refresh token that changes on every use. A connection lasts while it
// is used: 90 days idle or 365 days in all end it. Whatever was granted, a connection never does more
// than the person's current role.

import { createHash, timingSafeEqual } from 'node:crypto'
import { memberRole } from '../auth/principal.ts'
import { hashSecret, newSecret } from '../auth/secrets.ts'
import type { Clock } from '../core/clock.ts'
import { notFound } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Db, Row } from '../db/db.ts'
import { type FetchPolicy, FetchRefused, fetchJson } from '../oauth/fetch.ts'
import { redact } from '../privacy/redact.ts'
import { audit } from './audit.ts'
import { type Ctx, ok } from './context.ts'
import { adminOnly, inWeb } from './guards.ts'
import { installation } from './installation.ts'
import { maintenance } from './maintenance.ts'

export const CODE_SECONDS = 60
export const ACCESS_SECONDS = 3600
export const MAX_DAYS = 365
export const CIMD_REFRESH_HOURS = 1
// Two refreshes sent at once with one token are a race, not a leak: the second one fails quietly.
export const REFRESH_RACE_SECONDS = 30
export const DCR_MAX_URIS = 5

// An error of the standard sign-in, answered as the standard says (not as Brain's own errors).
export class OAuthError extends Error {
  status: number
  error: string
  description: string
  constructor(status: number, error: string, description: string) {
    super(description)
    this.status = status
    this.error = error
    this.description = description
  }
}
const bad = (error: string, description: string, status = 400) => new OAuthError(status, error, description)

export type Client = { clientId: string; kind: 'cimd' | 'dcr'; name: string; redirectUris: string[] }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
// Schemes that are never a place to send a code to.
const NEVER = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
  'ftp:',
  'ws:',
  'wss:',
])

// Where a code may go back to: an encrypted address, this machine, or an app's own scheme (as native
// apps do). Never plain http to another machine (CA14), never with a fragment.
export function redirectAllowed(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password || uri.length > 500) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname)
  return !NEVER.has(u.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)
}

// The address must be exactly one the client registered. On this machine the port may change (an
// app picks a free one each time, RFC 8252 §7.3); everything else must match.
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return false
  return registered.some((r) => {
    try {
      const v = new URL(r)
      v.port = u.port
      return v.protocol === 'http:' && LOOPBACK_HOSTS.has(v.hostname) && v.toString() === u.toString()
    } catch {
      return false
    }
  })
}

// Control characters (C0, DEL, C1): never stored from what a client declares.
const isControl = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  return c < 32 || (c >= 127 && c < 160)
}

// A name as a client declares it, with control characters and broken text taken out, and any secret it
// carries redacted: the name is stored, shown on the consent page, copied to the connection, its keys
// and the audit.
const clientName = (v: unknown, fallback: string) => {
  const raw = typeof v === 'string' && v.isWellFormed() ? v : ''
  const n = [...raw]
    .map((ch) => (isControl(ch) ? ' ' : ch))
    .join('')
    .trim()
    .replace(/\s+/g, ' ')
  return (redact(n).text.trim() || fallback).slice(0, 120)
}
const cleanUri = (x: unknown): x is string =>
  typeof x === 'string' && x.isWellFormed() && ![...x].some(isControl) && redirectAllowed(x)

// A client that names itself by the address of its metadata document (the standard's preferred way).
async function fetchClient(db: Db, now: Date, clientId: string, policy: FetchPolicy): Promise<Client> {
  let u: URL
  try {
    u = new URL(clientId)
  } catch {
    throw bad('invalid_client', 'The client id is not an address.')
  }
  if (u.hash || u.username || u.password || u.pathname === '/' || clientId.length > 500) {
    throw bad('invalid_client', 'A client id document address needs a path, and no fragment or credentials.')
  }
  let doc: Record<string, unknown>
  try {
    const got = await fetchJson(clientId, policy)
    if (!got || typeof got !== 'object' || Array.isArray(got))
      throw new FetchRefused('The document is not an object.')
    doc = got as Record<string, unknown>
  } catch (err) {
    // Brain's own reasons only: a network error says nothing about what is out there.
    const why =
      err instanceof FetchRefused && !/could not be fetched/.test(err.message) ? ` ${err.message}` : ''
    throw bad('invalid_client', `The client's document could not be fetched or used.${why}`)
  }
  if (doc.client_id !== clientId) {
    throw bad(
      'invalid_client',
      'The client document does not name itself with the address it was fetched from.',
    )
  }
  const uris = doc.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || uris.some((x) => !cleanUri(x))) {
    throw bad(
      'invalid_client',
      'The client document lists no usable return address (https, this machine, or an app scheme).',
    )
  }
  const c: Client = {
    clientId,
    kind: 'cimd',
    name: clientName(doc.client_name, u.host),
    redirectUris: uris as string[],
  }
  // Kept for next time, except during maintenance, when nothing is written (spec B7 C12): it is fetched again.
  if (!(await maintenance.current(db, now)))
    await db.query(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, fetched_at, created_at) VALUES ($1, 'cimd', $2, $3, $4, $4)
     ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, fetched_at = EXCLUDED.fetched_at`,
      [clientId, c.name, c.redirectUris, now],
    )
  return c
}

export async function clientOf(
  db: Db,
  clock: Clock,
  clientId: unknown,
  policy: FetchPolicy,
): Promise<Client> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 500) {
    throw bad('invalid_client', 'A client id is required.')
  }
  const now = clock()
  const row = await db.one<Row>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId])
  const document = /^https?:\/\//.test(clientId)
  if (document) {
    const fresh =
      row?.fetched_at != null &&
      now.getTime() - (row.fetched_at as Date).getTime() < CIMD_REFRESH_HOURS * 3_600_000
    if (!fresh) return fetchClient(db, now, clientId, policy)
  }
  if (!row) throw bad('invalid_client', 'This client is not known to rsc-brain.')
  return {
    clientId: String(row.client_id),
    kind: row.kind as Client['kind'],
    name: String(row.name),
    redirectUris: row.redirect_uris as string[],
  }
}

// Dynamic registration (the older way the standard still allows): a client registers its name and
// return addresses and gets an id.
export async function registerClient(db: Db, clock: Clock, body: Record<string, unknown>) {
  const uris = body.redirect_uris
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > DCR_MAX_URIS ||
    uris.some((x) => typeof x !== 'string' || !redirectAllowed(x))
  ) {
    throw bad(
      'invalid_redirect_uri',
      `Give 1 to ${DCR_MAX_URIS} return addresses: https, this machine (http://127.0.0.1 or localhost), or an app scheme.`,
    )
  }
  const method = body.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') {
    throw bad(
      'invalid_client_metadata',
      'rsc-brain registers public clients only (token_endpoint_auth_method "none").',
    )
  }
  const name = clientName(body.client_name, 'Unnamed app')
  const clientId = `dcr_${newSecret().slice(5, 29)}`
  await db.query(
    `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, created_at) VALUES ($1, 'dcr', $2, $3, $4)`,
    [clientId, name, uris, clock()],
  )
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }
}

export async function issuer(db: Db): Promise<string> {
  return (await installation(db)).publicUrl ?? ''
}
export const resourceOf = (base: string) => `${base}/mcp`

export type AuthzRequest = {
  client: Client
  redirectUri: string
  state: string | null
  challenge: string
  resource: string
  scope: string | null
}

// The parts of a request that decide whether the person may be sent back to the client at all. If
// these fail, nothing is sent back: the page shows the problem.
export async function checkClientAndReturn(
  db: Db,
  clock: Clock,
  q: Record<string, unknown>,
  policy: FetchPolicy,
): Promise<{ client: Client; redirectUri: string }> {
  const client = await clientOf(db, clock, q.client_id, policy)
  const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : ''
  if (!redirectUri || !redirectAllowed(redirectUri)) {
    throw bad(
      'invalid_request',
      'The return address is missing, or is neither encrypted nor on this machine.',
    )
  }
  if (!redirectMatches(client.redirectUris, redirectUri)) {
    throw bad('invalid_request', 'The return address is not one this client registered.')
  }
  return { client, redirectUri }
}

const B64URL = /^[A-Za-z0-9_-]{43}$/
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

// The rest of the request; a failure here goes back to the client as an error.
export async function checkRequest(
  db: Db,
  q: Record<string, unknown>,
  base: { client: Client; redirectUri: string },
): Promise<AuthzRequest> {
  const state = typeof q.state === 'string' && q.state.length <= 1000 ? q.state : null
  if (q.response_type !== 'code') throw bad('unsupported_response_type', 'Only "code" is supported.')
  if (
    q.code_challenge_method !== 'S256' ||
    typeof q.code_challenge !== 'string' ||
    !B64URL.test(q.code_challenge)
  ) {
    throw bad('invalid_request', 'A PKCE challenge with method S256 is required.')
  }
  const iss = await issuer(db)
  const asked = typeof q.resource === 'string' ? q.resource.replace(/\/+$/, '') : ''
  if (asked !== resourceOf(iss) && asked !== iss) {
    throw bad('invalid_target', `"resource" must be this installation's MCP address, ${resourceOf(iss)}.`)
  }
  return {
    ...base,
    state,
    challenge: q.code_challenge,
    resource: resourceOf(iss),
    scope: typeof q.scope === 'string' ? q.scope.slice(0, 200) : null,
  }
}

// The brains a person can give a connection: the ones they are an active member of.
export async function consentBrains(db: Db, accountId: string) {
  const rows = await db.query(
    `SELECT b.id, b.slug, b.name, m.role FROM memberships m JOIN brains b ON b.id = m.brain_id
      WHERE m.account_id = $1 ORDER BY b.slug`,
    [accountId],
  )
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    role: String(r.role),
  }))
}

// What the consent page starts from (PR24): the brain the web named («Connect your agent» for a brain
// leaves a cookie hint), else the brains of the invitation the person joined with, else their only brain;
// and read + write only when the app asks for it and the person may write in what is chosen. A hint for a brain
// the person is not in counts for nothing. The person still sees all of it and decides.
export async function consentDefaults(
  db: Db,
  accountId: string,
  brains: Array<{ id: string; slug: string; role: string }>,
  hint: string | null,
  scope: string | null,
): Promise<{ brainIds: Set<string>; perm: 'read' | 'write' }> {
  let chosen = brains.filter((b) => hint !== null && b.slug === hint)
  if (!chosen.length) {
    const inv = await db.one<{ grants: Array<{ brainId: string }> }>(
      'SELECT grants FROM invitations WHERE account_id = $1 AND used_at IS NOT NULL ORDER BY used_at DESC LIMIT 1',
      [accountId],
    )
    const invited = new Set((inv?.grants ?? []).map((g) => g.brainId))
    chosen = brains.filter((b) => invited.has(b.id))
  }
  if (!chosen.length && brains.length === 1) chosen = brains
  // Write only when the app asks for it; an app that asks for nothing gets read.
  const asksWrite = (scope ?? '').split(/\s+/).includes('brain:write')
  const mayWrite = chosen.length > 0 && chosen.every((b) => b.role !== 'reader')
  return { brainIds: new Set(chosen.map((b) => b.id)), perm: asksWrite && mayWrite ? 'write' : 'read' }
}

// The person consented: a code for the client, for 60 seconds, once.
export async function issueCode(
  db: Db,
  clock: Clock,
  r: AuthzRequest,
  accountId: string,
  choice: { brainIds: string[]; perm: 'read' | 'write' },
): Promise<string> {
  if (choice.brainIds.length === 0) throw bad('invalid_request', 'Choose at least one brain.')
  for (const id of choice.brainIds) {
    if (!(await memberRole(db, id, accountId)))
      throw bad('invalid_request', 'A chosen brain is not one of yours.')
  }
  const code = newSecret()
  const now = clock()
  await db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, account_id, brain_ids, perm, challenge, redirect_uri, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      hashSecret(code),
      r.client.clientId,
      accountId,
      choice.brainIds,
      choice.perm,
      r.challenge,
      r.redirectUri,
      r.resource,
      new Date(now.getTime() + CODE_SECONDS * 1000),
    ],
  )
  return code
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function mintAccess(
  db: Db,
  now: Date,
  g: { id: string; account_id: string; brain_ids: string[]; perm: string; client_name: string },
) {
  const secret = newSecret()
  await db.query(
    `INSERT INTO credentials (id, account_id, kind, name, secret_hash, last4, perm, all_brains, brain_ids, grant_id, created_at, expires_at, epoch)
     VALUES ($1, $2, 'app', $3, $4, $5, $6, false, $7, $8, $9, $10, (SELECT key_epoch FROM installation WHERE id = 1))`,
    [
      newId('crd'),
      g.account_id,
      redact(g.client_name).text.slice(0, 80) || 'app',
      hashSecret(secret),
      secret.slice(-4),
      g.perm,
      g.brain_ids,
      g.id,
      now,
      new Date(now.getTime() + ACCESS_SECONDS * 1000),
    ],
  )
  return secret
}

const tokens = (access: string, refresh: string, perm: string) => ({
  access_token: access,
  token_type: 'Bearer',
  expires_in: ACCESS_SECONDS,
  refresh_token: refresh,
  scope: perm === 'write' ? 'brain:read brain:write' : 'brain:read',
})

// Exchanging a code for keys: the same client, the same return address, and the proof (PKCE) that it
// is the client that started the sign-in. Without all three, nothing is given (CA27).
export async function exchangeCode(db: Db, clock: Clock, b: Record<string, unknown>) {
  const code = typeof b.code === 'string' ? b.code : ''
  const verifier = typeof b.code_verifier === 'string' ? b.code_verifier : ''
  if (!code) throw bad('invalid_request', 'The code is missing.')
  if (!VERIFIER.test(verifier))
    throw bad('invalid_grant', 'The PKCE proof (code_verifier) is missing or malformed.')
  const now = clock()
  // Spent before anything is checked, and for good: a failed try uses the code up.
  const c = await db.one<Row>(
    'UPDATE oauth_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL RETURNING *',
    [hashSecret(code), now],
  )
  return db.tx(async (tx) => {
    if (!c || (c.expires_at as Date).getTime() <= now.getTime()) {
      throw bad('invalid_grant', 'The code is unknown, used or expired. Sign in again.')
    }
    if (b.client_id !== c.client_id) throw bad('invalid_grant', 'The code was given to another client.')
    if (b.redirect_uri !== c.redirect_uri)
      throw bad('invalid_grant', 'The return address differs from the one of the sign-in.')
    if (!same(s256(verifier), String(c.challenge)))
      throw bad('invalid_grant', 'The PKCE proof does not match.')
    if (
      typeof b.resource === 'string' &&
      b.resource.replace(/\/+$/, '') !== c.resource &&
      b.resource.replace(/\/+$/, '') !== (await issuer(tx))
    ) {
      throw bad('invalid_target', 'The resource differs from the one of the sign-in.')
    }
    const acc = await tx.one<Row>('SELECT status FROM accounts WHERE id = $1', [c.account_id])
    if (acc?.status !== 'active') throw bad('invalid_grant', 'The account is no longer active.')
    const client = await tx.one<Row>('SELECT name FROM oauth_clients WHERE client_id = $1', [c.client_id])
    const refresh = newSecret()
    const id = newId('app')
    const g = {
      id,
      account_id: String(c.account_id),
      brain_ids: c.brain_ids as string[],
      perm: String(c.perm),
      // An app stored before names were redacted is named clean all the same.
      client_name: clientName(client?.name, 'app'),
    }
    await tx.query(
      `INSERT INTO oauth_grants (id, client_id, client_name, redirect_host, account_id, brain_ids, perm, refresh_hash, epoch,
         created_at, last_used_at, expires_max)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT key_epoch FROM installation WHERE id = 1), $9, $9, $10)`,
      [
        id,
        c.client_id,
        g.client_name,
        hostOf(String(c.redirect_uri)),
        g.account_id,
        g.brain_ids,
        g.perm,
        hashSecret(refresh),
        now,
        new Date(now.getTime() + MAX_DAYS * 86_400_000),
      ],
    )
    const access = await mintAccess(tx, now, g)
    await audit(tx, {
      at: now,
      actorId: g.account_id,
      credentialId: null,
      action: 'connection.create',
      target: id,
      outcome: 'ok',
      detail: `${g.client_name} (${hostOf(String(c.redirect_uri))}), ${g.perm}, ${g.brain_ids.length} brain(s)`,
    })
    return tokens(access, refresh, g.perm)
  })
}

// Where a code goes back to, as a person should read it: the domain of a web address, "this computer"
// for a local one, and for an app's own scheme the scheme itself (what follows it is chosen by the
// app and proves nothing: x-app://claude.ai is not claude.ai).
export function hostOf(uri: string): string {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return u.host
    if (u.protocol === 'http:') return `${u.host} (this computer)`
    // The scheme goes in brackets, after the words: "claude.ai:" must not read as the domain.
    return `an app on this device (${u.protocol})`
  } catch {
    return uri.slice(0, 100)
  }
}

// A refresh token works once: each use gives a new one. Using an old one again means it leaked, so
// the whole connection ends. A connection idle 90 days, or a year old, asks to sign in again (CA29).
export async function refreshGrant(db: Db, clock: Clock, b: Record<string, unknown>) {
  const token = typeof b.refresh_token === 'string' ? b.refresh_token : ''
  if (!token) throw bad('invalid_request', 'The refresh token is missing.')
  const now = clock()
  const h = hashSecret(token)
  // An old refresh token used again means it leaked: the connection ends for good (the refusal that
  // follows must not undo that).
  const replay = await db.one<Row>(
    `SELECT g.id, u.used_at FROM oauth_used_refresh u JOIN oauth_grants g ON g.id = u.grant_id
      WHERE u.hash = $1 AND g.revoked_at IS NULL`,
    [h],
  )
  if (replay && now.getTime() - (replay.used_at as Date).getTime() < REFRESH_RACE_SECONDS * 1000) {
    throw bad('invalid_grant', 'This refresh token was just used by another request. Use the new one it got.')
  }
  if (replay) {
    await endGrant(db, String(replay.id), now)
    await audit(db, {
      at: now,
      actorId: null,
      credentialId: null,
      action: 'connection.replay',
      target: String(replay.id),
      outcome: 'denied',
      detail: 'an old refresh token was used again; the connection was ended',
    })
    throw bad('invalid_grant', 'This refresh token was already used, so the connection ended. Sign in again.')
  }
  return db.tx(async (tx) => {
    const g = await tx.one<Row>(
      `SELECT g.*, a.status, i.key_epoch FROM oauth_grants g JOIN accounts a ON a.id = g.account_id CROSS JOIN installation i
        WHERE g.refresh_hash = $1 FOR UPDATE OF g`,
      [h],
    )
    if (!g) throw bad('invalid_grant', 'This refresh token is unknown or was already used. Sign in again.')
    if (b.client_id !== g.client_id)
      throw bad('invalid_grant', 'This refresh token belongs to another client (send its "client_id").')
    const idle = now.getTime() - (g.last_used_at as Date).getTime() > 90 * 86_400_000
    if (
      g.revoked_at != null ||
      idle ||
      (g.expires_max as Date).getTime() <= now.getTime() ||
      Number(g.epoch) !== Number(g.key_epoch) ||
      g.status !== 'active'
    ) {
      throw bad(
        'invalid_grant',
        'This connection ended (revoked, unused for 90 days, or a year old). Sign in again.',
      )
    }
    const next = newSecret()
    await tx.query('UPDATE oauth_grants SET refresh_hash = $2, last_used_at = $3 WHERE id = $1', [
      g.id,
      hashSecret(next),
      now,
    ])
    await tx.query('INSERT INTO oauth_used_refresh (hash, grant_id, used_at) VALUES ($1, $2, $3)', [
      h,
      g.id,
      now,
    ])
    const access = await mintAccess(tx, now, {
      id: String(g.id),
      account_id: String(g.account_id),
      brain_ids: g.brain_ids as string[],
      perm: String(g.perm),
      client_name: String(g.client_name),
    })
    return tokens(access, next, String(g.perm))
  })
}

export async function endGrant(db: Db, id: string, now: Date) {
  await db.query('UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, $2) WHERE id = $1', [id, now])
  await db.query('UPDATE credentials SET revoked_at = coalesce(revoked_at, $2) WHERE grant_id = $1', [
    id,
    now,
  ])
}

// RFC 7009: a client gives back a token. The answer is the same whether it was known or not.
export async function revokeByToken(db: Db, clock: Clock, b: Record<string, unknown>): Promise<void> {
  const token = typeof b.token === 'string' ? b.token : ''
  if (!token) return
  const h = hashSecret(token)
  const now = clock()
  const g = await db.one<Row>('SELECT id, account_id FROM oauth_grants WHERE refresh_hash = $1', [h])
  if (g) {
    await endGrant(db, String(g.id), now)
    await audit(db, {
      at: now,
      actorId: String(g.account_id),
      credentialId: null,
      action: 'connection.revoke',
      target: String(g.id),
      outcome: 'ok',
      detail: 'by the app',
    })
    return
  }
  await db.query(
    "UPDATE credentials SET revoked_at = coalesce(revoked_at, $2) WHERE secret_hash = $1 AND kind = 'app'",
    [h, now],
  )
}

const appView = async (db: Db, r: Row, now: Date) => {
  const slugs = await db.query('SELECT slug FROM brains WHERE id = ANY($1) ORDER BY slug', [r.brain_ids])
  // The grant counts as used from the code exchange; its keys say when it really reached rsc-brain.
  const used = await db.one<{ at: Date | null }>(
    'SELECT max(last_used_at) AS at FROM credentials WHERE grant_id = $1',
    [r.id],
  )
  return {
    id: String(r.id),
    name: String(r.client_name),
    nameNote: 'Declared by the app, not verified.',
    returnsTo: String(r.redirect_host),
    brains: slugs.map((s) => String(s.slug)),
    perm: String(r.perm),
    createdAt: (r.created_at as Date).toISOString(),
    lastUsedAt: (r.last_used_at as Date).toISOString(),
    lastRequestAt: used?.at ? used.at.toISOString() : null,
    endsAt: new Date(
      Math.min((r.last_used_at as Date).getTime() + 90 * 86_400_000, (r.expires_max as Date).getTime()),
    ).toISOString(),
    ended: !live(r, now),
  }
}

// A connection still alive: not revoked, used within 90 days, not a year old, of this key epoch.
const live = (r: Row, now: Date) =>
  r.revoked_at == null &&
  now.getTime() - (r.last_used_at as Date).getTime() <= 90 * 86_400_000 &&
  (r.expires_max as Date).getTime() > now.getTime() &&
  Number(r.epoch) === Number(r.key_epoch)

// «Connected apps» in the profile: the live ones.
export async function listApps(ctx: Ctx) {
  inWeb(ctx, 'Seeing your connected apps')
  const now = ctx.clock()
  const rows = await ctx.db.query(
    `SELECT g.*, i.key_epoch FROM oauth_grants g CROSS JOIN installation i
      WHERE g.account_id = $1 AND g.revoked_at IS NULL ORDER BY g.last_used_at DESC`,
    [ctx.who.accountId],
  )
  return Promise.all(rows.filter((r) => live(r, now)).map((r) => appView(ctx.db, r, now)))
}

export async function adminApps(ctx: Ctx, accountId: string) {
  adminOnly(ctx)
  const rows = await ctx.db.query(
    `SELECT g.*, i.key_epoch FROM oauth_grants g CROSS JOIN installation i
      WHERE g.account_id = $1 AND g.revoked_at IS NULL ORDER BY g.last_used_at DESC`,
    [accountId],
  )
  return Promise.all(rows.map((r) => appView(ctx.db, r, ctx.clock())))
}

// The person, or the administration, ends a connection: its keys stop at the next request.
export async function revokeApp(ctx: Ctx, id: string) {
  inWeb(ctx, 'Revoking a connected app')
  const admin = ctx.who.isAdmin && ctx.who.kind === 'person'
  const g = await ctx.db.one<Row>(
    'SELECT account_id FROM oauth_grants WHERE id = $1 AND revoked_at IS NULL',
    [id],
  )
  if (!g || !(admin || g.account_id === ctx.who.accountId)) throw notFound('connected app')
  await endGrant(ctx.db, id, ctx.clock())
  await ok(
    ctx,
    'connection.revoke',
    null,
    id,
    g.account_id === ctx.who.accountId ? 'by its person' : 'by the administration',
  )
}
