import { plainText } from './markdown.ts'

// Search from anywhere (spec B6 «Search», T039): the request for the current brain or all of them, with the
// filters; and what to suggest when nothing is found.

export type SearchForm = {
  q: string
  // brain: the brain on screen; all: every brain the person is in.
  scope: 'brain' | 'all'
  brain: string | null
  what: '' | 'pages' | 'entries'
  type: string
  from: string
}

export const PAGE_SIZE = 20

export function searchParams(f: SearchForm, offset = 0): Record<string, string | number> {
  const out: Record<string, string | number> = { q: f.q.trim(), limit: PAGE_SIZE }
  if (f.scope === 'brain' && f.brain) out.brains = f.brain
  if (f.what) out.in = f.what
  if (f.type) out.types = f.type
  if (f.from) out.from = f.from
  if (offset) out.offset = offset
  return out
}

export const activeFilters = (f: Pick<SearchForm, 'what' | 'type' | 'from'>) =>
  [f.what, f.type, f.from].filter(Boolean).length

// What to offer when nothing is found: removing the filters, searching every brain, both or neither.
export function noResults(o: {
  filtered: boolean
  scope: 'brain' | 'all'
  inBrain: boolean
}): Array<'clear' | 'all'> {
  const out: Array<'clear' | 'all'> = []
  if (o.filtered) out.push('clear')
  if (o.scope === 'brain' && o.inBrain) out.push('all')
  return out
}

// The types a result may have: those of journal entries and of wiki pages (B1, B2).
export const ENTRY_TYPES = [
  'decision',
  'learning',
  'attempt',
  'correction',
  'preference',
  'fact',
  'step',
  'summary',
  'note',
]
export const PAGE_TYPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview']
export const TYPES = [...new Set([...ENTRY_TYPES, ...PAGE_TYPES])].sort()

// The types the Type filter offers for what is shown.
export function typesFor(what: SearchForm['what']): string[] {
  if (what === 'pages') return [...PAGE_TYPES].sort()
  if (what === 'entries') return [...ENTRY_TYPES].sort()
  return TYPES
}

// A snippet as plain words, with the parts the server marked as matching («…») to highlight. Markdown and
// wiki links are dropped (plainText), never rendered: what comes back is text for text nodes.
export type SnippetPart = { text: string; mark: boolean }
export function snippetParts(snippet: string): SnippetPart[] {
  const plain = plainText(snippet)
  const out: SnippetPart[] = []
  let at = 0
  for (const m of plain.matchAll(/«([^«»]*)»/g)) {
    const i = m.index ?? 0
    if (i > at) out.push({ text: plain.slice(at, i), mark: false })
    if (m[1]) out.push({ text: m[1], mark: true })
    at = i + m[0].length
  }
  if (at < plain.length) out.push({ text: plain.slice(at), mark: false })
  // Neighbouring plain parts (an empty mark between them) are one.
  return out.reduce<SnippetPart[]>((acc, p) => {
    const prev = acc.at(-1)
    if (prev && !prev.mark && !p.mark) prev.text += p.text
    else acc.push({ ...p })
    return acc
  }, [])
}
