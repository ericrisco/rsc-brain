// The sessions of a brain's journal (spec B6 «Journal › Sessions», plan G12; T023). Who: any member.
// Job: find what was written, by whom and with what, and open it. Done when: the person opened the
// session or the entry they were after. Newest first, by pages of 50; filters by status, client, author,
// entry type, external reference, dates and «not in the wiki yet» are kept in the address (they survive a
// reload) and applied together with one button. Clients and authors are picked from what the brain
// holds, never typed as ids. New sessions arrive from the live feed of the brain without reloading.

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { useOnChange } from '../../lib/follow.ts'
import {
  byline,
  mergeById,
  SESSION_FILTERS,
  type SessionFilters,
  sessionLabel,
  sessionQuery,
} from '../../lib/journal.ts'
import { plainText } from '../../lib/markdown.ts'
import { useLive } from '../../live/follow.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { useBrain, useFilters, WikiHead } from '../wiki/common.tsx'
import { JournalNav, sessionHref, sessionsQuery } from './common.tsx'
import { type SessionList, type SessionView, sessionsResource } from './data.ts'

const STATUSES = ['open', 'closed', 'closed_no_summary'] as const
const TYPES = [
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

function Filters({
  values,
  facets,
  onApply,
  onClear,
  active,
}: {
  values: SessionFilters
  facets: SessionList['facets'] | undefined
  onApply: (v: SessionFilters) => void
  onClear: () => void
  active: number
}) {
  const j = T.journal
  const [v, setV] = useState<SessionFilters>(values)
  // The address changed (Back, Clear): the form shows it.
  useOnChange(JSON.stringify(values), () => setV(values))
  const set = (k: keyof SessionFilters) => (e: Event) =>
    setV({ ...v, [k]: (e.currentTarget as HTMLInputElement | HTMLSelectElement).value })
  const pick = (k: keyof SessionFilters, label: string, any: string, options: Array<[string, string]>) => (
    <div class="field">
      <label for={`sf-${k}`}>{label}</label>
      <select id={`sf-${k}`} value={v[k] ?? ''} onChange={set(k)}>
        <option value="">{any}</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  )
  return (
    <details class="filter-box" open={active > 0 || undefined}>
      <summary>
        {j.filters}
        {active ? <span class="tag">{active}</span> : null}
      </summary>
      <search aria-label={j.filters}>
        <form
          class="filters"
          onSubmit={(e) => {
            e.preventDefault()
            onApply(v)
          }}
        >
          {pick(
            'status',
            j.status,
            j.anyStatus,
            STATUSES.map((s) => [s, j.statuses[s] ?? s]),
          )}
          {pick(
            'client',
            j.client,
            j.anyClient,
            (facets?.clients ?? (v.client ? [v.client] : [])).map((c) => [c, c]),
          )}
          {pick(
            'author',
            j.author,
            j.anyAuthor,
            (facets?.authors ?? []).map((a) => [a.id, a.name]),
          )}
          {pick(
            'type',
            j.type,
            j.anyType,
            TYPES.map((t) => [t, j.types[t] ?? t]),
          )}
          <div class="field grow">
            <label for="sf-ref">{j.ref}</label>
            <input
              id="sf-ref"
              type="search"
              class="mono"
              value={v.ref ?? ''}
              aria-describedby="sf-ref-hint"
              onInput={set('ref')}
            />
            <span id="sf-ref-hint" class="hint">
              {j.refHint}
            </span>
          </div>
          <div class="field">
            <label for="sf-from">{j.from}</label>
            <input id="sf-from" type="date" value={v.from ?? ''} onInput={set('from')} />
          </div>
          <div class="field">
            <label for="sf-to">{j.to}</label>
            <input id="sf-to" type="date" value={v.to ?? ''} onInput={set('to')} />
          </div>
          <label class="check-line">
            <input
              type="checkbox"
              checked={v.uncompiled === '1'}
              onChange={(e) =>
                setV({ ...v, uncompiled: (e.currentTarget as HTMLInputElement).checked ? '1' : '' })
              }
            />
            <span>{j.uncompiled}</span>
          </label>
          <p class="actions">
            <Button type="submit" kind="primary">
              {j.apply}
            </Button>
            {active ? (
              <Button kind="quiet" onClick={onClear}>
                {j.clear}
              </Button>
            ) : null}
          </p>
        </form>
      </search>
    </details>
  )
}

function SessionItem({ slug, s }: { slug: string; s: SessionView }) {
  const j = T.journal
  const summary = s.summary ? plainText(s.summary) : null
  return (
    <li>
      <p class="list-title">
        <a href={sessionHref(slug, s.id)}>{sessionLabel(s)}</a>{' '}
        <span class={`tag${s.status === 'open' ? ' live' : ''}`}>{j.statuses[s.status] ?? s.status}</span>
      </p>
      <p class="meta">
        {byline({ author: s.author, onBehalf: null, client: s.client, ref: null })} · {j.entriesIn(s.entries)}{' '}
        · <span class="mono">{T.dateTime(s.openedAt)}</span>
        {s.ref ? (
          <>
            {' '}
            · <span class="mono">{s.ref}</span>
          </>
        ) : null}
      </p>
      {summary ? (
        <p class="summary">{summary}</p>
      ) : (
        <p class="muted small">{s.status === 'open' ? j.stillOpen : j.noSummary}</p>
      )}
    </li>
  )
}

export function JournalSessions({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const f = useFilters(SESSION_FILTERS)
  const query = sessionQuery(f.values)
  const r = sessionsResource(slug, query)
  useFresh(r)
  const first = r.data.value
  // Later pages, until the first page is read again (a filter, or the live feed): what follows it moved,
  // so the list starts again from the fresh first page, as Conflicts, Forgotten and To review do.
  const [more, setMore] = useState<SessionView[]>([])
  const [next, setNext] = useState<string | null | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<ApiError | null>(null)
  // Which first page later pages belong to: a page asked for an older one is dropped.
  const asked = useRef(0)
  const qs = JSON.stringify(query)
  useEffect(() => {
    asked.current += 1
    setMore([])
    setNext(undefined)
    setMoreError(null)
  }, [qs, first])
  // The way back from a session or an entry keeps these filters.
  useEffect(() => {
    sessionsQuery.value = { ...sessionsQuery.value, [slug]: new URLSearchParams(query).toString() }
  }, [slug, qs])
  useLive(brain && first ? slug : null, first?.liveFrom)
  if (!brain) return gate
  const j = T.journal
  const active = Object.keys(query).length
  const items = first ? mergeById(first.items, more) : []
  const nextPage = next === undefined ? first?.next : next
  const loadMore = async () => {
    if (!nextPage) return
    const mine = asked.current
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.call<SessionList>('sessions', {
        path: { slug },
        query: { ...query, cursor: nextPage, limit: 50 },
      })
      if (asked.current !== mine) return
      setMore((m) => [...m, ...page.items])
      setNext(page.next)
    } catch (e) {
      if (asked.current === mine) setMoreError(e as ApiError)
    } finally {
      setLoadingMore(false)
    }
  }
  return (
    <>
      <WikiHead title={j.sessions} lead={j.sessionsLead}>
        {first ? <span class="tag">{j.sessionsCount(first.total)}</span> : null}
      </WikiHead>
      <JournalNav brain={brain} />
      <Filters
        values={f.values}
        facets={first?.facets}
        active={active}
        onApply={(v) => f.set(Object.fromEntries(SESSION_FILTERS.map((k) => [k, (v[k] ?? '').trim()])))}
        onClear={f.clear}
      />
      {!first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )
      ) : items.length === 0 ? (
        active ? (
          <Empty title={j.noSessionsTitle} filtered onClear={f.clear} />
        ) : (
          <Empty title={j.noSessionsTitle}>
            <p>{j.noSessionsLead}</p>
            <p class="actions">
              <a class="button" href={`/b/${encodeURIComponent(slug)}`}>
                {j.toOverview}
              </a>
            </p>
          </Empty>
        )
      ) : (
        <>
          {r.error.value ? (
            <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
          ) : null}
          <ul class="list sessions" aria-label={j.sessionsList}>
            {items.map((s) => (
              <SessionItem key={s.id} slug={slug} s={s} />
            ))}
          </ul>
          {moreError ? <ErrorState error={moreError} onRetry={() => void loadMore()} focus={false} /> : null}
          {nextPage ? (
            <p class="actions">
              <Button
                pending={loadingMore}
                pendingLabel={j.loadingMore}
                blocked={online.value ? null : j.moreOffline}
                onClick={() => void loadMore()}
              >
                {j.more}
              </Button>
            </p>
          ) : null}
        </>
      )}
    </>
  )
}
