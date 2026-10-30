// A wiki and its journal from a seed (plan §4 «Datos de prueba fijos»): 300 or 5 000 pages with types,
// statuses, tags, about three typed links a page, addresses of two or three parts, and the sessions and
// entries that fed them. The same output feeds the fixture API (CI) and the seeding of a real server
// (local), so measurements compare the same thing. Names and text are fictitious.
export type GenPage = {
  address: string
  title: string
  type: 'topic' | 'entity' | 'decision' | 'guide' | 'agent' | 'source' | 'overview'
  status: 'current' | 'stale' | 'superseded' | 'retired'
  tags: string[]
  summary: string
}
export type GenLink = [from: string, to: string, kind: string]
export type GenSession = { id: string; client: string; purpose: string; ref: string | null; openedAt: string }
export type GenEntry = {
  id: string
  sessionId: string
  type: string
  title: string
  content: string
  at: string
}

const TYPES: GenPage['type'][] = [
  'topic',
  'topic',
  'topic',
  'entity',
  'entity',
  'decision',
  'guide',
  'agent',
  'source',
  'overview',
]
const STATUSES: GenPage['status'][] = [
  ...Array(14).fill('current'),
  'stale',
  'stale',
  'superseded',
  'retired',
]
const KINDS = [
  'related',
  'related',
  'related',
  'depends-on',
  'part-of',
  'example-of',
  'supersedes',
  'contradicts',
]
const AREAS = [
  'audience',
  'product',
  'pricing',
  'research',
  'brand',
  'sales',
  'support',
  'infra',
  'people',
  'ops',
  'content',
  'legal',
]
const WORDS = [
  'retention',
  'onboarding',
  'intro',
  'churn',
  'pricing',
  'trial',
  'cohort',
  'interview',
  'roadmap',
  'release',
  'latency',
  'backup',
  'invoice',
  'hiring',
  'tone',
  'headline',
  'newsletter',
  'webinar',
  'funnel',
  'persona',
  'contract',
  'consent',
  'audit',
  'deploy',
  'incident',
  'survey',
  'segment',
  'renewal',
  'discount',
  'launch',
]
const TAGS = ['q3', 'q4', 'experiment', 'customer', 'internal', 'policy', 'draft', 'metric', 'risk', 'idea']
const CLIENTS = ['claude-code', 'codex', 'cursor', 'opencode', 'rsc-factory']
const ENTRY_TYPES = ['decision', 'learning', 'attempt', 'fact', 'note', 'preference', 'step']

// mulberry32: small, fast, and the same everywhere.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generate(o: { pages: number; seed: number }) {
  const r = rng(o.seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
  const pages: GenPage[] = []
  const used = new Set<string>()
  const base = Date.UTC(2026, 9, 1)
  while (pages.length < o.pages) {
    const area = pick(AREAS)
    const parts = r() < 0.4 ? [area, pick(WORDS), pick(WORDS)] : [area, pick(WORDS)]
    let address = parts.join('/')
    if (used.has(address)) address = `${address}-${pages.length}`
    used.add(address)
    const last = parts[parts.length - 1] as string
    const tags = TAGS.filter(() => r() < 0.15)
    pages.push({
      address,
      title: `${last[0]?.toUpperCase()}${last.slice(1)} in ${area}`,
      type: pick(TYPES),
      status: pick(STATUSES),
      tags,
      summary: `What the team knows about ${last} in ${area}.`,
    })
  }
  const links: GenLink[] = []
  const seen = new Set<string>()
  for (let i = 0; i < pages.length; i++) {
    const n = 2 + Math.floor(r() * 3)
    for (let k = 0; k < n; k++) {
      // Most links stay near (same area), some cross the wiki.
      const j = r() < 0.7 ? (i + 1 + Math.floor(r() * 20)) % pages.length : Math.floor(r() * pages.length)
      if (j === i) continue
      const from = (pages[i] as GenPage).address
      const to = (pages[j] as GenPage).address
      const key = `${from}>${to}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push([from, to, pick(KINDS)])
    }
  }
  const sessions: GenSession[] = []
  const entries: GenEntry[] = []
  const nSessions = Math.max(10, Math.round(o.pages / 10))
  for (let s = 0; s < nSessions; s++) {
    const client = pick(CLIENTS)
    const opened = base + s * 3_600_000
    const id = `ses_g${o.seed.toString(36)}${s.toString(36).padStart(4, '0')}`
    sessions.push({
      id,
      client,
      purpose: `Work on ${pick(WORDS)}`,
      ref: client === 'rsc-factory' ? `r_${(s * 7919).toString(36)}` : null,
      openedAt: new Date(opened).toISOString(),
    })
    const n = 1 + Math.floor(r() * 4)
    for (let e = 0; e < n; e++) {
      const w = pick(WORDS)
      entries.push({
        id: `ent_g${o.seed.toString(36)}${s.toString(36)}x${e}`,
        sessionId: id,
        type: pick(ENTRY_TYPES),
        title: `${w[0]?.toUpperCase()}${w.slice(1)} note ${s}.${e}`,
        content: `Observed while working on ${w}.`,
        at: new Date(opened + e * 60_000).toISOString(),
      })
    }
  }
  return { pages, links, sessions, entries }
}
