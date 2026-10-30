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
// one brain waiting, the count leads there; with more, to home, where each card says how many.
export function toReview(brains: readonly Waiting[]): { count: number; href: string } {
  const mine = brains.filter((b) => b.role === 'curator' && b.stats.pendingProposals > 0)
  const count = mine.reduce((n, b) => n + b.stats.pendingProposals, 0)
  const only = mine.length === 1 ? mine[0] : undefined
  return { count, href: only ? `/b/${encodeURIComponent(only.slug)}` : '/' }
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
