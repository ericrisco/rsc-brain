// The overview of a brain (spec B6 «Overview», CA19; T015). Who: any member. Job: see what the brain
// holds and what happens in it today, and know what to do next. Done when: the person knows (numbers,
// today's sessions, what waits, health), or, for a new brain, has the next step in hand. The first steps
// mark themselves from the live feed of the brain, without reloading. A brain the person cannot read
// answers like one that does not exist, and says who to ask (constitution Brain P4, general P6).
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { useFresh } from '../api/fresh.ts'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { clientLabel, todayCapped } from '../lib/brains.ts'
import { sessionLabel } from '../lib/journal.ts'
import { useLive } from '../live/follow.ts'
import { online } from '../session.ts'
import { connectHref } from '../shell/dialogs.ts'
import { T } from '../text.ts'
import { CopyButton } from '../ui/CopyButton.tsx'
import { viewState } from '../ui/state.ts'
import { ErrorState, Skeleton } from '../ui/states.tsx'
import type { BrainRow, Stats } from './Home.tsx'
import { conflictsHref, sessionHref, sessionsHref } from './journal/common.tsx'
import { inboxHref, proposalHref } from './proposals/data.ts'

export type BrainOne = BrainRow & { description: string }

type Session = {
  id: string
  who: string
  client: string | null
  purpose: string
  // The day of the session a key gets by writing without opening one; null for one opened with a purpose.
  day: string | null
  ref: string | null
  status: string
  entries: number
  summary: string | null
}
type Pending = { id: string; title: string; agent: string | null; opCount: number; old: boolean }
type Overview = {
  // The id of the newest event this overview already shows: the live feed starts there.
  cursor: string
  stats: Stats
  todaySessions: Session[]
  pending: Pending[]
  health: Record<string, number>
  firstSteps: { agentConnected: boolean; firstEntry: boolean; imported: boolean; importable: boolean }
}

export const brainResource = (slug: string) =>
  resource<{ brain: BrainOne }>(`brain:${slug}:basic`, () =>
    api.call<{ brain: BrainOne }>('brain', { path: { slug } }),
  )

export const overviewResource = (slug: string) =>
  resource<Overview>(`brain:${slug}:overview`, () => api.call<Overview>('overview', { path: { slug } }))

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number
  done: boolean
  title: string
  children: ComponentChildren
}) {
  const word = done ? T.overview.done : T.overview.todo
  return (
    <li class={done ? 'done' : undefined}>
      <div class="step-head">
        <span class={`status ${done ? 'ok' : ''}`} aria-hidden="true">
          {done ? '✓' : ''}
        </span>
        <h3>
          <span class="n">{n}.</span> {title}
        </h3>
        <span class="tag">{word}</span>
      </div>
      {children}
    </li>
  )
}

function FirstSteps({
  slug,
  steps,
  curator,
}: {
  slug: string
  steps: Overview['firstSteps']
  curator: boolean
}) {
  const o = T.overview
  // An import goes only into an empty brain: once it has anything, the step can no longer be taken.
  const closed = !steps.imported && !steps.importable
  return (
    <section class="first-steps" aria-labelledby="steps-title">
      <h2 id="steps-title">{o.stepsTitle}</h2>
      <p class="muted">{o.stepsLead}</p>
      <ol>
        <Step n={1} done={steps.agentConnected} title={o.step1}>
          <p>{o.step1Lead}</p>
          <a class={`button ${steps.agentConnected ? 'secondary' : 'primary'}`} href={connectHref(slug)}>
            {T.connect.open}
          </a>
        </Step>
        <Step n={2} done={steps.firstEntry} title={o.step2}>
          <p>{o.step2Lead}</p>
          <blockquote class="ask">{o.step2Ask(slug)}</blockquote>
          <CopyButton text={o.step2Ask(slug)} label={o.copyAsk} />
        </Step>
        <Step n={3} done={steps.imported} title={o.step3}>
          {steps.imported ? (
            <p>{o.step3Done}</p>
          ) : closed ? (
            <p class="muted">{o.step3Closed}</p>
          ) : curator ? (
            <>
              <p>{o.step3Lead}</p>
              <a class="button secondary" href={`/b/${encodeURIComponent(slug)}/settings/import`}>
                {o.step3Go}
              </a>
            </>
          ) : (
            <p>{o.step3Ask}</p>
          )}
        </Step>
      </ol>
    </section>
  )
}

// Each number that names work to do leads to it: what is not in the wiki yet to the sessions that hold
// it, the conflicts to Conflicts, what waits for review to the proposals inbox.
function Numbers({ slug, stats }: { slug: string; stats: Stats }) {
  const o = T.overview
  const items: Array<readonly [string, string, string?]> = [
    o.pages(stats.pages),
    o.entries(stats.entries),
    [...o.uncompiled(stats.uncompiled), `${sessionsHref(slug)}?uncompiled=1`],
    [...o.conflicts(stats.conflicts), conflictsHref(slug)],
    [...o.pending(stats.pendingProposals), inboxHref(slug)],
  ]
  return (
    <section aria-labelledby="numbers-title">
      <h2 id="numbers-title" class="section-title">
        {o.numbers}
      </h2>
      <ul class="numbers">
        {items.map(([n, label, href]) => (
          <li key={label}>
            {href ? (
              <a href={href}>
                <strong>{n}</strong> {label}
              </a>
            ) : (
              <>
                <strong>{n}</strong> {label}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Today({ slug, sessions }: { slug: string; sessions: Session[] }) {
  const o = T.overview
  return (
    <section aria-labelledby="today-title">
      <h2 id="today-title" class="section-title">
        {o.today}
      </h2>
      {sessions.length === 0 ? (
        <div class="quiet-empty">
          <p>{o.noToday}</p>
          <p class="muted">{o.noTodayHow}</p>
        </div>
      ) : (
        <ul class="list">
          {sessions.map((s) => (
            <li key={s.id}>
              <p class="list-title">
                <a href={sessionHref(slug, s.id)}>{sessionLabel(s)}</a>
              </p>
              <p class="meta">
                {[clientLabel(s.client), s.who, o.entriesIn(s.entries)].filter(Boolean).join(' · ')}
                {' · '}
                <span class={s.status === 'open' ? 'live' : undefined}>{o.status[s.status] ?? s.status}</span>
                {s.ref ? (
                  <>
                    {' · '}
                    <span class="mono">{s.ref}</span>
                  </>
                ) : null}
              </p>
              {s.summary ? (
                <p class="summary">{s.summary}</p>
              ) : (
                <p class="muted">{s.status === 'open' ? o.stillOpen : o.noSummary}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {todayCapped(sessions.length) ? (
        <p class="meta">
          {o.todayCapped(sessions.length)}{' '}
          <a href={`/b/${encodeURIComponent(slug)}/journal`}>{o.allSessions}</a>
        </p>
      ) : null}
    </section>
  )
}

function Waiting({ slug, pending, total }: { slug: string; pending: Pending[]; total: number }) {
  const o = T.overview
  return (
    <section aria-labelledby="waiting-title">
      <div class="section-head">
        <h2 id="waiting-title" class="section-title">
          {o.waitingTitle}
        </h2>
        {total ? <span class="count">{total}</span> : null}
      </div>
      {pending.length === 0 ? (
        <p class="quiet-empty">{o.noneWaiting}</p>
      ) : (
        <>
          <ul class="list">
            {pending.map((p) => (
              <li key={p.id}>
                <p class="list-title">
                  <a href={proposalHref(slug, p.id)}>{p.title}</a>{' '}
                  {p.old ? <span class="tag warn">{o.old}</span> : null}
                </p>
                <p class="meta">
                  {[o.ops(p.opCount), p.agent ? o.by(p.agent) : null].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
          <p class="muted small">
            {o.decideLater} <a href={inboxHref(slug)}>{o.allProposals}</a>
          </p>
        </>
      )}
    </section>
  )
}

const HEALTH_ORDER = [
  'broken',
  'conflicts',
  'orphans',
  'stale',
  'unavailableSources',
  'long',
  'similarTitles',
]

function Health({ health }: { health: Record<string, number> }) {
  const o = T.overview
  const found = HEALTH_ORDER.filter((k) => (health[k] ?? 0) > 0)
  return (
    <section aria-labelledby="health-title">
      <h2 id="health-title" class="section-title">
        {o.healthTitle}
      </h2>
      {found.length === 0 ? (
        <p class="quiet-empty">{o.healthy}</p>
      ) : (
        <ul class="list compact">
          {found.map((k) => (
            <li key={k}>{o.health[k]?.(health[k] ?? 0)}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Step 1 also counts an agent asking for context, and that call sends no event: while the step waits and
// the tab is visible, the overview is asked again every few seconds. It stops once the step is done, when
// the tab is hidden (shown again, the live feed asks anyway) and when the screen goes.
export const STEP1_EVERY = 5_000

function useWaitForAgent(ov: { reload(): Promise<unknown> }, waiting: boolean, every = STEP1_EVERY): void {
  useEffect(() => {
    if (!waiting) return
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const start = () => {
      if (timer || document.hidden) return
      timer = setInterval(() => void ov.reload(), every)
    }
    const seen = () => (document.hidden ? stop() : start())
    start()
    document.addEventListener('visibilitychange', seen)
    return () => {
      document.removeEventListener('visibilitychange', seen)
      stop()
    }
  }, [ov, waiting, every])
}

export function Brain({ slug }: { slug: string }) {
  const r = brainResource(slug)
  const ov = overviewResource(slug)
  const b = r.data.value?.brain
  // A brain opened again shows its last overview at once and asks for a fresh one (it may have changed
  // while the person was away); the live feed starts only once an overview says from where.
  useFresh(ov)
  const cursor = ov.data.value?.cursor
  useLive(
    b && cursor !== undefined ? slug : null,
    cursor,
    ov.data.value ? !ov.data.value.firstSteps.agentConnected : false,
  )
  useWaitForAgent(ov, ov.data.value ? !ov.data.value.firstSteps.agentConnected : false)
  // A new brain shows its first steps; once shown they stay for this visit, so a step that marks itself
  // is seen being marked (CA19), and go once the brain works.
  const stepsShown = useRef<string | null>(null)
  const state = viewState({
    loading: r.loading.value,
    data: r.data.value,
    error: r.error.value,
    online: online.value,
  })
  if (state === 'loading') return <Skeleton rows={3} />
  if (!b) return r.error.value ? <ErrorState error={r.error.value} onRetry={() => void r.reload()} /> : null
  const o = ov.data.value
  if (o && !(o.firstSteps.agentConnected && o.firstSteps.firstEntry)) stepsShown.current = slug
  const fresh = o !== undefined && stepsShown.current === slug
  return (
    <>
      <div class="title-row start">
        <h1 class="title">{b.name}</h1>
        <span class="tag">{b.role}</span>
        {b.status === 'archived' ? <span class="tag">{T.home.archived}</span> : null}
      </div>
      <p class="lead purpose">{b.purpose || <span class="muted">{T.brain.noPurpose}</span>}</p>
      {!o ? (
        ov.error.value ? (
          <ErrorState error={ov.error.value} onRetry={() => void ov.reload()} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : (
        <div class="overview">
          {fresh ? <FirstSteps slug={b.slug} steps={o.firstSteps} curator={b.role === 'curator'} /> : null}
          <Numbers slug={slug} stats={o.stats} />
          <div class="overview-grid">
            <Today slug={slug} sessions={o.todaySessions} />
            <div class="overview-side">
              <Waiting slug={slug} pending={o.pending} total={o.stats.pendingProposals} />
              <Health health={o.health} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
