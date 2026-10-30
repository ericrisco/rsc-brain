// One session of the journal (spec B6 «Journal › Sessions», B1 «Sesiones»; T023). Who: any member. Job:
// read what one agent or person did in one stretch of work, in order. Done when: the person read its
// summary and opened the entry they wanted. Its entries come by pages of 20, in the order they were written,
// each with its state in words; the entries forgotten since are counted, so the number never drops
// unexplained (curators open them in Forgotten).
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { resource } from '../../api/resource.ts'
import { byline, mergeById, sessionLabel } from '../../lib/journal.ts'
import { plainText } from '../../lib/markdown.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { useBrain } from '../wiki/common.tsx'
import {
  EntryLine,
  entryHref,
  forgottenHref,
  JournalNav,
  roleAtLeast,
  sessionsBackHref,
  sessionsHref,
} from './common.tsx'
import { type EntryListed, type Listing, sessionResource } from './data.ts'

const PAGE = 20

const entriesResource = (slug: string, id: string) =>
  resource(`brain:${slug}:journal:session-entries:${id}`, () =>
    api.call<Listing<EntryListed>>('entries', { path: { slug }, query: { session: id, limit: PAGE } }),
  )

export function JournalSession({ slug, id }: { slug: string; id: string }) {
  const { brain, gate } = useBrain(slug)
  const r = sessionResource(slug, id)
  const es = entriesResource(slug, id)
  useFresh(r)
  useFresh(es)
  const [more, setMore] = useState<EntryListed[]>([])
  const [next, setNext] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [moreError, setMoreError] = useState<ApiError | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  if (!brain) return gate
  const j = T.journal
  const s = r.data.value?.session
  if (!s) {
    if (r.error.value?.code === 'not_found')
      return (
        <>
          <h1 class="title">{j.noSession}</h1>
          <p class="actions">
            <a class="button" href={sessionsHref(slug)}>
              {j.backToSessions}
            </a>
          </p>
        </>
      )
    return r.error.value ? (
      <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
    ) : (
      <Skeleton rows={4} />
    )
  }
  const first = es.data.value
  const items = first ? mergeById(first.items, more) : []
  const nextPage = next === undefined ? first?.next : next
  const loadMore = async () => {
    if (!nextPage) return
    setLoading(true)
    setMoreError(null)
    try {
      const page = await api.call<Listing<EntryListed>>('entries', {
        path: { slug },
        query: { session: id, cursor: nextPage, limit: PAGE },
      })
      if (!mounted.current) return
      setMore((m) => [...m, ...page.items])
      setNext(page.next)
    } catch (e) {
      if (mounted.current) setMoreError(e as ApiError)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }
  return (
    <>
      <nav class="crumbs" aria-label={j.title}>
        <a href={sessionsBackHref(slug)}>{j.sessionCrumb}</a>
      </nav>
      <div class="title-row start">
        <h1 class="title">{sessionLabel(s)}</h1>
        {/* Open or closed; whether it closed with a summary is said once, under Summary. */}
        <span class={`tag${s.status === 'open' ? ' live' : ''}`}>
          {s.status === 'open' ? j.statuses.open : j.statuses.closed}
        </span>
      </div>
      <JournalNav brain={brain} />
      <section aria-labelledby="session-facts">
        <h2 id="session-facts" class="sr-only">
          {j.sessionFacts}
        </h2>
        <dl class="facts">
          <dt>{j.wroteBy}</dt>
          <dd>{byline({ author: s.author, onBehalf: null, client: s.client, ref: null })}</dd>
          <dt>{j.openedTerm}</dt>
          <dd class="mono">{T.dateTime(s.openedAt)}</dd>
          {s.ref ? (
            <>
              <dt>{j.ref}</dt>
              <dd class="mono">{s.ref}</dd>
            </>
          ) : null}
          <dt>{j.entriesTitle}</dt>
          <dd>
            {j.entriesIn(s.entries)}
            {s.forgotten ? <span class="meta"> · {j.forgottenIn(s.forgotten)}</span> : null}
          </dd>
        </dl>
      </section>
      <section class="session-part" aria-labelledby="session-summary">
        <h2 id="session-summary" class="section-title">
          {j.summaryTitle}
        </h2>
        {s.summary ? (
          <>
            <p class="summary-text">{plainText(s.summary)}</p>
            {s.summaryEntryId ? (
              <p>
                <a href={entryHref(slug, s.summaryEntryId)}>{j.readSummary}</a>
              </p>
            ) : null}
          </>
        ) : (
          <p class="muted">{s.status === 'open' ? j.stillOpen : j.noSummary}</p>
        )}
      </section>
      <section class="session-part" aria-labelledby="session-entries">
        <h2 id="session-entries" class="section-title">
          {j.entriesTitle}
        </h2>
        {s.forgotten ? (
          <p class="meta" data-state="forgotten-count">
            {roleAtLeast(brain, 'curator') ? (
              <a href={forgottenHref(slug)}>{j.forgottenSee(s.forgotten)}</a>
            ) : (
              `${j.forgottenIn(s.forgotten)} (${j.forgottenCuratorsOnly})`
            )}
          </p>
        ) : null}
        {!first ? (
          es.error.value ? (
            <ErrorState error={es.error.value} onRetry={() => void es.reload()} focus={false} />
          ) : (
            <Skeleton rows={3} />
          )
        ) : items.length === 0 ? (
          <Empty title={j.noEntriesTitle}>
            <p>{j.noEntriesLead}</p>
          </Empty>
        ) : (
          <>
            <ol class="list">
              {items.map((e) => (
                <li key={e.id}>
                  <EntryLine slug={slug} e={e} />
                </li>
              ))}
            </ol>
            {moreError ? (
              <ErrorState error={moreError} onRetry={() => void loadMore()} focus={false} />
            ) : null}
            {nextPage ? (
              <p class="actions">
                <Button
                  pending={loading}
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
      </section>
    </>
  )
}
