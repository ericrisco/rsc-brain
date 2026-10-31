// Brains as Home and the top bar show them: the address made from a name, what waits for review, and
// when something last happened, in words.

// The address (slug) the server accepts: 2 to 64 lowercase letters, digits and single hyphens.
export function slugOf(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > 64) {
      if (!out) out = w.slice(0, 64)
      break
    }
    out = next
  }
  return out
}

type Waiting = { slug: string; role: string; stats: { pendingProposals: number } }

// The proposals waiting for me: those of the brains I curate (only a curator decides, spec B2). With
// one brain waiting, the count leads to its inbox; with more, to home, where each card says how many.
export function toReview(brains: readonly Waiting[]): { count: number; href: string } {
  const mine = brains.filter((b) => b.role === 'curator' && b.stats.pendingProposals > 0)
  const count = mine.reduce((n, b) => n + b.stats.pendingProposals, 0)
  const only = mine.length === 1 ? mine[0] : undefined
  return { count, href: only ? `/b/${encodeURIComponent(only.slug)}/proposals` : '/' }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function ago(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const t = new Date(iso)
  const s = Math.max(0, (now.getTime() - t.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  const days = Math.floor(s / 86_400)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

// The client of a session as a person says it (overview, «Today's sessions»): a known agent by its
// name, a program by what it is, a browser as a browser — never a raw user agent.
const AGENTS: Array<[RegExp, string]> = [
  [/claude[\s_-]?code/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
  [/gemini/i, 'Gemini CLI'],
  [/opencode/i, 'OpenCode'],
  [/windsurf/i, 'Windsurf'],
  [/rsc[\s-]?factory/i, 'RSC Factory'],
]
const PROGRAMS =
  /^(curl|wget|httpie|python|python-requests|python-urllib|aiohttp|httpx|axios|node|node-fetch|undici|go-http-client|okhttp|java|postmanruntime|insomnia|ruby|php|rust|reqwest)\b/i

export function clientLabel(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v === 'web') return 'the web'
  for (const [re, name] of AGENTS) if (re.test(v)) return name
  if (PROGRAMS.test(v)) return 'an API client'
  if (/^mozilla\//i.test(v)) return 'a browser'
  // "Name/1.2 (details)": the name.
  const name = (v.split('/')[0] ?? v).replace(/\s*\(.*$/, '').trim()
  return name.length > 40 ? `${name.slice(0, 39)}…` : name || null
}
