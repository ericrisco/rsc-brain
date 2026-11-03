// Activity in words (spec B6 «Activity: en vivo», T037): who did what, with which client, and the filters by
// client, kind and reference. A Factory reference links to its run only when the installation has a Factory
// address that passes the same safe-address rule as the server (plan §3.5, CA9); otherwise it is text.
import { KEEP, type LiveEvent } from '../live/stream.ts'
import { T } from '../text.ts'
import { clientLabel } from './brains.ts'

// The same rule as src/core/urls.ts (a test keeps them equal): http(s), a plain host, an optional port and
// path; no credentials, no query, no fragment.
export const SAFE_URL = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/

// The kinds a person filters by, in the order they matter: what changed first, what was looked at last.
export const KINDS = [
  { id: 'writes', test: (k: string) => k.startsWith('entry.') },
  { id: 'sessions', test: (k: string) => k.startsWith('session.') },
  { id: 'proposals', test: (k: string) => k.startsWith('proposal.') },
  { id: 'wiki', test: (k: string) => k.startsWith('wiki.') },
  { id: 'searches', test: (k: string) => k === 'search' },
  { id: 'reads', test: (k: string) => k === 'read' },
] as const

const kindOf = (k: string) => KINDS.find((x) => x.test(k))?.id ?? ''

export type Said = {
  who: string
  client: string | null
  did: string
  what: string | null
  kind: string
  // Who an agent's key acted for.
  forWhom: string | null
}

// What a change to an entry was, from its label: forgetting and recovering say so (the label is not a title
// then), a relation says how, anything else is an edit (the label is the new title).
function entryChange(label: string | null): { did: string; what: string | null } {
  const d = T.activity.changed
  if (label === 'forgotten') return { did: d.forgot, what: null }
  if (label === 'recovered') return { did: d.recovered, what: null }
  const rel = label ? /^([a-z_-]+) \(([a-z_ ]+)\)$/.exec(label) : null
  if (rel) return { did: d.related, what: `${rel[1]?.replace(/[-_]/g, ' ')} (${rel[2]})` }
  return { did: d.edited, what: label }
}

// A change to the wiki, from its summary: a direct edit names the page without jargon; a proposal applied
// names its summary.
function wikiChange(label: string | null): { did: string; what: string | null } {
  const d = T.activity.wiki
  if (!label) return { did: d.changed, what: null }
  if (label === 'purge') return { did: d.purged, what: null }
  const direct = /^Direct (create|edit|move|retire|supersede|delete|[a-z]+): (.+)$/.exec(label)
  if (direct) return { did: d.op[direct[1] as string] ?? d.changed, what: direct[2] ?? null }
  const status = /^Direct status → ([a-z]+): (.+)$/.exec(label)
  if (status) return { did: d.status(status[1] as string), what: status[2] ?? null }
  const back = /^Back to revision (\d+): (.+)$/.exec(label)
  if (back) return { did: d.back(back[1] as string), what: back[2] ?? null }
  return { did: d.applied, what: label.replace(/^Approved: /, '') }
}

export function describeEvent(e: LiveEvent): Said {
  const a = T.activity
  const label = e.target?.label ?? null
  let did = a.did[e.kind] ?? e.kind
  let what: string | null = label
  if (e.kind === 'search') what = e.query ? `“${e.query}”` : null
  else if (e.kind === 'proposal.decided') {
    did = label ? `${did}: ${label.replace(/_/g, ' ')}` : did
    what = null
  } else if (e.kind === 'entry.changed') ({ did, what } = entryChange(label))
  else if (e.kind === 'wiki.changed') ({ did, what } = wikiChange(label))
  return {
    who: e.who?.name || a.installation,
    client: clientLabel(e.client),
    did,
    what,
    kind: kindOf(e.kind),
    forWhom: e.onBehalf?.name || null,
  }
}

// One row of the feed: an event, or a search repeated by the same person with the same words within a minute
// of the newest (agents refine and retry; the feed says it once, with how many).
export type FeedRow = { e: LiveEvent; count: number }
export const REPEAT_MS = 60_000

export function groupEvents(events: readonly LiveEvent[]): FeedRow[] {
  const rows: FeedRow[] = []
  for (const e of events) {
    let joined = false
    if (e.kind === 'search') {
      // Newest first: look back over the rows of the last minute (before this one) for the same search.
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i] as FeedRow
        if (Date.parse(r.e.at) - Date.parse(e.at) > REPEAT_MS) break
        if (r.e.kind === 'search' && r.e.query === e.query && (r.e.who?.id ?? null) === (e.who?.id ?? null)) {
          r.count += 1
          joined = true
          break
        }
      }
    }
    if (!joined) rows.push({ e, count: 1 })
  }
  return rows
}

// How many new events wait while paused, as the filters would show them; past the cap, "500+".
export function waitingLabel(waiting: readonly LiveEvent[], f: ActivityFilters, overflow: boolean): string {
  if (overflow) return `${KEEP}+`
  return String(filterEvents(waiting, f).length)
}

export type ActivityFilters = { client: string; kind: string; ref: string }

export function filterEvents(events: readonly LiveEvent[], f: ActivityFilters): LiveEvent[] {
  const ref = f.ref.trim().toLowerCase()
  return events.filter(
    (e) =>
      (!f.client || clientLabel(e.client) === f.client) &&
      (!f.kind || kindOf(e.kind) === f.kind) &&
      (!ref ||
        (e.key?.ref ?? '').toLowerCase().includes(ref) ||
        (e.sessionRef ?? '').toLowerCase().includes(ref)),
  )
}

// The clients seen, as a person says them, for the filter.
export function clientsOf(events: readonly LiveEvent[]): string[] {
  const seen = new Set<string>()
  for (const e of events) {
    const c = clientLabel(e.client)
    if (c) seen.add(c)
  }
  return [...seen].sort((x, y) => x.localeCompare(y))
}

// The run id RSC Factory gives a run and stamps on its keys' references: "r_" and 8 lowercase hex characters
// (rsc-factory src/core/engine.ts), a word of its own (not part of a longer one, nor joined by a hyphen).
export const RUN_ID = /(?:^|[^A-Za-z0-9_-])(r_[0-9a-f]{8})(?![A-Za-z0-9_-])/

// `<factoryUrl>/runs/<runId>` for a reference that names a Factory run, written by a service account (an
// event's key.service, a session's viaService), with a safe Factory address; null otherwise (the reference is
// shown as text). A person may type a run-like id into a reference of their own: that is not a run.
export function factoryRunHref(
  factoryUrl: string | null | undefined,
  ref: string | null | undefined,
  byService: boolean | undefined,
): string | null {
  if (byService !== true || !factoryUrl || !ref || !SAFE_URL.test(factoryUrl)) return null
  const run = RUN_ID.exec(ref)?.[1]
  if (!run) return null
  return `${factoryUrl.replace(/\/+$/, '')}/runs/${run}`
}

// A forget heard live (entry.changed «forgotten») takes the title off the rows already shown for that entry,
// for anyone but a curator, as the server does for what it sends after (pack rule 7, the journal's rule). A
// recovery heard after it gives the title back. A closed session's label is its summary's title: the row
// goes blank when its summary entry is forgotten. Newest first.
export function hideForgotten(events: readonly LiveEvent[], curator: boolean): LiveEvent[] {
  if (curator) return [...events]
  const gone = new Set<string>()
  const back = new Set<string>()
  return events.map((e) => {
    const id = e.target?.id
    if (!id) return e
    if (e.kind === 'entry.changed' && (e.target?.label === 'forgotten' || e.target?.label === 'recovered')) {
      if (!gone.has(id) && !back.has(id)) (e.target?.label === 'forgotten' ? gone : back).add(id)
      return e
    }
    const entry = e.kind === 'session.closed' ? e.summaryEntryId : id
    return entry && gone.has(entry) && e.target ? { ...e, target: { ...e.target, label: null } } : e
  })
}
