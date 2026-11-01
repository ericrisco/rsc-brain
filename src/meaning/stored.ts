// Providers of meaning set from the web (spec B3 «la enciende la administración … poniendo su clave», spec
// B6 «Admin › Meaning search»). The key of a paid provider is sealed with the installation secret, like the
// mail password, and never given back: only its last 4 characters. The address of a local provider is kept
// as it is. What the server started with (its environment) stays underneath: a provider set from the web
// takes its place, and removing it brings the environment's back. One process serves an installation, so
// the live set of providers is changed in place and every request and the embedding loop see it at once.
import { unseal } from '../auth/vault.ts'
import type { Db } from '../db/db.ts'
import { ollama, openai, type Providers } from './providers.ts'

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

// Makes the live set what the environment and the settings say now. A key that cannot be opened (another
// installation secret) leaves that provider out rather than failing the server.
export async function applyStored(db: Db, live: Providers, secret: string | undefined): Promise<void> {
  const env = environmentOf(live)
  const s = await stored(db)
  for (const k of Object.keys(live)) delete live[k]
  Object.assign(live, env)
  if (s.openaiKey && secret) {
    try {
      live.openai = openai(unseal(secret, s.openaiKey))
    } catch {
      delete live.openai
    }
  }
  if (s.ollamaUrl) live.ollama = ollama(s.ollamaUrl)
}
