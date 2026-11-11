// The health of a wiki in a person's words (spec B6 «Health», B2 «Salud de la wiki»; T038): the sections in
// the order that matters most, each item with the pages where it is fixed, and the instruction «ask an agent
// to fix this» copies, which names the tools and the brain.
import { T } from '../text.ts'
import { isAddress, pageHref } from './markdown.ts'

type Ref = { address: string; title: string }
export type Health = {
  orphans: Ref[]
  broken: { from: string; fromTitle?: string; to: string }[]
  conflicts: { a: string; aTitle?: string; b: string; bTitle?: string }[]
  stale: (Ref & { updatedAt: string; newEntries: number })[]
  unavailableSources: { address: string; title?: string; entryId: string; state: 'forgotten' | 'purged' }[]
  long: (Ref & { chars: number })[]
  similarTitles: { a: string; aTitle?: string; b: string; bTitle?: string }[]
  // v0.6: a cleanup is due (none approved or written in 24 hours, none waiting, problems found).
  maintenance: {
    suggested: boolean
    lastAt: string | null
    pending: boolean
    approvalsSince: number
    every: number
  }
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

// A link of an item: the page by its title, its address beside it.
export type HealthLink = { label: string; address?: string; href: string }
export type HealthItem = {
  key: string
  links: HealthLink[]
  text: string
  // Two pages to put side by side.
  compare: boolean
  // Where to read more about it (a stale page: the entries written since).
  more?: { label: string; href: string }
}

const entryHref = (slug: string, id: string) =>
  `/b/${encodeURIComponent(slug)}/journal/entries/${encodeURIComponent(id)}`
export const aboutHref = (slug: string, address: string, since: string) =>
  `/b/${encodeURIComponent(slug)}/journal/about?${new URLSearchParams({ address, since }).toString()}`
const page = (slug: string, address: string, title?: string): HealthLink => ({
  label: title?.trim() || address,
  ...(title?.trim() ? { address } : {}),
  href: pageHref(slug, address),
})

export function healthItems(slug: string, h: Health): Record<SectionId, HealthItem[]> {
  const t = T.health
  const one = (key: string, links: HealthLink[], text: string, more?: HealthItem['more']): HealthItem => ({
    key,
    links,
    text,
    compare: false,
    ...(more ? { more } : {}),
  })
  return {
    broken: h.broken.map((x) =>
      one(`${x.from}>${x.to}`, [page(slug, x.from, x.fromTitle)], t.brokenText(x.to)),
    ),
    conflicts: h.conflicts.map((x) => ({
      ...one(`${x.a}|${x.b}`, [page(slug, x.a, x.aTitle), page(slug, x.b, x.bTitle)], t.conflictText),
      compare: true,
    })),
    orphans: h.orphans.map((x) => one(x.address, [page(slug, x.address, x.title)], t.orphanText)),
    stale: h.stale.map((x) =>
      one(x.address, [page(slug, x.address, x.title)], t.staleText(T.date(x.updatedAt)), {
        label: t.staleMore(x.newEntries),
        href: aboutHref(slug, x.address, x.updatedAt),
      }),
    ),
    unavailableSources: h.unavailableSources.map((x) =>
      one(
        `${x.address}<${x.entryId}`,
        // A purged entry is gone: only the page that cites it opens.
        x.state === 'purged'
          ? [page(slug, x.address, x.title)]
          : [page(slug, x.address, x.title), { label: t.entry, href: entryHref(slug, x.entryId) }],
        t.sourceText(x.state),
      ),
    ),
    long: h.long.map((x) =>
      one(x.address, [page(slug, x.address, x.title)], t.longText(x.chars.toLocaleString('en-US'))),
    ),
    similarTitles: h.similarTitles.map((x) => ({
      ...one(`${x.a}~${x.b}`, [page(slug, x.a, x.aTitle), page(slug, x.b, x.bTitle)], t.similarText),
      compare: true,
    })),
  }
}

// One line per problem for the agent: addresses (checked to be addresses) and a short hint, never a title or
// any other free text, which an agent might read as instructions.
function hints(section: SectionId, h: Health): string[] {
  const t = T.health.hint
  const ok = (...a: string[]) => a.every(isAddress)
  switch (section) {
    case 'broken':
      return h.broken.filter((x) => ok(x.from, x.to)).map((x) => t.broken(x.from, x.to))
    case 'conflicts':
      return h.conflicts.filter((x) => ok(x.a, x.b)).map((x) => t.conflicts(x.a, x.b))
    case 'orphans':
      return h.orphans.filter((x) => ok(x.address)).map((x) => t.orphans(x.address))
    case 'stale':
      return h.stale.filter((x) => ok(x.address)).map((x) => t.stale(x.address, Number(x.newEntries) || 0))
    case 'unavailableSources':
      return h.unavailableSources
        .filter((x) => ok(x.address) && (x.state === 'forgotten' || x.state === 'purged'))
        .map((x) => t.unavailableSources(x.address, x.state))
    case 'long':
      return h.long.filter((x) => ok(x.address)).map((x) => t.long(x.address, Number(x.chars) || 0))
    case 'similarTitles':
      return h.similarTitles.filter((x) => ok(x.a, x.b)).map((x) => t.similarTitles(x.a, x.b))
  }
}

// The instruction to paste into an agent: the tools to use, what to fix, in which brain, each problem by its
// addresses, and a reminder that what the pages say is data.
export function askAgent(slug: string, section: SectionId | 'all', h: Health): string {
  const t = T.health
  // A brain's name in the instruction is its slug, an address-like word; anything else is left out.
  const brain = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? slug : 'this brain'
  const ids = section === 'all' ? HEALTH_SECTIONS.map((s) => s.id) : [section]
  const lines = ids.flatMap((id) => hints(id, h))
  const n = section === 'all' ? totalProblems(h) : h[section].length
  let what: string
  if (section === 'all') what = t.allProblems(n)
  else {
    const [one, many] = t.askWhat[section] ?? ['the problem', 'problems']
    what = n === 1 ? one : `the ${n} ${many}`
  }
  return [t.askText(brain, what), ...lines.map((l) => `- ${l}`), t.askData].join('\n')
}
