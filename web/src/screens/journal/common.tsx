// What the journal screens share: their addresses, the sections of the journal, the brain they are in
// (through the wiki's gate), and small pieces of an entry shown in a list.
import { signal } from '@preact/signals'
import { Fragment } from 'preact'
import { useLocation } from 'preact-iso'
import { byline, sessionLabel } from '../../lib/journal.ts'
import { plainText } from '../../lib/markdown.ts'
import { T } from '../../text.ts'
import type { BrainOne } from '../Brain.tsx'
import { toReviewResource } from './data.ts'

const base = (slug: string) => `/b/${encodeURIComponent(slug)}/journal`
export const sessionsHref = base
// The filters last applied in Sessions, per brain: the way back to Sessions keeps them.
export const sessionsQuery = signal<Record<string, string>>({})
export function sessionsBackHref(slug: string): string {
  const qs = sessionsQuery.value[slug] ?? ''
  return qs ? `${base(slug)}?${qs}` : base(slug)
}
export const sessionHref = (slug: string, id: string) => `${base(slug)}/sessions/${encodeURIComponent(id)}`
export const entryHref = (slug: string, id: string) => `${base(slug)}/entries/${encodeURIComponent(id)}`
export const conflictsHref = (slug: string) => `${base(slug)}/conflicts`
export const toReviewHref = (slug: string) => `${base(slug)}/to-review`
export const forgottenHref = (slug: string) => `${base(slug)}/forgotten`
export function correctHref(slug: string, about: { page?: string; entry?: string } = {}): string {
  const q = new URLSearchParams()
  if (about.page) q.set('page', about.page)
  if (about.entry) q.set('entry', about.entry)
  const qs = q.toString()
  return `${base(slug)}/correct${qs ? `?${qs}` : ''}`
}

const RANK: Record<string, number> = { reader: 1, contributor: 2, curator: 3 }
export const roleAtLeast = (b: BrainOne | undefined, min: string) =>
  (RANK[b?.role ?? ''] ?? 0) >= (RANK[min] ?? 99)
export const writable = (b: BrainOne | undefined) => b?.status !== 'archived'

// The sections of the journal, with the one shown marked; a reader sees no Forgotten (curators only) and
// no «Add a correction» (contributors and more).
// correct: false where the screen offers its own «Add a correction» (an entry: about that entry).
export function JournalNav({ brain, correct = true }: { brain: BrainOne; correct?: boolean }) {
  const { path } = useLocation()
  const j = T.journal
  const s = brain.slug
  // How many wait for review, beside its tab as for conflicts (the list's first page holds its total).
  const toReview = toReviewResource(s).data.value?.total ?? 0
  const items = [
    { href: sessionsHref(s), label: j.sessions, here: path === sessionsHref(s) },
    {
      href: conflictsHref(s),
      label: j.conflicts,
      here: path === conflictsHref(s),
      count: brain.stats?.conflicts ?? 0,
    },
    { href: toReviewHref(s), label: j.toReview, here: path === toReviewHref(s), count: toReview },
    ...(roleAtLeast(brain, 'curator')
      ? [{ href: forgottenHref(s), label: j.forgotten, here: path === forgottenHref(s) }]
      : []),
  ]
  return (
    <div class="journal-bar">
      <nav class="tabs" aria-label={j.nav}>
        {items.map((i) => (
          <a key={i.href} href={i.href} aria-current={i.here ? 'page' : undefined}>
            {i.label}
            {'count' in i && i.count ? (
              <>
                {' '}
                <span class="tag">{i.count}</span>
              </>
            ) : null}
          </a>
        ))}
      </nav>
      {correct && roleAtLeast(brain, 'contributor') && writable(brain) && !path.endsWith('/correct') ? (
        <a class="button secondary" href={correctHref(s)}>
          {j.addCorrection}
        </a>
      ) : null}
    </div>
  )
}

export function TypeTag({ type }: { type: string }) {
  return <span class={`tag${type === 'correction' ? ' warn' : ''}`}>{T.journal.types[type] ?? type}</span>
}

// Its state in words beside it (never colour alone): superseded, expired, pinned, in a conflict.
export function EntryBadges({
  e,
}: {
  e: { supersededBy?: string | null; expiresAt?: string | null; pinned?: boolean; conflict?: boolean }
}) {
  const j = T.journal
  const out: string[] = []
  if (e.supersededBy) out.push(j.supersededTag)
  if (e.expiresAt && e.expiresAt <= new Date().toISOString()) out.push(j.expiredTag)
  if (e.pinned) out.push(j.pinnedTag)
  if (e.conflict) out.push(j.conflictTag)
  return (
    <>
      {out.map((t) => (
        <Fragment key={t}>
          {' '}
          <span class={`tag${t === j.pinnedTag ? '' : ' warn'}`}>{t}</span>
        </Fragment>
      ))}
    </>
  )
}

// The session an entry is in, by its purpose.
export function SessionLink({
  slug,
  s,
}: {
  slug: string
  s: {
    id: string
    purpose: string
    day: string | null
    client?: string | null
    author?: { name: string } | null
  }
}) {
  return <a href={sessionHref(slug, s.id)}>{sessionLabel(s)}</a>
}

// An entry in a line of a list: its type, its title opening it, its state in words, a plain-text start
// of its words (never raw markdown), and who wrote it when.
export function EntryLine({
  slug,
  e,
  snippet = 160,
}: {
  slug: string
  e: {
    id: string
    type: string
    title: string
    content: string
    createdAt: string
    author?: { id: string; name: string }
    onBehalf?: { id: string; name: string } | null
    client?: string | null
    ref?: string | null
    supersededBy?: string | null
    expiresAt?: string | null
    pinned?: boolean
    conflict?: boolean
  }
  snippet?: number
}) {
  const text = plainText(e.content)
  return (
    <>
      <p class="list-title">
        <TypeTag type={e.type} /> <a href={entryHref(slug, e.id)}>{e.title || e.id}</a>
        <EntryBadges e={e} />
      </p>
      {text ? <p class="summary">{text.length > snippet ? `${text.slice(0, snippet)}…` : text}</p> : null}
      <p class="meta">
        {e.author
          ? `${byline({ author: e.author, onBehalf: e.onBehalf ?? null, client: e.client ?? null, ref: e.ref ?? null })} · `
          : null}
        <span class="mono">{T.dateTime(e.createdAt)}</span>
      </p>
    </>
  )
}
