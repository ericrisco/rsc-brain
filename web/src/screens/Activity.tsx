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
  KINDS,
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
import { sessionsResource } from './journal/data.ts'
import { proposalHref } from './proposals/data.ts'
import { useBrain } from './wiki/common.tsx'

const PAGE = 50
const SESSIONS_SHOWN = 20

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

function Sessions({ slug, factoryUrl }: { slug: string; factoryUrl: string | null }) {
  const a = T.activity
  const r = sessionsResource(slug, { status: 'open' })
  useFresh(r)
  const list = r.data.value
  return (
    <section class="act-sessions" aria-labelledby="act-sessions-title">
      <h2 id="act-sessions-title" class="section-title">
        {a.sessionsTitle}
        {list?.total ? <span class="count">{list.total}</span> : null}
      </h2>
      {!list ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={1} />
        )
      ) : list.items.length === 0 ? (
        <div class="quiet-empty">
          <p>{a.noSessions}</p>
          <p class="muted">{a.noSessionsHow}</p>
        </div>
      ) : (
        <>
          <ul class="list compact">
            {list.items.slice(0, SESSIONS_SHOWN).map((s) => (
              <li key={s.id}>
                <p class="list-title">
                  <span class="live-dot" aria-hidden="true" />
                  <a href={sessionHref(slug, s.id)}>{sessionLabel(s)}</a>
                </p>
                <p class="meta wrap">
                  {[clientLabel(s.client), s.author.name, a.opened(ago(s.openedAt) ?? '')]
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
          {list.total > SESSIONS_SHOWN ? (
            <p class="muted small">
              <a href={`${sessionsHref(slug)}?status=open`}>{T.journal.title}</a>
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

// Where an event leads: the entry, the proposal or the page it names.
function hrefOf(slug: string, e: LiveEvent): string | null {
  const id = e.target?.id ?? ''
  if (e.kind.startsWith('entry.') && id.startsWith('ent_')) return entryHref(slug, id)
  if (e.kind.startsWith('proposal.') && id.startsWith('prp_')) return proposalHref(slug, id)
  if (e.kind === 'read' && e.target?.label && isAddress(e.target.label)) return pageHref(slug, e.target.label)
  return null
}

function Line({ slug, e, factoryUrl }: { slug: string; e: LiveEvent; factoryUrl: string | null }) {
  const a = T.activity
  const d = describeEvent(e)
  const href = hrefOf(slug, e)
  return (
    <li data-kind={d.kind}>
      <p class="act-line">
        <strong>{d.who}</strong> {d.client ? <span class="muted">{a.by(d.client)} </span> : null}
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

function Feed({ slug, s, factoryUrl }: { slug: string; s: Stream; factoryUrl: string | null }) {
  const a = T.activity
  const [f, setF] = useState<ActivityFilters>({ client: '', kind: '', ref: '' })
  const [limit, setLimit] = useState(PAGE)
  const all = s.events.value
  const waiting = s.waiting.value.length
  const shown = filterEvents(all, f)
  const nActive = [f.client, f.kind, f.ref].filter(Boolean).length
  const filtered = nActive > 0
  const clients = clientsOf([...s.waiting.value, ...all])
  const state = s.state.value
  const set = (k: keyof ActivityFilters) => (e: Event) => {
    setF({ ...f, [k]: (e.currentTarget as HTMLInputElement | HTMLSelectElement).value })
    setLimit(PAGE)
  }
  return (
    <section class="act-feed" aria-labelledby="act-feed-title">
      <div class="section-head">
        <h2 id="act-feed-title" class="section-title">
          {a.feedTitle}
        </h2>
        <p class={`live-state ${state}`} role="status">
          <span class="dot" aria-hidden="true" />
          {a.state[state] ?? state}
        </p>
        <Button onClick={() => (s.paused.value ? s.resume() : s.pause())}>
          {s.paused.value ? (waiting ? a.resumeWith(waiting) : a.resume) : a.pause}
        </Button>
      </div>
      <Notices s={s} />
      {s.paused.value ? (
        <p class="paused-note muted" role="status">
          {waiting ? a.newWaiting(waiting) : a.pausedNote}
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
      {all.length === 0 && (state === 'connecting' || state === 'reconnecting') && !waiting ? (
        <Skeleton rows={3} />
      ) : all.length === 0 && !waiting ? (
        <Empty title={a.emptyTitle}>
          <p>{a.emptyLead}</p>
        </Empty>
      ) : shown.length === 0 && filtered ? (
        <Empty title={a.filteredEmpty} filtered onClear={() => setF({ client: '', kind: '', ref: '' })} />
      ) : (
        <>
          <ul class="list act-list" aria-label={a.feedTitle}>
            {shown.slice(0, limit).map((e) => (
              <Line key={e.id} slug={slug} e={e} factoryUrl={factoryUrl} />
            ))}
          </ul>
          {shown.length > limit ? (
            <Button onClick={() => setLimit(limit + PAGE)}>
              {a.showMore(Math.min(PAGE, shown.length - limit))}
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
        {s ? <Feed slug={slug} s={s} factoryUrl={factoryUrl} /> : <Skeleton rows={3} />}
      </div>
    </>
  )
}
