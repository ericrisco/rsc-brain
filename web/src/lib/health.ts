// The health of a wiki in a person's words (spec B6 «Health», B2 «Salud de la wiki»; T038): the sections in
// the order that matters most, each item with the pages where it is fixed, and the instruction «ask an agent
// to fix this» copies, which names the tools and the brain.
import { T } from '../text.ts'
import { pageHref } from './markdown.ts'

type Ref = { address: string; title: string }
export type Health = {
  orphans: Ref[]
  broken: { from: string; to: string }[]
  conflicts: { a: string; b: string }[]
  stale: (Ref & { updatedAt: string; newEntries: number })[]
  unavailableSources: { address: string; entryId: string; state: 'forgotten' | 'purged' }[]
  long: (Ref & { chars: number })[]
  similarTitles: { a: string; b: string }[]
  maintenance: { suggested: boolean; approvalsSince: number; every: number }
}

export type SectionId =
  | 'broken'
  | 'conflicts'
  | 'orphans'
  | 'stale'
  | 'unavailableSources'
  | 'long'
  | 'similarTitles'

export const HEALTH_SECTIONS: ReadonlyArray<{ id: SectionId }> = [
  { id: 'broken' },
  { id: 'conflicts' },
  { id: 'orphans' },
  { id: 'stale' },
  { id: 'unavailableSources' },
  { id: 'long' },
  { id: 'similarTitles' },
]

export const totalProblems = (h: Health) => HEALTH_SECTIONS.reduce((n, s) => n + h[s.id].length, 0)

export type HealthItem = { key: string; links: Array<{ label: string; href: string }>; text: string }

const entryHref = (slug: string, id: string) =>
  `/b/${encodeURIComponent(slug)}/journal/entries/${encodeURIComponent(id)}`
const page = (slug: string, address: string) => ({ label: address, href: pageHref(slug, address) })

export function healthItems(slug: string, h: Health): Record<SectionId, HealthItem[]> {
  const t = T.health
  return {
    broken: h.broken.map((x) => ({
      key: `${x.from}>${x.to}`,
      links: [page(slug, x.from)],
      text: t.brokenText(x.to),
    })),
    conflicts: h.conflicts.map((x) => ({
      key: `${x.a}|${x.b}`,
      links: [page(slug, x.a), page(slug, x.b)],
      text: t.conflictText,
    })),
    orphans: h.orphans.map((x) => ({ key: x.address, links: [page(slug, x.address)], text: t.orphanText })),
    stale: h.stale.map((x) => ({
      key: x.address,
      links: [page(slug, x.address)],
      text: t.staleText(x.newEntries, T.date(x.updatedAt)),
    })),
    unavailableSources: h.unavailableSources.map((x) => ({
      key: `${x.address}<${x.entryId}`,
      // A purged entry is gone: only the page that cites it opens.
      links:
        x.state === 'purged'
          ? [page(slug, x.address)]
          : [page(slug, x.address), { label: t.entry, href: entryHref(slug, x.entryId) }],
      text: t.sourceText(x.state),
    })),
    long: h.long.map((x) => ({
      key: x.address,
      links: [page(slug, x.address)],
      text: t.longText(x.chars.toLocaleString('en-US')),
    })),
    similarTitles: h.similarTitles.map((x) => ({
      key: `${x.a}~${x.b}`,
      links: [page(slug, x.a), page(slug, x.b)],
      text: t.similarText,
    })),
  }
}

// The instruction to paste into an agent: the tools to use, what to fix and in which brain.
export function askAgent(slug: string, section: SectionId | 'all', n: number): string {
  const t = T.health
  if (section === 'all') return t.askText(slug, t.allProblems(n))
  const [one, many] = t.askWhat[section] ?? ['the problem', 'problems']
  return t.askText(slug, n === 1 ? one : `the ${n} ${many}`)
}
