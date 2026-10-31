// The lists of the journal that ask for a decision (spec B6 «Journal», B1; T024). Conflicts: two entries
// side by side, each with who wrote it and its session, and «Keep this one» on each side, or «Not related»
// — with a confirmation that says the one replaced leaves the agents' context (CA11). Only what the server
// allows is offered: superseding an entry, or dismissing a correction, is for its author or a curator. Forgotten (curators): who forgot each entry and
// why, and «Recover». To review: entries past their review date, and «Mark reviewed». Each comes by pages.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { byline, conflictActions, entryPowers } from '../../lib/journal.ts'
import { plainText } from '../../lib/markdown.ts'
import { me, online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Empty, ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { TextArea } from '../../ui/TextArea.tsx'
import type { BrainOne } from '../Brain.tsx'
import { blockedNow, Said, useBrain, WikiHead } from '../wiki/common.tsx'
import {
  EntryBadges,
  EntryLine,
  entryHref,
  JournalNav,
  roleAtLeast,
  SessionLink,
  TypeTag,
  writable,
} from './common.tsx'
import {
  type Conflict,
  conflictsResource,
  curatorNames,
  type EntryRead,
  forgottenResource,
  journalChanged,
  type Listing,
  membersResource,
  toReviewResource,
} from './data.ts'

// The first page from a shared resource (it reloads with the journal); later pages kept here.
function usePages<T>(
  first: { items: T[]; next: string | null; total: number } | undefined,
  more: (next: string) => Promise<{ items: T[]; next: string | null }>,
  idOf: (x: T) => string,
) {
  const [extra, setExtra] = useState<T[]>([])
  const [next, setNext] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  // A fresh first page starts the list again (something was decided: what follows moved).
  useEffect(() => {
    setExtra([])
    setNext(undefined)
  }, [first])
  const seen = new Set((first?.items ?? []).map(idOf))
  const items = first ? [...first.items, ...extra.filter((x) => !seen.has(idOf(x)))] : []
  const nextPage = next === undefined ? first?.next : next
  const load = async () => {
    if (!nextPage) return
    setLoading(true)
    setError(null)
    try {
      const p = await more(nextPage)
      if (!alive.current) return
      setExtra((x) => [...x, ...p.items])
      setNext(p.next)
    } catch (e) {
      if (alive.current) setError(e as ApiError)
    } finally {
      if (alive.current) setLoading(false)
    }
  }
  return { first, items, nextPage, loading, error, load }
}

function More({
  p,
}: {
  p: {
    nextPage: string | null | undefined
    loading: boolean
    error: ApiError | null
    load: () => Promise<void>
  }
}) {
  const j = T.journal
  return (
    <>
      {p.error ? <ErrorState error={p.error} onRetry={() => void p.load()} focus={false} /> : null}
      {p.nextPage ? (
        <p class="actions">
          <Button
            pending={p.loading}
            pendingLabel={j.loadingMore}
            blocked={online.value ? null : j.moreOffline}
            onClick={() => void p.load()}
          >
            {j.more}
          </Button>
        </p>
      ) : null}
    </>
  )
}

// After an item leaves its list, the keyboard goes to the heading, not to a button that is gone.
function focusHeading() {
  const h = document.querySelector<HTMLElement>('main h1')
  if (!h) return
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
  h.focus()
}

const short = (t: string) => (t.length > 48 ? `${t.slice(0, 47)}…` : t)

type Decision = { conflict: Conflict; from: string; to: string; kind: 'supersedes' | 'not_related' }

function DecideDialog({
  slug,
  d,
  onClose,
  onDone,
}: {
  slug: string
  d: Decision | null
  onClose: () => void
  onDone: () => void
}) {
  const j = T.journal
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => {
    setReason('')
    setError(null)
  }, [d])
  const title = (id: string) => {
    const c = d?.conflict
    return c ? (c.from.id === id ? c.from.title : c.to.title) : ''
  }
  return (
    <Dialog open={d !== null} title={j.decideTitle} onClose={onClose} closeLabel={j.cancel}>
      {d ? (
        <form
          class="form"
          onSubmit={async (e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            try {
              await api.call('relate', {
                path: { slug },
                body: {
                  from: d.from,
                  to: d.to,
                  kind: d.kind,
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                },
              })
              onDone()
            } catch (x) {
              setError(x as ApiError)
            } finally {
              setPending(false)
            }
          }}
        >
          <p>
            {d.kind === 'supersedes'
              ? j.decideSupersede(short(title(d.from)), short(title(d.to)))
              : j.decideNotRelated}
          </p>
          <TextArea
            autoFocus
            label={j.relationReason}
            rows={2}
            maxLength={500}
            value={reason}
            onValue={setReason}
          />
          <FormAlert error={error} />
          <p class="actions">
            <Button
              type="submit"
              kind="primary"
              pending={pending}
              pendingLabel={j.deciding}
              blocked={blockedNow(pending)}
            >
              {j.decideConfirm}
            </Button>
            <Button kind="quiet" onClick={onClose}>
              {j.cancel}
            </Button>
          </p>
        </form>
      ) : null}
    </Dialog>
  )
}

// One side of a conflict: what it says, who wrote it with what, in which session, and «Keep this one»
// when the person may keep it (the other one is then superseded).
function Side({
  slug,
  label,
  e,
  onKeep,
}: {
  slug: string
  label: string
  e: Conflict['from']
  onKeep: (() => void) | null
}) {
  const j = T.journal
  const text = plainText(e.content)
  return (
    <div class="side">
      <p class="meta">{label}</p>
      <p class="list-title">
        <TypeTag type={e.type} /> <a href={entryHref(slug, e.id)}>{e.title || e.id}</a>
        <EntryBadges e={e} />
      </p>
      <p class="summary">{text.length > 220 ? `${text.slice(0, 219)}…` : text}</p>
      <p class="meta">
        {byline(e)} · <span class="mono">{T.dateTime(e.createdAt)}</span>
      </p>
      <p class="meta">
        {j.inSession} <SessionLink slug={slug} s={e.session} />
      </p>
      {onKeep ? (
        <p class="actions">
          <Button blocked={blockedNow(false)} aria-label={`${j.keepThis}: ${e.title}`} onClick={onKeep}>
            {j.keepThis}
          </Button>
        </p>
      ) : null}
    </div>
  )
}

function asked(c: Conflict): string {
  const a = `“${short(c.from.title)}”`
  const b = `“${short(c.to.title)}”`
  return c.relation.kind === 'supersedes' ? `${a} replaces ${b}` : `${a} and ${b} are not related`
}

export function JournalConflicts({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const r = conflictsResource(slug)
  useFresh(r)
  membersResource(slug)
  const [decide, setDecide] = useState<Decision | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const d = r.data.value
  const firstPage = useMemo(() => (d ? { items: d.conflicts, next: d.next, total: d.total } : undefined), [d])
  const p = usePages<Conflict>(
    firstPage,
    (next) =>
      api
        .call<{ conflicts: Conflict[]; next: string | null }>('conflicts', {
          path: { slug },
          query: { limit: 10, offset: next },
        })
        .then((x) => ({ items: x.conflicts, next: x.next })),
    (c) => c.relation.id,
  )
  if (!brain) return gate
  const j = T.journal
  const may = roleAtLeast(brain, 'contributor') && writable(brain)
  const who = { role: brain.role, me: me().data.value?.account.id ?? '', archived: !writable(brain) }
  return (
    <>
      <WikiHead title={j.conflicts} lead={j.conflictsLead}>
        {p.first ? <span class="tag">{j.conflictsCount(p.first.total)}</span> : null}
      </WikiHead>
      <JournalNav brain={brain} />
      <Said text={said} />
      {!may ? (
        <p class="muted small" data-state="read-only">
          {writable(brain) ? j.readOnlyConflicts(brain.name, curatorNames(slug)) : j.archived}
        </p>
      ) : null}
      {!p.first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )
      ) : p.items.length === 0 ? (
        <Empty title={j.noConflictsTitle}>
          <p>{j.noConflictsLead}</p>
        </Empty>
      ) : (
        <>
          <ul class="list conflicts">
            {p.items.map((c) => {
              const can = may
                ? conflictActions(c, who)
                : { keepFrom: false, keepTo: false, notRelated: false }
              const none = may && !can.keepFrom && !can.keepTo && !can.notRelated
              return (
                <li key={c.relation.id} class="conflict-item">
                  <h2 class="conflict-head">
                    {c.why === 'waiting for a person' ? j.waitingPerson(asked(c)) : j.contradiction}
                  </h2>
                  {c.relation.reason ? <p class="muted small">{c.relation.reason}</p> : null}
                  <div class="pair">
                    <Side
                      slug={slug}
                      label={j.sideA}
                      e={c.from}
                      onKeep={
                        can.keepFrom
                          ? () => setDecide({ conflict: c, from: c.from.id, to: c.to.id, kind: 'supersedes' })
                          : null
                      }
                    />
                    <Side
                      slug={slug}
                      label={j.sideB}
                      e={c.to}
                      onKeep={
                        can.keepTo
                          ? () => setDecide({ conflict: c, from: c.to.id, to: c.from.id, kind: 'supersedes' })
                          : null
                      }
                    />
                  </div>
                  {can.notRelated ? (
                    <p class="actions">
                      <Button
                        blocked={blockedNow(false)}
                        onClick={() =>
                          setDecide({ conflict: c, from: c.from.id, to: c.to.id, kind: 'not_related' })
                        }
                      >
                        {j.notRelatedBtn}
                      </Button>
                    </p>
                  ) : null}
                  {none ? (
                    <p class="muted small" data-state="not-yours">
                      {j.notYoursToDecide(brain.name, curatorNames(slug))}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <More p={p} />
        </>
      )}
      <DecideDialog
        slug={slug}
        d={decide}
        onClose={() => setDecide(null)}
        onDone={() => {
          setDecide(null)
          journalChanged(slug)
          setSaid(j.decided)
          // The decided pair leaves the list: the keyboard goes to the heading, not to a removed button.
          requestAnimationFrame(focusHeading)
        }}
      />
    </>
  )
}

function Forbidden({
  brain,
  slug,
  text,
}: {
  brain: BrainOne
  slug: string
  text: (b: string, c: string) => string
}) {
  return (
    <div class="state" data-state="forbidden">
      <span class="kind">{T.kind.noAccess}</span>
      <p>{text(brain.name, curatorNames(slug))}</p>
    </div>
  )
}

export function JournalForgotten({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const curator = roleAtLeast(brain, 'curator')
  const r = forgottenResource(slug)
  useFresh(r)
  membersResource(slug)
  const [said, setSaid] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const p = usePages<EntryRead>(
    r.data.value,
    (next) =>
      api.call<Listing<EntryRead>>('forgotten', { path: { slug }, query: { cursor: next, limit: 50 } }),
    (e) => e.id,
  )
  if (!brain) return gate
  const j = T.journal
  const recover = async (e: EntryRead) => {
    setPending(e.id)
    try {
      await api.call('recoverEntry', { path: { id: e.id } })
      journalChanged(slug)
      setSaid({ text: j.recovered, tone: 'ok' })
    } catch (x) {
      const err = x as ApiError
      setSaid({ text: `${err.message} ${err.howToProceed}`, tone: 'error' })
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <WikiHead title={j.forgotten} lead={j.forgottenLead}>
        {curator && p.first ? <span class="tag">{j.forgottenCount(p.first.total)}</span> : null}
      </WikiHead>
      <JournalNav brain={brain} />
      <Said text={said?.text ?? null} tone={said?.tone ?? 'ok'} />
      {!curator ? (
        <Forbidden brain={brain} slug={slug} text={j.curatorsOnly} />
      ) : !p.first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )
      ) : p.items.length === 0 ? (
        <Empty title={j.noForgottenTitle}>
          <p>{j.noForgottenLead}</p>
        </Empty>
      ) : (
        <>
          <ul class="list">
            {p.items.map((e) => (
              <li key={e.id} class="with-actions">
                <div>
                  <EntryLine slug={slug} e={e} />
                  {e.forgotten ? (
                    <p class="why">
                      {j.forgottenBy(e.forgotten.by.name, T.date(e.forgotten.at))}: {e.forgotten.reason}
                    </p>
                  ) : null}
                </div>
                {writable(brain) ? (
                  <p class="actions">
                    <Button
                      pending={pending === e.id}
                      pendingLabel={j.recovering}
                      blocked={blockedNow(false)}
                      aria-label={`${j.recover}: ${e.title}`}
                      onClick={() => void recover(e)}
                    >
                      {j.recover}
                    </Button>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <More p={p} />
        </>
      )}
    </>
  )
}

export function JournalToReview({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const r = toReviewResource(slug)
  useFresh(r)
  const [said, setSaid] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const p = usePages<EntryRead>(
    r.data.value,
    (next) =>
      api.call<Listing<EntryRead>>('toReview', { path: { slug }, query: { cursor: next, limit: 50 } }),
    (e) => e.id,
  )
  if (!brain) return gate
  const j = T.journal
  const who = {
    role: brain.role,
    me: me().data.value?.account.id ?? '',
    archived: brain.status === 'archived',
  }
  const reviewed = async (e: EntryRead) => {
    setPending(e.id)
    try {
      await api.call('scheduleEntry', { path: { id: e.id }, body: { reviewAfter: null } })
      journalChanged(slug)
      setSaid({ text: j.reviewedNow, tone: 'ok' })
      requestAnimationFrame(focusHeading)
    } catch (x) {
      const err = x as ApiError
      setSaid({ text: `${err.message} ${err.howToProceed}`, tone: 'error' })
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <WikiHead title={j.toReview} lead={j.toReviewLead}>
        {p.first ? <span class="tag">{j.toReviewCount(p.first.total)}</span> : null}
      </WikiHead>
      <JournalNav brain={brain} />
      <Said text={said?.text ?? null} tone={said?.tone ?? 'ok'} />
      {!p.first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )
      ) : p.items.length === 0 ? (
        <Empty title={j.noReviewTitle}>
          <p>{j.noReviewLead}</p>
        </Empty>
      ) : (
        <>
          <ul class="list">
            {p.items.map((e) => (
              <li key={e.id} class="with-actions">
                <div>
                  <EntryLine slug={slug} e={e} />
                  {e.reviewAfter ? <p class="why">{j.reviewDue(T.date(e.reviewAfter))}</p> : null}
                </div>
                {entryPowers(e, who).schedule ? (
                  <p class="actions">
                    <Button
                      pending={pending === e.id}
                      pendingLabel={j.saving}
                      blocked={blockedNow(false)}
                      aria-label={`${j.reviewed}: ${e.title}`}
                      onClick={() => void reviewed(e)}
                    >
                      {j.reviewed}
                    </Button>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <More p={p} />
        </>
      )}
    </>
  )
}
