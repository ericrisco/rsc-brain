// Providers of meaning (spec B3): they turn texts into vectors. A paid one (OpenAI, small embeddings
// model) and a local one without a key (Ollama). They come from the environment, or from the settings the
// administration saves in the web (src/meaning/stored.ts: the key sealed, never given back). Every vector
// comes back normalised to length 1.

export type Provider = {
  name: string
  model: string
  // To name a provider's key without showing it, and a local provider's address (Admin › Meaning search).
  last4?: string
  url?: string
  // Where its text goes, without the key: the key through a keyed hash given by the caller.
  fingerprint?: (hash: (text: string) => string) => string
  embed(texts: string[], o: { signal: AbortSignal }): Promise<number[][]>
}

export type Providers = Record<string, Provider>

// Each text sent is cut to this many characters: enough for meaning, bounded for cost.
export const SEND_CHARS = 8000

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return n > 0 ? v.map((x) => x / n) : v
}

async function post(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`The meaning provider answered ${res.status}.`)
  return (await res.json()) as Record<string, unknown>
}

function vectors(raw: unknown, n: number): number[][] {
  if (!Array.isArray(raw) || raw.length !== n)
    throw new Error('The meaning provider gave an unexpected answer.')
  return raw.map((v) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 8192 || !v.every((x) => Number.isFinite(x)))
      throw new Error('The meaning provider gave an unexpected vector.')
    return normalise(v as number[])
  })
}

// 256 dimensions (the model can shorten its vectors): close in quality, six times cheaper to compare.
export function openai(key: string, model = 'text-embedding-3-small', dimensions = 256): Provider {
  return {
    name: 'openai',
    model: `${model}@${dimensions}`,
    last4: key.slice(-4),
    fingerprint: (hash) => `openai:${hash(key)}`,
    async embed(texts, { signal }) {
      const out = await post(
        'https://api.openai.com/v1/embeddings',
        { model, input: texts, dimensions },
        { authorization: `Bearer ${key}` },
        signal,
      )
      const data = out.data as { embedding: number[]; index: number }[] | undefined
      if (!Array.isArray(data)) throw new Error('The meaning provider gave an unexpected answer.')
      return vectors(
        [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding),
        texts.length,
      )
    },
  }
}

export function ollama(baseUrl: string, model = 'nomic-embed-text'): Provider {
  return {
    name: 'ollama',
    model,
    url: baseUrl,
    async embed(texts, { signal }) {
      const out = await post(`${baseUrl.replace(/\/+$/, '')}/api/embed`, { model, input: texts }, {}, signal)
      return vectors(out.embeddings, texts.length)
    },
  }
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Providers {
  const out: Providers = {}
  if (env.RSC_BRAIN_OPENAI_KEY) out.openai = openai(env.RSC_BRAIN_OPENAI_KEY)
  if (env.RSC_BRAIN_OLLAMA_URL) out.ollama = ollama(env.RSC_BRAIN_OLLAMA_URL)
  return out
}
