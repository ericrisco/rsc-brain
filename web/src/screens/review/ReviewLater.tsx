// «Review later» (spec learning-memory A2; plan §4.3). Who: the curators of the brain, in the web. Job: look at what
// agents changed in the wiki and either keep it or undo it, whole or in parts. Done when: nothing waits, or the
// person kept or undid the change they opened. List first, oldest at the top, as the inbox of proposals; j and k
// move through the list and Enter opens a change. Undoing asks first, in a dialog: all or some parts (a part
// another part needs comes along), an optional comment that teaches the agent, and — when a page changed since —
// the choice to undo over it, page by page. An address another page took is never taken back.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { ago } from '../../lib/brains.ts'
import { useLive } from '../../live/follow.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { SectionHead } from '../../ui/Section.tsx'
import { Empty, ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { entryHref } from '../journal/common.tsx'
import { More, usePages } from '../journal/Lists.tsx'
import { blockedNow, isCurator, pageHref, useBrain, WikiHead } from '../wiki/common.tsx'
import { BodyDiff, BodyLines } from '../wiki/History.tsx'
import {
  type Change,
  type ChangePage,
  type Conflict,
  changeHref,
  changeResource,
  changesResource,
  PAGE_SIZE,
  type Part,
  reviewed,
  reviewHref,
  SINCE,
  type Since,
  STATES,
  type State,
  type UndoAnswer,
  withNeeders,
} from './data.ts'

const w = T.review

// Who made it, with which key, from which run: «by Cole with Cole writer · run r_12».
const whoLine = (c: Change) =>
  [w.by(c.actor.name, c.keyName), c.ref ? w.run(c.ref) : null, w.parts(c.parts)].filter(Boolean).join(' · ')

// When, relative, with the exact time for a hover and for machines (usability T1, M1).
function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={T.dateTime(at)}>
      {w.applied(ago(at) ?? T.date(at))}
    </time>
  )
}

function StateTag({ state }: { state: Change['state'] }) {
  const tone = state === 'pending_review' ? ' warn' : state === 'kept' ? ' ok' : ''
  return <span class={`tag${tone}`}>{w.states[state] ?? state}</span>
}

// j and k move through the links of a list, Enter follows the one in focus (the browser does that).
function useListKeys(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'j' && e.key !== 'k')) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const links = [...el.querySelectorAll<HTMLAnchorElement>('a[data-row]')]
      if (!links.length) return
      const at = links.indexOf(document.activeElement as HTMLAnchorElement)
      const next = e.key === 'j' ? Math.min(at + 1, links.length - 1) : Math.max(at - 1, 0)
      links[at === -1 ? 0 : next]?.focus()
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ref.current])
}

export function ReviewList({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const { query, route } = useLocation()
  const state = (STATES as readonly string[]).includes(query.state ?? '')
    ? (query.state as State)
    : 'pending_review'
  const since = (SINCE as readonly string[]).includes(query.since ?? '') ? (query.since as Since) : 'all'
  const r = changesResource(slug, state, since)
  useFresh(r)
  useLive(slug)
  const d = r.data.value
  const first = useMemo(() => d, [d])
  const p = usePages<Change>(
    first,
    (next) =>
      api.call<ChangePage>('changes', { path: { slug }, query: { state, limit: PAGE_SIZE, cursor: next } }),
    (x) => x.id,
  )
  const list = useRef<HTMLUListElement>(null)
  useListKeys(list)
  if (!brain) return gate
  const label = w.states[state] ?? state
  return (
    <>
      <WikiHead title={w.title} lead={w.lead} />
      <nav class="tabs" aria-label={w.nav}>
        {STATES.map((s) => (
          <a key={s} href={reviewHref(slug, s)} aria-current={s === state ? 'page' : undefined}>
            {w.states[s]}
          </a>
        ))}
      </nav>
      {brain.role !== 'curator' ? <p class="muted small">{w.readOnly}</p> : null}
      <form class="filters" onSubmit={(e) => e.preventDefault()}>
        <div class="field">
          <label for="review-since">{w.since}</label>
          <select
            id="review-since"
            value={since}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value
              const q = new URLSearchParams()
              if (state !== 'pending_review') q.set('state', state)
              if (v !== 'all') q.set('since', v)
              const qs = q.toString()
              route(qs ? `${reviewHref(slug)}?${qs}` : reviewHref(slug), true)
            }}
          >
            {SINCE.map((x) => (
              <option key={x} value={x}>
                {w.sinceOptions[x]}
              </option>
            ))}
          </select>
        </div>
      </form>
      {!p.first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )
      ) : p.items.length === 0 ? (
        state === 'pending_review' ? (
          <Empty title={w.noneTitle}>
            <p>{w.noneLead}</p>
          </Empty>
        ) : (
          <Empty title={w.noneIn(label)}>
            <p>
              <a href={reviewHref(slug)}>{w.states.pending_review}</a>
            </p>
          </Empty>
        )
      ) : (
        <section class="card pad" aria-labelledby="review-title">
          <SectionHead id="review-title" title={label} meta={w.count(p.first.total)} />
          <p class="muted small" id="review-keys">
            {w.keys}
          </p>
          <ul class="list" aria-label={w.list} aria-describedby="review-keys" ref={list} data-review-list="">
            {p.items.map((c) => (
              <li key={c.id}>
                <p class="list-title">
                  <a href={changeHref(slug, c.id)} data-row="">
                    {c.title}
                  </a>{' '}
                  {state === 'all' || c.state === 'partly_undone' ? <StateTag state={c.state} /> : null}
                </p>
                {c.pages?.length ? (
                  <p class="meta touched">{c.pages.map((x) => w.touched(x.op, x.address)).join(' · ')}</p>
                ) : null}
                <p class="meta">
                  {whoLine(c)} · <When at={c.at} />
                </p>
              </li>
            ))}
          </ul>
          <More p={p} />
        </section>
      )}
    </>
  )
}

// The server's unified diff of a body (its hunks), as the text before and after around each change, so the part shows
// the same word-by-word difference a proposal does.
export function sidesOf(diff: string): { a: string; b: string } {
  const a: string[] = []
  const b: string[] = []
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@') || l.startsWith('\\')) continue
    if (l.startsWith('+')) b.push(l.slice(1))
    else if (l.startsWith('-')) a.push(l.slice(1))
    else {
      const same = l.startsWith(' ') ? l.slice(1) : l
      a.push(same)
      b.push(same)
    }
  }
  return { a: a.join('\n'), b: b.join('\n') }
}

// What a link, move, merge or status operation did, in words (usability T1, M2).
function whatOf(p: Part): string | null {
  const o = p.operation
  if (!o) return null
  if (o.op === 'link' && o.to) return w.linkedTo(o.to, o.kind ?? 'related')
  if (o.op === 'unlink' && o.to) return w.unlinkedFrom(o.to, o.kind ?? 'related')
  if (o.op === 'move' && o.from && o.to) return w.movedFrom(o.from, o.to)
  if (o.op === 'merge' && o.from) return w.mergedFrom(o.from, p.address)
  if (o.op === 'status' && o.status) return w.statusSet(T.wiki.statuses[o.status] ?? o.status)
  return null
}

function PartView({ slug, p }: { slug: string; p: Part }) {
  const titleId = `part-${p.part}-title`
  const what = whatOf(p)
  return (
    <article class="op-card" aria-labelledby={titleId} data-part={p.part}>
      <div class="op-head">
        <h3 id={titleId} class="op-title">
          <span class="op-n">{w.part(p.part, '')}</span>{' '}
          <a class="mono" href={pageHref(slug, p.address)}>
            {p.address}
          </a>
        </h3>
      </div>
      <p class="op-tags">
        {p.created ? <span class="tag">{w.created}</span> : null}
        {p.state === 'undone' ? <span class="tag">{w.partUndone}</span> : null}
        <span class="meta">{w.revisions(p.revisionBefore, p.revisionAfter)}</span>
        {p.dependsOn.length ? <span class="meta"> · {w.needs(p.dependsOn)}</span> : null}
      </p>
      {what ? <p class="op-what">{what}</p> : null}
      {p.operation?.reason ? <p class="op-why">{w.why(p.operation.reason)}</p> : null}
      {p.diff === 'purged' ? (
        <p class="note">{w.purgedDiff}</p>
      ) : p.diff && p.created ? (
        // A new page: its text as added, without an empty «before» (usability T1, M2).
        <BodyLines
          lines={sidesOf(p.diff)
            .b.split('\n')
            .map((text) => ({ kind: 'added' as const, text }))}
        />
      ) : p.diff ? (
        <BodyDiff {...sidesOf(p.diff)} fold />
      ) : what ? null : (
        <p class="muted small">{w.noDiff}</p>
      )}
    </article>
  )
}

function UndoDialog({
  open,
  onClose,
  slug,
  change,
  parts,
  onDone,
}: {
  open: boolean
  onClose: () => void
  slug: string
  change: Change
  parts: Part[]
  onDone: (a: UndoAnswer) => void
}) {
  const applied = parts.filter((p) => p.state === 'applied')
  const [some, setSome] = useState(false)
  const [chosen, setChosen] = useState<number[]>([])
  const [comment, setComment] = useState('')
  const [overwrite, setOverwrite] = useState<string[]>([])
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const going = some ? withNeeders(parts, chosen) : applied.map((p) => p.part)
  const send = async () => {
    if (pending || going.length === 0) return
    setPending(true)
    setError(null)
    try {
      const a = await api.call<UndoAnswer>('undoChange', {
        path: { id: change.id },
        body: {
          ...(some ? { parts: going } : {}),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(overwrite.length ? { overwrite } : {}),
        },
      })
      reviewed(slug)
      onDone(a)
    } catch (e) {
      const x = e as ApiError
      if (x.code === 'undo_conflict') {
        const f = x.fields as Partial<Conflict>
        setConflict({ pages: f.pages ?? [], ...(f.addresses ? { addresses: f.addresses } : {}) })
      }
      setError(x)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} title={w.undoTitle} onClose={onClose} locked={pending}>
      <form
        class="undo-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <p>{w.undoLead}</p>
        <fieldset class="choice">
          <legend class="sr-only">{w.undoTitle}</legend>
          <div class="pick">
            <input
              type="radio"
              id="undo-all"
              name="undo-scope"
              checked={!some}
              onChange={() => setSome(false)}
            />
            <label for="undo-all">{w.undoAll}</label>
          </div>
          {applied.length > 1 ? (
            <div class="pick">
              <input
                type="radio"
                id="undo-some"
                name="undo-scope"
                checked={some}
                onChange={() => setSome(true)}
              />
              <label for="undo-some">{w.undoSome}</label>
            </div>
          ) : null}
        </fieldset>
        {some ? (
          <ul class="plain undo-parts" aria-label={w.undoSome}>
            {applied.map((p) => {
              const forced = going.includes(p.part) && !chosen.includes(p.part)
              const hint = forced ? `undo-part-${p.part}-hint` : undefined
              return (
                <li key={p.part}>
                  <div class="pick">
                    <input
                      type="checkbox"
                      id={`undo-part-${p.part}`}
                      checked={going.includes(p.part)}
                      disabled={forced}
                      aria-describedby={hint}
                      onChange={(e) => {
                        const on = e.currentTarget.checked
                        setChosen((c) => (on ? [...c, p.part] : c.filter((x) => x !== p.part)))
                      }}
                    />
                    <label for={`undo-part-${p.part}`}>{w.undoPart(p.part, p.address)}</label>
                  </div>
                  {forced ? (
                    <p class="hint" id={hint}>
                      {w.undoNeeds(p.dependsOn.filter((d) => going.includes(d)))}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {conflict && (conflict.pages.length || conflict.addresses?.length) ? (
          <div class="alert warn" role="alert" data-state="undo-conflict">
            <p>
              <strong>{w.conflictTitle}</strong>
            </p>
            {conflict.pages.length ? (
              <>
                <p>{applied.length > 1 ? w.conflictLead : w.conflictLeadOne}</p>
                <ul class="plain">
                  {conflict.pages.map((c) => (
                    <li key={c.address}>
                      <div class="pick">
                        <input
                          type="checkbox"
                          id={`overwrite-${c.address}`}
                          checked={overwrite.includes(c.address)}
                          onChange={(e) => {
                            const on = e.currentTarget.checked
                            setOverwrite((o) => (on ? [...o, c.address] : o.filter((x) => x !== c.address)))
                          }}
                        />
                        <label for={`overwrite-${c.address}`}>{w.overwrite(c.address)}</label>
                      </div>
                      {c.editedAt ? (
                        <p class="hint">
                          {w.editedAfter(c.editedBy ?? '', c.address, T.dateTime(c.editedAt))}{' '}
                          {w.overwriteNote}
                        </p>
                      ) : (
                        <p class="hint mono">
                          {w.conflictPage(c.address, c.changeRevision, c.currentRevision)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {conflict.addresses?.length ? (
              <>
                <ul class="plain">
                  {conflict.addresses.map((a) => (
                    <li key={a.address}>{w.addressTaken(a.address, a.heldBy)}</li>
                  ))}
                </ul>
                <p>{w.addressHow}</p>
              </>
            ) : null}
          </div>
        ) : (
          <FormAlert error={error} />
        )}
        <label class="field-label" for="undo-comment">
          {w.comment}
        </label>
        <textarea
          id="undo-comment"
          class="input"
          rows={3}
          maxLength={2000}
          aria-describedby="undo-comment-hint"
          value={comment}
          onInput={(e) => setComment(e.currentTarget.value)}
        />
        <p class="hint" id="undo-comment-hint">
          {w.commentHint}
        </p>
        <div class="actions">
          <Button
            type="submit"
            kind="danger"
            pending={pending}
            pendingLabel={w.undoing}
            blocked={blockedNow(false)}
          >
            {w.confirmUndo}
          </Button>
          <Button kind="quiet" onClick={onClose}>
            {w.cancel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function ChangeScreen({ slug, id }: { slug: string; id: string }) {
  const { brain, gate } = useBrain(slug)
  const r = changeResource(slug, id)
  useFresh(r)
  // The changes still awaiting review, for «Next change» (usability T1, M3).
  const awaiting = changesResource(slug, 'pending_review')
  useFresh(awaiting)
  const [keeping, setKeeping] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [replaced, setReplaced] = useState<
    NonNullable<Extract<UndoAnswer, { undone: unknown }>['overwritten']>
  >([])
  const [error, setError] = useState<ApiError | null>(null)
  const [undoing, setUndoing] = useState(false)
  const status = useRef<HTMLParagraphElement>(null)
  // After Keep or Undo, the keyboard goes to what happened (usability T1, M3).
  useEffect(() => {
    if (said) status.current?.focus()
  }, [said])
  if (!brain) return gate
  const d = r.data.value
  if (!d) {
    return (
      <>
        <p>
          <a href={reviewHref(slug)}>{w.back}</a>
        </p>
        {r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )}
      </>
    )
  }
  const { change, parts } = d
  const nextId = awaiting.data.value?.items.find((c) => c.id !== id)?.id ?? null
  const curator = isCurator(brain)
  const open = change.state === 'pending_review' || change.state === 'partly_undone'
  const keep = async () => {
    if (keeping) return
    setKeeping(true)
    setError(null)
    try {
      const a = await api.call<{ change: Change }>('keepChange', { path: { id } })
      r.data.value = { change: a.change, parts }
      reviewed(slug)
      setSaid(w.kept)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setKeeping(false)
    }
  }
  return (
    <>
      <p>
        <a href={reviewHref(slug)}>{w.back}</a>
      </p>
      <WikiHead title={change.title}>
        <StateTag state={change.state} />
      </WikiHead>
      <p class="meta">{whoLine(change)}</p>
      <FormAlert error={error} />
      <p class="said ok" role="status" tabIndex={-1} ref={status}>
        {said}
        {replaced.map((x) => (
          <span key={x.address} class="replaced">
            {' '}
            {w.replaced(x.revisions, x.address, x.editedBy)}{' '}
            <a href={`${pageHref(slug, x.address)}?view=history`}>{w.pageHistory}</a>
          </span>
        ))}
      </p>
      {said && nextId ? (
        <p>
          <a class="button" href={changeHref(slug, nextId)}>
            {w.next}
          </a>
        </p>
      ) : null}
      {change.comment ? (
        <p class="note undone-why">
          {w.undoneWhy(change.comment)}
          {change.correction ? (
            <>
              {' '}
              <a href={entryHref(slug, change.correction)}>{w.viewCorrection}</a>
            </>
          ) : null}
        </p>
      ) : null}
      {curator && open ? (
        <div class="actions review-actions">
          <Button
            kind="primary"
            pending={keeping}
            pendingLabel={w.keeping}
            blocked={blockedNow(false)}
            onClick={() => void keep()}
          >
            {w.keep}
          </Button>
          <Button onClick={() => setUndoing(true)} blocked={blockedNow(false)}>
            {w.undo}
          </Button>
          <p class="hint">{w.keepHint}</p>
        </div>
      ) : null}
      <section class="card pad" aria-labelledby="parts-title">
        <SectionHead id="parts-title" title={w.partsTitle} meta={w.parts(parts.length)} />
        {parts.map((p) => (
          <PartView key={p.part} slug={slug} p={p} />
        ))}
      </section>
      {curator ? (
        <UndoDialog
          key={String(undoing)}
          open={undoing}
          onClose={() => setUndoing(false)}
          slug={slug}
          change={change}
          parts={parts}
          onDone={(a) => {
            setUndoing(false)
            if ('alreadyUndone' in a) setSaid(w.alreadyUndone)
            else {
              setReplaced(a.overwritten ?? [])
              setSaid(
                [w.undone(a.undone.length), a.discarded.length ? w.discarded(a.discarded.length) : '']
                  .filter(Boolean)
                  .join(' '),
              )
              void r.reload()
            }
          }}
        />
      ) : null}
    </>
  )
}
