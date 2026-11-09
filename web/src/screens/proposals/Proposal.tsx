// A proposal (spec B6 «Proposals: la bandeja», B2 «Revisar una propuesta»; T027–T028, CA2, CA2b, CA3).
// Who: any member reads it; a curator of an active brain decides. Job: see exactly what would change in the
// wiki and decide: approve all, approve the chosen changes and return the rest with a comment, edit a
// change first, accept an old base, or return it all with a comment. Done when: the decision is taken and
// the screen says what changed, with a link to each page. What is approved is what was seen: the
// fingerprint of the review travels with the decision, and if the proposal changed (or someone decided
// it) nothing applies, the new version shows and the person's choices and comment stay. Another
// curator's decision arrives from the live feed («approved by Eva just now») and the view turns read-only.
// One column at every width; `a` approves and `r` returns (never while typing).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { draft } from '../../api/draft.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { forget, invalidate } from '../../api/resource.ts'
import {
  approveBody,
  approveKeyHold,
  blockers,
  type Choices,
  type Correction,
  choose,
  chooseNote,
  correctionOf,
  decidedNotice,
  editableParts,
  editIsOld,
  groupsOf,
  inboxDraftKey,
  keepChoices,
  needsBase,
  type Op,
  oldBase,
  opWords,
  type PageState,
  purgedEdits,
  type ReviewOp,
  togetherWhy,
} from '../../lib/proposals.ts'
import { focusOnArrival } from '../../lib/screen.ts'
import { sourceKey, wordDiff } from '../../lib/wiki.ts'
import { useLive } from '../../live/follow.ts'
import { me } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Field } from '../../ui/Field.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { TextArea } from '../../ui/TextArea.tsx'
import { blockedNow, logHref, pageHref, useBrain, WikiHead } from '../wiki/common.tsx'
import { BodyDiff, BodyLines, ListDiff, Words } from '../wiki/History.tsx'
import { SourcePanel } from '../wiki/Page.tsx'
import {
  type Decision,
  inboxHref,
  inboxResource,
  proposalHref,
  proposalsChanged,
  type Review,
  reviewResource,
  type SourceEntry,
} from './data.ts'
import { DecidedLine, proposer, ReadOnlyLine } from './Inbox.tsx'

const NONE: Choices = { selected: [], corrections: {}, baseReviewed: [], comment: '' }

// The person's choices on this proposal, kept as they type (a reload or a failed send keeps them), per
// person and proposal, and gone with the session.
function useChoices(account: string, id: string) {
  const store = useMemo(() => {
    const s = typeof sessionStorage === 'undefined' || !account ? null : sessionStorage
    return s ? draft(inboxDraftKey(account, id), s) : null
  }, [account, id])
  const read = (): Choices => {
    try {
      const v = JSON.parse(store?.get() || 'null') as Partial<Choices> | null
      if (!v) return NONE
      return {
        selected: Array.isArray(v.selected) ? v.selected.filter((x) => typeof x === 'number') : [],
        corrections: v.corrections && typeof v.corrections === 'object' ? v.corrections : {},
        baseReviewed: Array.isArray(v.baseReviewed)
          ? v.baseReviewed.filter((x) => typeof x === 'number')
          : [],
        comment: typeof v.comment === 'string' ? v.comment : '',
      }
    } catch {
      return NONE
    }
  }
  const [choices, set] = useState<Choices>(read)
  const keep = (c: Choices) => {
    const empty =
      !c.selected.length && !c.baseReviewed.length && !c.comment && !Object.keys(c.corrections).length
    if (empty) store?.clear()
    else store?.set(JSON.stringify(c))
  }
  const save = (c: Choices) => {
    set(c)
    keep(c)
  }
  // From what is there now, not from what a render saw (an effect may run after the person typed).
  const update = (f: (prev: Choices) => Choices) =>
    set((prev) => {
      const next = f(prev)
      if (next === prev) return prev
      keep(next)
      return next
    })
  return { choices, save, update, clear: () => store?.clear() }
}

const sourceText = (s: NonNullable<PageState['sources']>[number]) =>
  'entryId' in s ? s.entryId : s.title ? `${s.title} (${s.url})` : s.url
const linkText = (l: { kind: string; to: string }) => `${T.wiki.kinds[l.kind] ?? l.kind} ${l.to}`

// What changes in a page, part by part: the words of title and summary, status, type and address, tags,
// sources and typed links as items added or removed, and the body by line (one column at every width).
// `fresh`: a new page, whose address is the card's and whose status is current: its words alone.
// The sources are listed (and open) below the card, so they are not repeated here.
function PageDiff({
  a,
  b,
  level = 4,
  fresh = false,
}: {
  a: PageState
  b: PageState
  level?: 4 | 5
  fresh?: boolean
}) {
  const w = T.wiki
  const H = level === 4 ? 'h4' : 'h5'
  const text = (
    [
      ['title', a.title ?? '', b.title ?? ''],
      ['summary', a.summary ?? '', b.summary ?? ''],
      ['address', a.address ?? '', b.address ?? ''],
      ['status', w.statuses[a.status ?? ''] ?? a.status ?? '', w.statuses[b.status ?? ''] ?? b.status ?? ''],
      ['type', w.types[a.type ?? ''] ?? a.type ?? '', w.types[b.type ?? ''] ?? b.type ?? ''],
      ['tags', (a.tags ?? []).join(', '), (b.tags ?? []).join(', ')],
    ] as const
  ).filter(([part, p, q]) => p !== q && !(fresh && (part === 'address' || part === 'status')))
  const lists = (
    [
      [
        'sources',
        (a.sources ?? []).map(sourceText),
        (b.sources ?? []).map(sourceText),
        (a.sources ?? []).map(sourceKey).join(),
        (b.sources ?? []).map(sourceKey).join(),
      ],
      ['links', (a.links ?? []).map(linkText), (b.links ?? []).map(linkText), '', ''],
    ] as const
  ).filter(([part, p, q, kp, kq]) => part !== 'sources' && (p.join('\n') !== q.join('\n') || kp !== kq))
  const body = (a.body ?? '') !== (b.body ?? '')
  if (!text.length && !lists.length && !body) return <p class="muted">{T.proposals.noDiff}</p>
  return (
    <>
      {text.map(([part, p, q]) => (
        <div key={part} class="diff-part">
          <H>{w.parts[part]}</H>
          <Words segments={wordDiff(p, q)} />
        </div>
      ))}
      {lists.map(([part, p, q]) => (
        <div key={part} class="diff-part">
          <H>{w.parts[part]}</H>
          <ListDiff a={[...p]} b={[...q]} />
        </div>
      ))}
      {body ? (
        <div class="diff-part">
          <H>{w.parts.body}</H>
          {a.body ? (
            <BodyDiff a={a.body} b={b.body ?? ''} />
          ) : (
            <BodyLines lines={(b.body ?? '').split('\n').map((text) => ({ kind: 'added' as const, text }))} />
          )}
        </div>
      ) : null}
    </>
  )
}

// The page after the change, with the person's own version of the change laid over it.
const mine = (after: PageState | null, correction: Correction | undefined): PageState => {
  const out: PageState = { ...(after ?? {}) }
  if (correction) {
    for (const k of ['title', 'summary', 'body'] as const)
      if (typeof correction[k] === 'string') out[k] = correction[k] as string
  }
  return out
}

// The entries a proposal cites, named by the review itself (CA4: an id means nothing to a person), so
// looking at a proposal opens none of them (opening one is a read).
type SourceNames = Map<string, SourceEntry>

// An entry that keeps its words opens beside the proposal; one purged, or forgotten for a person who is
// not a curator, keeps its place and says why it has no title (as the wiki page says it).
function SourceEntryLine({
  id,
  named,
  onOpen,
}: {
  id: string
  named: SourceEntry | undefined
  onOpen: () => void
}) {
  const w = T.proposals
  const gone =
    named && named.state !== 'active' ? (
      <span class="tag warn">
        {named.state === 'forgotten' ? T.wiki.sourceForgotten : T.wiki.sourcePurged}
      </span>
    ) : null
  if (!named?.title)
    return (
      <>
        {w.sourceEntry} <span class="mono">{id}</span> {gone}
      </>
    )
  return (
    <>
      {w.sourceEntry}{' '}
      <button type="button" class="linkish" data-op-source={id} onClick={onOpen}>
        {named.title}
      </button>{' '}
      {gone}
    </>
  )
}

// The sources of a change: an entry opens beside the proposal (the wiki page's side panel), which stays.
function Sources({ slug, op, names }: { slug: string; op: Op; names: SourceNames }) {
  const w = T.proposals
  const [open, setOpen] = useState<string | null>(null)
  const list = Array.isArray(op.sources) ? (op.sources as NonNullable<PageState['sources']>) : null
  if (!list) return null
  return (
    <div class="op-sources">
      <h4>{w.sources}</h4>
      {list.length === 0 ? (
        <p class="muted small">{w.noSources}</p>
      ) : (
        <ul class="plain">
          {list.map((s) => (
            <li key={sourceKey(s)}>
              {'entryId' in s ? (
                <SourceEntryLine
                  id={s.entryId}
                  named={names.get(s.entryId)}
                  onOpen={() => setOpen(s.entryId)}
                />
              ) : (
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <SourcePanel
          key={open}
          slug={slug}
          id={open}
          onClose={() => {
            const back = open
            setOpen(null)
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>(`[data-op-source="${CSS.escape(back)}"]`)?.focus(),
            )
          }}
        />
      ) : null}
    </div>
  )
}

type CardProps = {
  slug: string
  o: ReviewOp
  names: SourceNames
  // The change of this proposal that makes the page this one is about, if one does.
  bornBy: number | null
  // The purges of the wiki the review shows: an edit made here carries it.
  purges: number
  act: boolean
  choices: Choices
  several: boolean
  onChoose: (on: boolean) => void
  onBase: (on: boolean) => void
  onCorrect: (c: Correction | null) => void
}

const LONG = 700

// A new page as it will read: its words as text (not a difference against nothing), a long text folded.
function NewPage({ page }: { page: PageState }) {
  const w = T.proposals
  const body = page.body ?? ''
  return (
    <div class="op-new">
      {page.title ? <p class="new-title">{page.title}</p> : null}
      {page.summary ? <p class="muted">{page.summary}</p> : null}
      <p class="meta">
        {[T.wiki.types[page.type ?? ''] ?? page.type, (page.tags ?? []).join(', ')]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {body.length > LONG ? (
        <>
          <p class="plain-body">{`${body.slice(0, LONG).trimEnd()}…`}</p>
          <details class="whole">
            <summary class="whole-summary">{w.wholeText}</summary>
            <p class="plain-body">{body}</p>
          </details>
        </>
      ) : (
        <p class="plain-body">{body}</p>
      )}
    </div>
  )
}

function Card({
  slug,
  o,
  names,
  bornBy,
  purges,
  act,
  choices,
  several,
  onChoose,
  onBase,
  onCorrect,
}: CardProps) {
  const w = T.proposals
  const n = o.index + 1
  const titleId = `op-${o.index}-title`
  const pending = o.status === 'pending'
  const correction = choices.corrections[o.index]
  const parts = editableParts(o.op)
  const [editing, setEditing] = useState(false)
  const shown = mine(o.after, correction)
  const [form, setForm] = useState<Record<string, string>>({})
  const body = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const back = useRef(false)
  useEffect(() => {
    if (editing) (body.current ?? document.getElementById(`op-${o.index}-title-field`))?.focus()
    else if (back.current) {
      back.current = false
      editButton.current?.focus()
    }
  }, [editing])
  const open = () => {
    setForm(Object.fromEntries(parts.map((k) => [k, String(shown[k] ?? '')])))
    setEditing(true)
  }
  const reviewed = choices.baseReviewed.includes(o.index)
  const choosable = act && pending && several
  const title = (
    <h3 id={titleId} class="op-title">
      <span class="op-n">{w.changeN(n)}:</span> {opWords(o.op)}
    </h3>
  )
  return (
    <article
      id={`op-${o.index}`}
      tabIndex={-1}
      class={`op-card${o.stale && pending ? ' stale' : ''}`}
      aria-labelledby={titleId}
    >
      {choosable ? (
        // The whole head is the tap target of the choice (44 px at least).
        <label class="op-head">
          <input
            type="checkbox"
            data-letter-keys=""
            aria-label={w.choose(n)}
            checked={choices.selected.includes(o.index)}
            onChange={(e) => onChoose((e.currentTarget as HTMLInputElement).checked)}
          />
          {title}
        </label>
      ) : (
        <div class="op-head">{title}</div>
      )}
      <p class="op-tags">
        {o.op.op === 'create' ? <span class="tag">{w.newPageTag}</span> : null}
        {pending ? null : (
          <span class={`tag${o.status === 'returned' ? ' warn' : ''}`}>{w.opStatus[o.status]}</span>
        )}
        {o.corrected ? <span class="tag">{w.corrected}</span> : null}
        {correction && pending ? <span class="tag warn">{w.editedByYou}</span> : null}
        {o.stale && pending ? <span class="tag warn">{w.stale}</span> : null}
        {reviewed && pending ? <span class="tag">{w.baseReviewedTag}</span> : null}
      </p>
      {correction && pending && editIsOld(o, choices) ? (
        <p class="note">{w.editOldAt(correction.revision ?? 0, o.before?.revision ?? 0)}</p>
      ) : null}
      {o.op.reason ? <p class="op-reason">{T.wiki.why(o.op.reason)}</p> : null}
      {o.warnings.length ? (
        <ul class="plain op-warnings">
          {o.warnings.map((x) => (
            <li key={x.code + x.message}>
              <span class="tag warn">{T.kind.warning}</span> {x.message}
            </li>
          ))}
        </ul>
      ) : null}
      {o.stale && pending ? (
        <div class="three">
          <p class="note">{w.staleLead(o.stale.base?.revision ?? 0, o.stale.current.revision ?? 0)}</p>
          <section class="version" aria-labelledby={`op-${o.index}-since`}>
            <h4 id={`op-${o.index}-since`}>
              {w.sinceWritten(o.stale.base?.revision ?? 0, o.stale.current.revision ?? 0)}
            </h4>
            {o.stale.base ? (
              <PageDiff a={o.stale.base} b={o.stale.current} level={5} />
            ) : (
              <p class="muted">{w.baseGone}</p>
            )}
          </section>
          <section class="version" aria-labelledby={`op-${o.index}-proposed`}>
            <h4 id={`op-${o.index}-proposed`}>{w.proposedFromBase(o.stale.base?.revision ?? 0)}</h4>
            <PageDiff a={o.stale.base ?? o.stale.current} b={mine(o.stale.proposed, correction)} level={5} />
          </section>
          <section class="version will-be" aria-labelledby={`op-${o.index}-will`}>
            <h4 id={`op-${o.index}-will`}>{w.willBe}</h4>
            <p class="muted small">{w.willBeLead}</p>
            <PageDiff a={o.stale.current} b={mine(o.stale.proposed, correction)} level={5} />
          </section>
          {act && needsBase(o, choices) ? <p class="muted small">{w.staleNeeds}</p> : null}
        </div>
      ) : o.op.op === 'create' ? (
        <NewPage page={shown} />
      ) : o.before === null && pending ? (
        <p class="muted">{bornBy !== null ? w.bornBy(bornBy + 1) : w.pageGone}</p>
      ) : (
        <div class="op-diff">
          <PageDiff a={o.before ?? {}} b={shown} />
        </div>
      )}
      <Sources slug={slug} op={o.op} names={names} />
      {act && pending && editing ? (
        <form
          class="form op-edit"
          aria-label={w.editTitle(n)}
          onSubmit={(e) => {
            e.preventDefault()
            onCorrect(correctionOf(o, form, purges))
            back.current = true
            setEditing(false)
          }}
        >
          <p class="muted small">{w.editLead}</p>
          {parts.includes('title') ? (
            <Field
              label={w.partTitle}
              value={form.title ?? ''}
              onValue={(v) => setForm({ ...form, title: v })}
              maxLength={200}
              id={`op-${o.index}-title-field`}
            />
          ) : null}
          {parts.includes('summary') ? (
            <Field
              label={w.partSummary}
              value={form.summary ?? ''}
              onValue={(v) => setForm({ ...form, summary: v })}
              maxLength={500}
            />
          ) : null}
          {parts.includes('body') ? (
            <div class="field">
              <label for={`op-${o.index}-body`}>{w.partBody}</label>
              <textarea
                id={`op-${o.index}-body`}
                ref={body}
                rows={8}
                value={form.body ?? ''}
                onInput={(e) => setForm({ ...form, body: (e.currentTarget as HTMLTextAreaElement).value })}
              />
            </div>
          ) : null}
          <p class="actions">
            <Button type="submit" kind="primary">
              {w.useEdit}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                back.current = true
                setEditing(false)
              }}
            >
              {w.cancelEdit}
            </Button>
          </p>
        </form>
      ) : act && pending && (parts.length || oldBase(o, choices)) ? (
        <p class="actions op-actions">
          {/* Each card's «Edit» names its change (several on one page read apart). */}
          {parts.length ? (
            <button
              type="button"
              class="button secondary"
              ref={editButton}
              aria-label={w.editTitle(n)}
              onClick={open}
            >
              {w.edit}
            </button>
          ) : null}
          {correction ? (
            <Button kind="quiet" onClick={() => onCorrect(null)}>
              {w.undoEdit}
            </Button>
          ) : null}
          {oldBase(o, choices) ? (
            <button
              type="button"
              class="button secondary wrap-button"
              aria-pressed={reviewed ? 'true' : 'false'}
              onClick={() => onBase(!reviewed)}
            >
              {w.baseReviewed}
            </button>
          ) : null}
        </p>
      ) : null}
    </article>
  )
}

// What a decision did, with a link to each page it changed, and the way on to the next one waiting.
function Result({ slug, d, next }: { slug: string; d: Decision; next: string | null }) {
  const w = T.proposals
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => focusOnArrival(ref.current), [d])
  const how = d.proposal.status
  return (
    <div class="alert ok result" role="status" tabIndex={-1} ref={ref}>
      <span class="kind">{T.kind.done}</span>
      <div>
        <p>
          {how === 'returned' ? w.returnedNow : how === 'partially_approved' ? w.partlyNow : w.approvedNow}
        </p>
        {how === 'returned' ? null : d.applied.length ? (
          <ul class="plain result-pages">
            {[...new Set(d.applied.map((a) => a.address))].map((a) => (
              <li key={a}>
                <a href={pageHref(slug, a)}>{a}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">{w.noPages}</p>
        )}
        {next ? (
          <p class="next-link">
            <a href={proposalHref(slug, next)}>{w.nextPending}</a>
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Problems({ error, focus = true }: { error: ApiError | null; focus?: boolean }) {
  if (!error) return null
  if (!error.problems.length) return <FormAlert error={error} focus={focus} />
  return (
    <div class="alert" role="alert" tabIndex={-1}>
      <span class="kind">{T.kind.problem}</span>
      <span>{error.message}</span>
      <ul class="plain">
        {error.problems.map((p) => (
          <li key={p.message}>{p.message}</li>
        ))}
      </ul>
    </div>
  )
}

// The comment the person wrote and could not send (the proposal was decided meanwhile): kept on screen.
function NotSent({ comment }: { comment: string }) {
  if (!comment.trim()) return null
  return <p class="muted not-sent">{T.proposals.notSent(comment.trim())}</p>
}

// A shortcut held back (`a` with a choice or a comment) says why where the person is: the keyboard
// handler names it in an event on the button it moved to.
export const HOLD_EVENT = 'rscb-shortcut-hold'

export function ProposalScreen({ slug, id }: { slug: string; id: string }) {
  const { brain, gate } = useBrain(slug)
  const r = reviewResource(slug, id)
  useFresh(r)
  // Only the proposal on screen stays in the cache: a change in the wiki reloads it, and none other.
  useEffect(() => () => forget(`brain:${slug}:proposals:review:${id}`), [slug, id])
  const pendingList = inboxResource(slug, 'pending')
  const account = me().data.value?.account.id ?? ''
  const { choices, save, update, clear } = useChoices(account, id)
  const [busy, setBusy] = useState<'all' | 'some' | 'back' | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [decidedMeanwhile, setDecidedMeanwhile] = useState(false)
  const [decidedMsg, setDecidedMsg] = useState<string | null>(null)
  const [focusOp, setFocusOp] = useState<number | null>(null)
  const [result, setResult] = useState<Decision | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useLive(slug, undefined, false, (e) => {
    const n = decidedNotice(e, id, account)
    if (n) setNotice(n.text)
  })
  useEffect(() => {
    const hold = (e: Event) => setNote(String((e as CustomEvent).detail ?? ''))
    document.addEventListener(HOLD_EVENT, hold)
    return () => document.removeEventListener(HOLD_EVENT, hold)
  }, [])
  const review = r.data.value
  // A new version (it changed meanwhile): what still applies of the person's choices stays, worked out
  // from the choices as they are now (an older render's would undo what was typed since).
  useEffect(() => {
    if (!review) return
    // Text was purged from the wiki since an edit of the person's: that edit goes (it could hold it).
    if (purgedEdits(choices, review.purges)) setSaid(T.proposals.purgedEdits)
    update((prev) => keepChoices(prev, review.ops, review.purges))
  }, [review])
  // After a 409 on an old base, the card that needs a look takes the keyboard once it shows as such.
  useEffect(() => {
    if (focusOp === null || !review) return
    const card = document.getElementById(`op-${focusOp}`)
    const o = review.ops.find((x) => x.index === focusOp)
    if (card && o && oldBase(o, choices)) {
      card.focus()
      setFocusOp(null)
    }
  }, [review, focusOp])
  if (!brain) return gate
  const w = T.proposals
  if (!review) {
    return r.error.value ? (
      <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
    ) : (
      <Skeleton rows={5} />
    )
  }
  const p = review.proposal
  const pendingOps = review.ops.filter((o) => o.status === 'pending')
  const act = review.canDecide && p.status === 'pending' && !notice && !result
  const several = pendingOps.length > 1
  const b = blockers(review.ops, choices)
  const groups = groupsOf(review.ops)
  const names: SourceNames = new Map((review.sourceEntries ?? []).map((e) => [e.id, e]))
  const chose = choices.selected.length > 0
  const waiting = (pendingList.data.value?.items ?? []).filter((x) => x.id !== id && x.status === 'pending')
  const backHref =
    waiting.length || (pendingList.data.value?.total ?? 0) > 0 || p.status === 'pending'
      ? inboxHref(slug)
      : inboxHref(slug, p.status)

  const decide = async (how: 'all' | 'some' | 'back', current: Review) => {
    setBusy(how)
    setError(null)
    setSaid(null)
    setNote(null)
    try {
      const d =
        how === 'back'
          ? await api.call<Decision>('returnProposal', {
              path: { id },
              body: { fingerprint: current.fingerprint, comment: choices.comment.trim() },
            })
          : await api.call<Decision>('approveProposal', {
              path: { id },
              body: approveBody(current.fingerprint, current.ops, choices, how),
            })
      setResult(d)
      clear()
      proposalsChanged(slug)
    } catch (x) {
      const e = x as ApiError
      if (e.code === 'proposal_changed' && (e.current as { purged?: boolean } | undefined)?.purged) {
        setSaid(w.purgedEdits)
        await r.reload()
      } else if (e.code === 'proposal_changed') {
        // The corrections stay, but they were written on what the person saw before.
        setSaid(
          Object.keys(choices.corrections).length ? `${w.changedMeanwhile} ${w.editOld}` : w.changedMeanwhile,
        )
        await r.reload()
      } else if (e.code === 'stale_base') {
        // A page moved on after the review: show it as an old base, keep everything, go to that card.
        setError(e)
        setFocusOp(e.problemOps[0] ?? null)
        await r.reload()
      } else if (e.code === 'already_decided') {
        setDecidedMeanwhile(true)
        setDecidedMsg(e.message)
        invalidate(`brain:${slug}:basic`)
        await r.reload()
      } else {
        setError(e)
        // My role changed: the screen shows what I may do now.
        if (e.status === 403) {
          invalidate(`brain:${slug}:basic`)
          void r.reload()
        }
      }
    } finally {
      setBusy(null)
    }
  }
  // «Approve all» leads when nothing is chosen, and follows «Approve selected» once something is. `a`
  // presses it only with nothing chosen and nothing written; otherwise the keyboard goes where the person
  // meant to go (the chosen ones' button, or the comment), so a second key (Enter) cannot approve it all.
  const hold = approveKeyHold(choices)
  const approveAll = (
    <p class="decide-row">
      <Button
        kind={chose ? 'secondary' : 'primary'}
        data-shortcut="approve"
        data-hold={hold ?? undefined}
        data-hold-to={hold ? (chose && several ? 'approve-some' : 'proposal-comment') : undefined}
        aria-keyshortcuts="a"
        pending={busy === 'all'}
        pendingLabel={w.approving}
        blocked={busy && busy !== 'all' ? blockedNow(true) : (blockedNow(false) ?? b.all)}
        onClick={() => void decide('all', review)}
      >
        {chose ? w.approveAllIgnoring(pendingOps.length) : w.approveAll}
      </Button>
    </p>
  )
  // Decided meanwhile: who and when when a curator did it; the author's withdrawal says so; else the
  // server's own words.
  const decidedLine =
    p.status === 'pending'
      ? null
      : p.decidedByName && p.decidedAt
        ? w.decidedAlready(w.statuses[p.status] ?? p.status, p.decidedByName, T.date(p.decidedAt))
        : p.status === 'withdrawn'
          ? w.withdrawnMeanwhile
          : (decidedMsg ?? w.decidedAlready(w.statuses[p.status] ?? p.status, '—', '—'))
  const decided = decidedMeanwhile && decidedLine

  return (
    <div class="proposal-view">
      <p class="back-link">
        <a href={backHref}>{w.back}</a>
      </p>
      <WikiHead title={p.title}>
        <span class={`tag${p.status === 'pending' ? '' : ' warn'}`}>
          {w.statusWord[p.status] ?? p.status}
        </span>
        {p.old && p.status === 'pending' ? (
          <span class="tag warn" title={w.oldTitle}>
            {w.old}
          </span>
        ) : null}
      </WikiHead>
      <p class="meta">
        {[proposer(p), w.sent(T.dateTime(p.createdAt)), w.changes(review.ops.length)].join(' · ')}
      </p>
      {notice ? (
        <div class="alert warn" role="status">
          <span class="kind">{T.kind.warning}</span>
          <span>{notice}</span>
          <NotSent comment={choices.comment} />
        </div>
      ) : null}
      {decided ? (
        <div class="alert warn" role="alert">
          <span class="kind">{T.kind.warning}</span>
          <span>{decidedLine}</span>
          <span>
            {w.seeLog} <a href={logHref(slug)}>{w.brainLog}</a>.
          </span>
          <NotSent comment={choices.comment} />
        </div>
      ) : null}
      {result ? <Result slug={slug} d={result} next={waiting[0]?.id ?? null} /> : null}
      {said ? (
        <p class="alert warn" role="status">
          <span class="kind">{T.kind.warning}</span>
          <span>{said}</span>
        </p>
      ) : null}
      {p.decidedByName && !result && !decided ? (
        <p class="meta decided-line">
          <DecidedLine p={p} />
        </p>
      ) : null}
      {p.comment ? (
        <blockquote class="ask">
          <span class="sr-only">{w.comments}: </span>
          {p.comment}
        </blockquote>
      ) : null}
      {p.supersededBy ? (
        <p class="alert warn" role="note">
          <span class="kind">{T.kind.warning}</span>
          <span>
            {w.replacedBy}{' '}
            <a href={`${inboxHref(slug)}/${encodeURIComponent(p.supersededBy)}`}>{w.openNewer}</a>
          </span>
        </p>
      ) : null}
      {p.lastError && p.status === 'pending' ? <p class="alert">{w.lastError(p.lastError)}</p> : null}
      {review.canDecide || p.status !== 'pending' ? null : <ReadOnlyLine brain={brain} slug={slug} />}

      {/* Wide: the changes in the main column, why and the decision beside them. */}
      <div class="proposal-body">
        <section class="why" aria-labelledby="why-title">
          <h2 id="why-title" class="section-title">
            {w.why}
          </h2>
          <p>{p.reason || '—'}</p>
          {p.collected.length ? <p class="muted small">{w.collected(p.collected.length)}</p> : null}
          {review.warnings.length ? (
            <ul class="plain op-warnings">
              {review.warnings.map((x) => (
                <li key={x.code + x.message}>
                  <span class="tag warn">{T.kind.warning}</span> {x.message}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section class="changes" aria-labelledby="changes-title">
          <h2 id="changes-title" class="section-title">
            {w.changesTitle}
          </h2>
          {act && several ? <p class="muted small">{w.chooseHint}</p> : null}
          {groups.map((g) => {
            const cards = g.map((i) => {
              const o = review.ops.find((x) => x.index === i) as ReviewOp
              return (
                <Card
                  key={i}
                  slug={slug}
                  o={o}
                  names={names}
                  purges={review.purges}
                  bornBy={
                    review.ops.find(
                      (x) =>
                        x.index !== i &&
                        ((x.op.op === 'create' && x.op.address === o.op.address) ||
                          (x.op.op === 'move' && x.op.to === o.op.address)),
                    )?.index ?? null
                  }
                  act={act}
                  choices={choices}
                  several={several}
                  onChoose={(on) => {
                    const next = choose(choices.selected, i, on, review.ops)
                    setNote(chooseNote(choices.selected, next, i, on, review.ops))
                    save({ ...choices, selected: next })
                  }}
                  onBase={(on) =>
                    save({
                      ...choices,
                      baseReviewed: on
                        ? [...new Set([...choices.baseReviewed, i])]
                        : choices.baseReviewed.filter((x) => x !== i),
                    })
                  }
                  onCorrect={(c) => {
                    const next = { ...choices.corrections }
                    if (c) next[i] = c
                    else delete next[i]
                    save({ ...choices, corrections: next })
                  }}
                />
              )
            })
            if (g.length === 1) return cards
            const gid = `group-${g[0]}`
            return (
              <fieldset key={gid} class="op-group" aria-describedby={`${gid}-why`}>
                <legend class="group-title">{w.together}</legend>
                <p id={`${gid}-why`} class="muted small group-why">
                  {togetherWhy(g, review.ops)}
                </p>
                {cards}
              </fieldset>
            )
          })}
        </section>

        {act ? (
          <section class="decide" aria-labelledby="decide-title">
            <h2 id="decide-title" class="section-title">
              {w.decideTitle}
            </h2>
            <TextArea
              id="proposal-comment"
              label={w.comment}
              hint={w.commentHint}
              rows={3}
              maxLength={4000}
              value={choices.comment}
              onValue={(v) => save({ ...choices, comment: v })}
            />
            {several ? <p class="meta">{w.chosen(choices.selected.length, pendingOps.length)}</p> : null}
            <p class="said ok" role="status">
              {note}
            </p>
            <div class={`decide-actions${chose ? ' chose' : ''}`}>
              {chose ? null : approveAll}
              {several ? (
                <p class="decide-row">
                  <Button
                    id="approve-some"
                    kind={chose ? 'primary' : 'secondary'}
                    data-shortcut="approve-some"
                    data-needs={b.someNeedsComment ? 'proposal-comment' : undefined}
                    pending={busy === 'some'}
                    pendingLabel={w.approving}
                    blocked={busy && busy !== 'some' ? blockedNow(true) : (blockedNow(false) ?? b.some)}
                    onClick={() => void decide('some', review)}
                  >
                    {w.approveSome}
                  </Button>
                </p>
              ) : null}
              {chose ? approveAll : null}
              <p class="decide-row">
                <Button
                  kind="quiet"
                  data-shortcut="return"
                  data-needs={b.backNeedsComment ? 'proposal-comment' : undefined}
                  aria-keyshortcuts="r"
                  pending={busy === 'back'}
                  pendingLabel={w.returning}
                  blocked={busy && busy !== 'back' ? blockedNow(true) : (blockedNow(false) ?? b.back)}
                  onClick={() => void decide('back', review)}
                >
                  {w.returnAll}
                </Button>
              </p>
            </div>
            <Problems error={error} focus={error?.code !== 'stale_base'} />
          </section>
        ) : error ? (
          <Problems error={error} />
        ) : null}
      </div>
    </div>
  )
}
