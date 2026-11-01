// Activity, live (spec B6 «Activity: en vivo», CA6b, CA8; T037). Who: any member. Job: see what agents and
// people do in this brain now, and which sessions are open. Done when: the person sees the write they wait
// for (in under 2 seconds), or reads the list still with pause. Who sees what follows pack rule 7, decided
// by the server (the stream and its replay); the screen only says the rule. A Factory reference opens its
// run only when the installation has a safe Factory address (CA9, read side).
import { useState } from 'preact/hooks'
import { useFresh } from '../api/fresh.ts'
import {
  type ActivityFilters,
  clientsOf,
  describeEvent,
  factoryRunHref,
  filterEvents,
  groupEvents,
  hideForgotten,
  KINDS,
  waitingLabel,
} from '../lib/activity.ts'
import { ago, clientLabel } from '../lib/brains.ts'
import { sessionLabel } from '../lib/journal.ts'
import { isAddress, pageHref } from '../lib/markdown.ts'
import { KEEP, type LiveEvent, type Stream } from '../live/stream.ts'
import { useStream } from '../live/useStream.ts'
import { me } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Empty, ErrorState, Skeleton } from '../ui/states.tsx'
import { entryHref, sessionHref, sessionsHref } from './journal/common.tsx'
import { type SessionView, sessionsResource } from './journal/data.ts'
import { proposalHref } from './proposals/data.ts'
import { useBrain } from './wiki/common.tsx'

const PAGE = 50
const SESSIONS_SHOWN = 20
// An open session with nothing written for this long is quiet, not active.
export const QUIET_MS = 30 * 60_000
const NO_FILTERS: ActivityFilters = { client: '', kind: '', ref: '' }

// The reference of a session or an event: a link to its Factory run when there is one, else text.
function Ref({ value, factoryUrl }: { value: string; factoryUrl: string | null }) {
  const href = factoryRunHref(factoryUrl, value)
  if (!href) return <span class="mono wrap">{value}</span>
  return (
    <a class="mono wrap" href={href} target="_blank" rel="noopener noreferrer">
      {value}
      <span class="sr-only"> ({T.activity.run})</span>
    </a>
  )
}

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function SessionList({
  slug,
  items,
  factoryUrl,
  quiet,
}: {
  slug: string
  items: SessionView[]
  factoryUrl: string | null
  quiet: boolean
}) {
  const a = T.activity
  return (
    <ul class="list compact">
      {items.slice(0, SESSIONS_SHOWN).map((s) => (
        <li key={s.id}>
          <p class="list-title">
            <span class={quiet ? 'quiet-dot' : 'live-dot'} aria-hidden="true" />
            <a href={sessionHref(slug, s.id)}>{sessionLabel(s)}</a>
          </p>
          <p class="meta wrap">
            {[
              clientLabel(s.client),
              s.author.name,
              quiet ? a.quietSince(hhmm(s.lastActivityAt)) : a.opened(ago(s.openedAt) ?? ''),
            ]
              .filter(Boolean)
              .join(' · ')}
            {s.ref ? (
              <>
                {' · '}
                <Ref value={s.ref} factoryUrl={factoryUrl} />
              </>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  )
}

function Sessions({ slug, factoryUrl }: { slug: string; factoryUrl: string | null }) {
  const a = T.activity
  // Agents' and services' sessions, filtered by the server (so a page and its total count only those);
  // the web's own edits show in the feed, not here.
  const r = sessionsResource(slug, { status: 'open', agents: '1' })
  useFresh(r)
  const list = r.data.value
  const now = Date.now()
  const quiet = (s: SessionView) => now - Date.parse(s.lastActivityAt) > QUIET_MS
  const open = list?.items ?? []
  const active = open.filter((s) => !quiet(s))
  const idle = open.filter(quiet)
  return (
    <div class="act-sessions">
      <section aria-labelledby="act-sessions-title">
        <h2 id="act-sessions-title" class="section-title">
          {a.sessionsTitle}
          {list ? <span class="count">{active.length}</span> : null}
        </h2>
        {!list ? (
          r.error.value ? (
            <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
          ) : (
            <Skeleton rows={1} />
          )
        ) : active.length === 0 ? (
          <div class="quiet-empty">
            <p>{a.noSessions}</p>
            <p class="muted">{a.noSessionsHow}</p>
          </div>
        ) : (
          <SessionList slug={slug} items={active} factoryUrl={factoryUrl} quiet={false} />
        )}
      </section>
      {idle.length ? (
        <section aria-labelledby="act-quiet-title">
          <h2 id="act-quiet-title" class="section-title">
            {a.quietTitle}
            <span class="count">{idle.length}</span>
          </h2>
          <SessionList slug={slug} items={idle} factoryUrl={factoryUrl} quiet />
        </section>
      ) : null}
      {list && list.total > SESSIONS_SHOWN ? (
        <p class="muted small">
          <a href={`${sessionsHref(slug)}?status=open`}>{T.journal.title}</a>
        </p>
      ) : null}
    </div>
  )
}

// Where an event leads: the entry, the proposal or the page it names.
function hrefOf(slug: string, e: LiveEvent): string | null {
  const id = e.target?.id ?? ''
  if (e.kind.startsWith('entry.') && id.startsWith('ent_') && e.target?.label !== 'forgotten')
    return entryHref(slug, id)
  if (e.kind.startsWith('proposal.') && id.startsWith('prp_')) return proposalHref(slug, id)
  if (e.kind === 'read' && e.target?.label && isAddress(e.target.label)) return pageHref(slug, e.target.label)
  return null
}

function Line({
  slug,
  e,
  count,
  factoryUrl,
}: {
  slug: string
  e: LiveEvent
  count: number
  factoryUrl: string | null
}) {
  const a = T.activity
  const d = describeEvent(e)
  const href = hrefOf(slug, e)
  return (
    <li data-kind={d.kind}>
      <p class="act-line">
        <strong>{d.who}</strong> {d.client ? <span class="muted">{a.by(d.client)} </span> : null}
        {d.forWhom ? <span class="muted">{a.forWhom(d.forWhom)} </span> : null}
        {d.did}
        {d.what ? (
          <>
            {' '}
            {href ? (
              <a class="act-what" href={href}>
                {d.what}
              </a>
            ) : (
              <span class="act-what">{d.what}</span>
            )}
          </>
        ) : null}
        {count > 1 ? <span class="tag act-count">{a.times(count)}</span> : null}
      </p>
      <p class="meta wrap">
        <span class="tag act-tag">{a.kinds[d.kind] ?? e.kind}</span>{' '}
        <time dateTime={e.at} title={e.at ? T.dateTime(e.at) : undefined}>
          {ago(e.at) ?? ''}
        </time>
        {e.key?.ref ? (
          <>
            {' · '}
            <Ref value={e.key.ref} factoryUrl={factoryUrl} />
          </>
        ) : null}
        {e.sessionRef && e.sessionRef !== e.key?.ref ? (
          <>
            {' · '}
            <Ref value={e.sessionRef} factoryUrl={factoryUrl} />
          </>
        ) : null}
      </p>
    </li>
  )
}

function Notices({ s }: { s: Stream }) {
  const a = T.activity
  return (
    <>
      {s.state.value === 'reconnecting' ? (
        <div class="alert warn act-notice" role="status">
          <span class="kind">{T.kind.warning}</span>
          <span>{a.reconnecting}</span>
          <span>
            <Button onClick={() => s.retryNow()}>{a.retryNow}</Button>
          </span>
        </div>
      ) : null}
      {s.closed.value ? (
        <div class="alert act-notice" role="alert">
          <span class="kind">{a.closedTitle}</span>
          <span>{s.closed.value}</span>
          <span>
            <Button onClick={() => s.retry()}>{a.reconnect}</Button>
          </span>
        </div>
      ) : null}
      {s.gap.value ? (
        <div class="alert warn act-notice" role="status">
          <span class="kind">{a.gapTitle}</span>
          <span>{s.gap.value}</span>
          <span class="muted">{a.gapLead}</span>
        </div>
      ) : null}
    </>
  )
}

function Feed({
  slug,
  s,
  factoryUrl,
  curator,
}: {
  slug: string
  s: Stream
  factoryUrl: string | null
  curator: boolean
}) {
  const a = T.activity
  const [f, setF] = useState<ActivityFilters>(NO_FILTERS)
  const [limit, setLimit] = useState(PAGE)
  const all = hideForgotten(s.events.value, curator)
  const paused = s.paused.value
  const waiting = waitingLabel(s.waiting.value, f, s.overflow.value)
  const rows = groupEvents(filterEvents(all, f))
  const nActive = [f.client, f.kind, f.ref].filter(Boolean).length
  const filtered = nActive > 0
  const clients = clientsOf([...s.waiting.value, ...all])
  const state = s.state.value
  const set = (k: keyof ActivityFilters) => (e: Event) => {
    setF({ ...f, [k]: (e.currentTarget as HTMLInputElement | HTMLSelectElement).value })
    setLimit(PAGE)
  }
  // The badge says what the list does: paused wins over a live stream (it still listens, the list holds).
  const badge = paused && state === 'live' ? 'paused' : state
  return (
    <section class="act-feed" aria-labelledby="act-feed-title">
      <div class="section-head">
        <h2 id="act-feed-title" class="section-title">
          {a.feedTitle}
        </h2>
        <p class={`live-state ${badge}`} role="status">
          <span class="dot" aria-hidden="true" />
          {a.state[badge] ?? badge}
        </p>
        <Button onClick={() => (paused ? s.resume() : s.pause())}>
          {paused ? (waiting !== '0' ? a.resumeWith(waiting) : a.resume) : a.pause}
        </Button>
      </div>
      <Notices s={s} />
      {paused ? (
        <p class="paused-note muted" role="status">
          {waiting !== '0' ? a.newWaiting(waiting) : a.pausedNote}
        </p>
      ) : null}
      <details class="filter-box act-filters">
        <summary>
          {a.filters}
          {nActive ? <span class="tag">{nActive}</span> : null}
        </summary>
        <search aria-label={a.filters}>
          <form class="filters" onSubmit={(e) => e.preventDefault()}>
            <div class="field">
              <label for="act-client">{a.client}</label>
              <select id="act-client" value={f.client} onChange={set('client')}>
                <option value="">{a.anyClient}</option>
                {[...new Set([...clients, ...(f.client ? [f.client] : [])])].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="act-kind">{a.kind}</label>
              <select id="act-kind" value={f.kind} onChange={set('kind')}>
                <option value="">{a.anyKind}</option>
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {a.kinds[k.id]}
                  </option>
                ))}
              </select>
            </div>
            <div class="field grow">
              <label for="act-ref">{a.ref}</label>
              <input
                id="act-ref"
                type="search"
                value={f.ref}
                autocomplete="off"
                aria-describedby="act-ref-hint"
                onInput={set('ref')}
              />
              <span id="act-ref-hint" class="hint">
                {a.refHint}
              </span>
            </div>
          </form>
        </search>
      </details>
      {all.length === 0 && (state === 'connecting' || state === 'reconnecting') && waiting === '0' ? (
        <Skeleton rows={3} />
      ) : all.length === 0 && waiting === '0' ? (
        <Empty title={a.emptyTitle}>
          <p>{a.emptyLead}</p>
        </Empty>
      ) : rows.length === 0 && filtered ? (
        <Empty title={a.filteredEmpty} filtered onClear={() => setF(NO_FILTERS)} />
      ) : (
        <>
          <ul class="list act-list" aria-label={a.feedTitle}>
            {rows.slice(0, limit).map((r) => (
              <Line key={r.e.id} slug={slug} e={r.e} count={r.count} factoryUrl={factoryUrl} />
            ))}
          </ul>
          {rows.length > limit ? (
            <Button onClick={() => setLimit(limit + PAGE)}>
              {a.showMore(Math.min(PAGE, rows.length - limit))}
            </Button>
          ) : all.length >= KEEP ? (
            <p class="muted small">{a.tooMuch(KEEP)}</p>
          ) : null}
        </>
      )}
    </section>
  )
}

export function Activity({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const s = useStream(brain ? slug : null)
  if (!brain) return gate
  const a = T.activity
  const factoryUrl = me().data.value?.installation.factoryUrl ?? null
  return (
    <>
      <div class="title-row start">
        <h1 class="title">{a.title}</h1>
      </div>
      <p class="lead screen-lead">
        {a.lead} {brain.role === 'curator' ? a.leadCurator : a.leadRule}
      </p>
      <div class="activity">
        <Sessions slug={slug} factoryUrl={factoryUrl} />
        {s ? (
          <Feed slug={slug} s={s} factoryUrl={factoryUrl} curator={brain.role === 'curator'} />
        ) : (
          <Skeleton rows={3} />
        )}
      </div>
    </>
  )
}
