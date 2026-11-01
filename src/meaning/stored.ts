// Providers of meaning set from the web (spec B3 «la enciende la administración … poniendo su clave», spec
// B6 «Admin › Meaning search»). The key of a paid provider is sealed with the installation secret, like the
// mail password, and never given back: only its last 4 characters. The address of a local provider is kept
// as it is. What the server started with (its environment) stays underneath: a provider set from the web
// takes its place, and removing it brings the environment's back. One process serves an installation, so
// the live set of providers is changed in place and every request and the embedding loop see it at once.
import { keyedHash, unseal } from '../auth/vault.ts'
import type { Db } from '../db/db.ts'
import { audit } from '../domain/audit.ts'
import { ollama, openai, type Provider, type Providers } from './providers.ts'

export type Stored = { openaiKey: string | null; openaiLast4: string | null; ollamaUrl: string | null }

// What each live set held before anything was set from the web: the server's environment.
const started = new WeakMap<Providers, Providers>()

export function environmentOf(live: Providers): Providers {
  let env = started.get(live)
  if (!env) {
    env = { ...live }
    started.set(live, env)
  }
  return env
}

export async function stored(db: Db): Promise<Stored> {
  const r = await db.one<{
    openai_key: string | null
    openai_key_last4: string | null
    ollama_url: string | null
  }>('SELECT openai_key, openai_key_last4, ollama_url FROM meaning_settings WHERE id = 1')
  return {
    openaiKey: r?.openai_key ?? null,
    openaiLast4: r?.openai_key_last4 ?? null,
    ollamaUrl: r?.ollama_url ?? null,
  }
}

// Whether the stored key opens with this installation's secret (another secret, or a value that was not
// sealed for this place, does not).
export function keyOpens(secret: string | undefined, sealed: string | null): boolean {
  if (!sealed) return false
  try {
    unseal(secret, sealed, 'meaning.openai')
    return true
  } catch {
    return false
  }
}

// Makes the live set what the environment and the settings say now: what the web set wins over the
// environment. A stored key that cannot be opened leaves the environment's provider in place (the screen says
// the stored key cannot be read) rather than failing the server.
export async function applyStored(db: Db, live: Providers, secret: string | undefined): Promise<void> {
  const env = environmentOf(live)
  const s = await stored(db)
  for (const k of Object.keys(live)) delete live[k]
  Object.assign(live, env)
  if (s.openaiKey && keyOpens(secret, s.openaiKey))
    live.openai = openai(unseal(secret, s.openaiKey, 'meaning.openai'))
  if (s.ollamaUrl) live.ollama = ollama(s.ollamaUrl)
  await checkDestination(db, live, secret)
}

// Where a provider sends text, without its key: the provider, and a keyed hash of its key, or the origin of
// its address (scheme, host, port), or its model when it has neither (a provider of the tests).
export function destinationOf(p: Provider, secret: string | undefined): string {
  if (p.fingerprint) return p.fingerprint((t) => keyedHash(secret, t))
  if (p.url) {
    try {
      const u = new URL(p.url)
      return `${p.name}:${u.protocol}//${u.host}`
    } catch {
      return `${p.name}:?`
    }
  }
  return `${p.name}:${p.model}`
}

// Meaning search on, and the live destination is not the one the warning was accepted for (the stored key
// stopped opening and the environment's took its place; the environment changed at restart): off, the
// acceptance gone, a line in the audit and the reason for the screen. A row accepted before fingerprints
// existed takes the live destination as its own once (it was accepted for what ran then).
export async function checkDestination(db: Db, live: Providers, secret: string | undefined): Promise<void> {
  await db.tx(async (tx) => {
    const m = await tx.one<{ enabled: boolean; provider: string | null; destination: string | null }>(
      'SELECT enabled, provider, destination FROM meaning_settings WHERE id = 1 FOR UPDATE',
    )
    if (!m?.enabled || !m.provider) return
    const p = live[m.provider]
    const now = p ? destinationOf(p, secret) : null
    if (m.destination === null && now) {
      await tx.query('UPDATE meaning_settings SET destination = $1 WHERE id = 1', [now])
      return
    }
    if (now === m.destination) return
    const at = new Date()
    await tx.query(
      `UPDATE meaning_settings SET enabled = false, accepted_by = NULL, accepted_at = NULL, changed_at = $1,
              off_reason = $2 WHERE id = 1`,
      [
        at,
        `Turned off: where ${m.provider} sends text changed since the warning was accepted (its key could not be read, or the server's environment changed). Accept the warning again to turn it on.`,
      ],
    )
    await audit(tx, {
      at,
      actorId: null,
      credentialId: null,
      action: 'meaning.disable',
      outcome: 'ok',
      detail: `${m.provider}: the live destination is not the one accepted; the warning must be accepted again`,
    })
  })
}
