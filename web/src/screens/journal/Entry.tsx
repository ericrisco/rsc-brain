// One entry of the journal (spec B6 «Journal › Entry», B1; T023). Who: any member reads; its author or a
// curator corrects, dates and forgets it; a curator pins and recovers; a contributor or more relates it and
// adds a correction. A reader sees no action, and whom to ask. Job: read what was written, by whom and with
// what, and fix it when it is wrong. Done when: the entry says what it should, or is forgotten with a
// reason, and the screen says so. Risk: losing a correction being typed (kept in a draft of this tab, per
// person and entry) and forgetting the wrong thing (a confirmation that says what happens, with a reason).
// The text is markdown rendered with raw HTML off (lib/markdown.ts).
import { signal } from '@preact/signals'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { draft } from '../../api/draft.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import {
  aboutOf,
  byline,
  dayOf,
  entryPowers,
  journalDraftKey,
  mayDecide,
  type RelateChoice,
  relateBody,
  relationWords,
} from '../../lib/journal.ts'
import { pageHref, plainText, renderMarkdown, safeHref } from '../../lib/markdown.ts'
import { focusOnArrival } from '../../lib/screen.ts'
import { me } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { TextArea } from '../../ui/TextArea.tsx'
import type { BrainOne } from '../Brain.tsx'
import { blockedNow, Said, useBrain } from '../wiki/common.tsx'
import { comboOf, EntryList, useEntries } from '../wiki/Suggest.tsx'
import {
  correctHref,
  entryHref,
  JournalNav,
  SessionLink,
  sessionHref,
  sessionsBackHref,
  sessionsHref,
  TypeTag,
} from './common.tsx'
import {
  curatorNames,
  type EntryRead,
  type EntryReading,
  entryResource,
  journalChanged,
  membersResource,
  type Relation,
  type SessionRef,
} from './data.ts'

// What a screen of the journal says after an action, until the person goes elsewhere.
export const journalNotice = signal<{ path: string; text: string } | null>(null)

const accountId = () => me().data.value?.account.id ?? ''

type Mine = { title: string; content: string; base: number }

function useCorrectionDraft(slug: string, id: string) {
  const store = useMemo(
    () =>
      typeof sessionStorage === 'undefined'
        ? null
        : draft(journalDraftKey(accountId(), slug, `entry:${id}`), sessionStorage),
    [slug, id],
  )
  return {
    read(): Mine | null {
      try {
        const v = JSON.parse(store?.get() || 'null') as Mine | null
        return v && typeof v.title === 'string' && typeof v.content === 'string' ? v : null
      } catch {
        return null
      }
    },
    write: (m: Mine) => store?.set(JSON.stringify(m)),
    clear: () => store?.clear(),
  }
}

function Notices({ slug, e }: { slug: string; e: EntryRead }) {
  const j = T.journal
  const out = []
  if (e.state === 'forgotten' && e.forgotten)
    out.push(
      <p key="f" class="alert warn" role="note">
        <span class="kind">{j.forgotten}</span>
        <span>{j.stateForgotten(e.forgotten.by.name, T.date(e.forgotten.at), e.forgotten.reason)}</span>
      </p>,
    )
  if (e.state === 'purged')
    out.push(
      <p key="p" class="alert warn" role="note">
        <span>{j.statePurged}</span>
      </p>,
    )
  if (e.supersededBy)
    out.push(
      <p key="s" class="alert warn" role="note">
        <span>
          {j.superseded} <a href={entryHref(slug, e.supersededBy)}>{j.replacement}</a>.
        </span>
      </p>,
    )
  if (e.type === 'correction')
    out.push(
      <p key="c" class="alert" role="note">
        <span>{j.correctionNote}</span>
      </p>,
    )
  if (e.expiresAt && e.expiresAt <= new Date().toISOString())
    out.push(
      <p key="x" class="alert warn" role="note">
        <span>{j.expired(T.date(e.expiresAt))}</span>
      </p>,
    )
  return <>{out}</>
}

function Refs({ slug, refs }: { slug: string; refs: string[] }) {
  const j = T.journal
  const a = aboutOf(refs)
  if (!a.page && !a.entry && !a.rest.length) return null
  return (
    <>
      {a.page || a.entry ? (
        <p class="meta">
          {j.about}{' '}
          {a.page ? (
            <>
              {j.aboutPage}{' '}
              <a href={pageHref(slug, a.page)} class="mono">
                {a.page}
              </a>
            </>
          ) : (
            <>
              {j.aboutEntry} <a href={entryHref(slug, a.entry as string)}>{a.entry}</a>
            </>
          )}
        </p>
      ) : null}
      {a.rest.length ? (
        <section aria-labelledby="entry-refs">
          <h2 id="entry-refs" class="section-title">
            {j.refs}
          </h2>
          <ul class="plain refs">
            {a.rest.map((r) => (
              <li key={r}>
                {/^https?:\/\//i.test(r) && safeHref(r) ? (
                  <a href={r} target="_blank" rel="noopener noreferrer">
                    {r}
                  </a>
                ) : (
                  <span class="mono">{r}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

function Facts({ slug, e, session }: { slug: string; e: EntryRead; session: SessionRef }) {
  const j = T.journal
  return (
    <section class="aside-block" aria-labelledby="entry-facts">
      <h2 id="entry-facts" class="section-title">
        {j.entryFacts}
      </h2>
      <dl class="facts">
        <dt>{j.wroteBy}</dt>
        <dd>{byline(e)}</dd>
        <dt>{j.when}</dt>
        <dd class="mono">{T.dateTime(e.createdAt)}</dd>
        <dt>{j.revisionTerm}</dt>
        <dd>
          {j.revisionLine(e.revision, T.date(e.updatedAt))}
          {e.repeatCount > 1 ? <span class="meta"> · {j.repeated(e.repeatCount)}</span> : null}
        </dd>
        {e.topic ? (
          <>
            <dt>{j.topic}</dt>
            <dd class="mono">{e.topic}</dd>
          </>
        ) : null}
        {e.type === 'correction' || e.appliesTo ? (
          <>
            <dt>{j.appliesTo}</dt>
            <dd>{e.appliesTo ?? j.everyone}</dd>
          </>
        ) : null}
        <dt>{j.in}</dt>
        <dd>
          <SessionLink slug={slug} s={session} />
        </dd>
        {e.reviewAfter ? (
          <>
            <dt>{j.reviewField}</dt>
            <dd>{T.date(e.reviewAfter)}</dd>
          </>
        ) : null}
        {e.expiresAt ? (
          <>
            <dt>{j.expiresField}</dt>
            <dd>{T.date(e.expiresAt)}</dd>
          </>
        ) : null}
      </dl>
      {e.pinned ? <p class="small">{j.pinned}</p> : null}
    </section>
  )
}

function Relations({ slug, relations }: { slug: string; relations: Relation[] }) {
  const j = T.journal
  return (
    <section class="aside-block" aria-labelledby="entry-relations">
      <h2 id="entry-relations" class="section-title">
        {j.relations}
      </h2>
      {relations.length === 0 ? (
        <p class="muted small">{j.noRelations}</p>
      ) : (
        <ul class="plain relations">
          {relations.map((r) => (
            <li key={r.id}>
              <span>{relationWords(r)} </span>
              {r.other.title !== null ? (
                <a href={entryHref(slug, r.other.id)}>{r.other.title}</a>
              ) : (
                <span class="muted">{r.other.state === 'purged' ? j.aPurgedEntry : j.aForgottenEntry}</span>
              )}
              <span class="meta">
                {' '}
                · {r.by.name}, {T.date(r.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function History({ reading }: { reading: EntryReading }) {
  const j = T.journal
  const revs = reading.history ?? []
  return (
    <section class="aside-block" aria-labelledby="entry-history">
      <h2 id="entry-history" class="section-title">
        {j.history}
      </h2>
      {revs.length <= 1 ? (
        <p class="muted small">{j.noHistory}</p>
      ) : (
        <ol class="plain history" reversed>
          {[...revs].reverse().map((r) => (
            <li key={r.revision}>
              <details>
                <summary class="rev">
                  {j.revisionBy(r.revision, r.authorName, T.dateTime(r.createdAt))}
                </summary>
                <p class="list-title">{r.title}</p>
                <p class="entry-text small">{plainText(r.content)}</p>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

// focus: the person just asked to edit, so the keyboard goes to the title (a draft brought back by a
// reload leaves the keyboard where the screen put it).
function CorrectForm({
  slug,
  e,
  focus,
  onDone,
  onCancel,
}: {
  slug: string
  e: EntryRead
  focus: boolean
  onDone: (text: string) => void
  onCancel: () => void
}) {
  const j = T.journal
  const store = useCorrectionDraft(slug, e.id)
  const kept = store.read()
  const [mine, setMine] = useState<Mine>(kept ?? { title: e.title, content: e.content, base: e.revision })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [theirs, setTheirs] = useState<{ title: string; content: string; revision: number } | null>(null)
  const dirty = mine.title !== e.title || mine.content !== e.content
  useEffect(() => {
    if (focus) focusOnArrival(document.getElementById('correct-entry-title'))
  }, [])
  // What is typed goes to the draft at once, not after the next paint: a reload right after typing keeps it.
  const type = (next: Mine) => {
    setMine(next)
    if (next.title !== e.title || next.content !== e.content) store.write(next)
    else store.clear()
  }
  // Kept, never cleared here: this runs after a paint with the entry it last saw, and a draft is let go
  // only when the person does it (typing back to the text, Cancel, or a save).
  useEffect(() => {
    if (dirty || theirs) store.write(mine)
  }, [mine.title, mine.content, mine.base, Boolean(theirs)])
  useEffect(() => {
    if (!dirty) return
    const ask = (ev: BeforeUnloadEvent) => ev.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [dirty])
  const send = async (base: number) => {
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ entry: { revision: number } }>('editEntry', {
        path: { id: e.id },
        body: { baseRevision: base, title: mine.title, content: mine.content },
      })
      store.clear()
      setTheirs(null)
      journalChanged(slug)
      onDone(j.saved(r.entry.revision))
    } catch (x) {
      const err = x as ApiError
      if (err.code === 'entry_changed') {
        const c = err.current as { title?: string; content?: string; revision?: number } | undefined
        setTheirs({ title: c?.title ?? '', content: c?.content ?? '', revision: c?.revision ?? base + 1 })
        setMine({ ...mine, base })
        journalChanged(slug)
      } else setError(err)
    } finally {
      setPending(false)
    }
  }
  const blocked = blockedNow(pending)
  return (
    <form
      class="form edit-block"
      aria-labelledby="correct-title"
      onSubmit={(ev) => {
        ev.preventDefault()
        if (!theirs) void send(mine.base)
      }}
    >
      <h3 id="correct-title">{j.correct}</h3>
      <p class="muted small">{j.correctLead}</p>
      {theirs ? (
        <div class="alert warn" role="alert">
          <span class="kind">{T.kind.warning}</span>
          <span>
            <strong>{j.changedTitle}.</strong> {j.changedLead(theirs.revision)}
          </span>
          <div class="versions">
            <div>
              <h4>{j.theirs}</h4>
              <p class="list-title">{theirs.title}</p>
              <p class="entry-text small">{plainText(theirs.content)}</p>
            </div>
          </div>
          <p class="actions">
            <Button
              kind="primary"
              pending={pending}
              pendingLabel={j.saving}
              blocked={blockedNow(false)}
              onClick={() => void send(theirs.revision)}
            >
              {j.saveMine}
            </Button>
            <Button
              onClick={() => {
                setMine({ title: theirs.title, content: theirs.content, base: theirs.revision })
                setTheirs(null)
                store.clear()
              }}
            >
              {j.startTheirs}
            </Button>
          </p>
        </div>
      ) : null}
      <div class="field">
        <label for="correct-entry-title">{j.titleField}</label>
        <input
          id="correct-entry-title"
          type="text"
          maxLength={200}
          value={mine.title}
          onInput={(ev) => type({ ...mine, title: (ev.currentTarget as HTMLInputElement).value })}
        />
      </div>
      <TextArea
        label={theirs ? j.yours : j.contentField}
        hint={j.contentHint}
        rows={8}
        value={mine.content}
        onValue={(v) => type({ ...mine, content: v })}
        onKeyDown={(ev) => {
          // Ctrl+Enter / ⌘ Enter saves from the text, as in the wiki's editor.
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !theirs) {
            ev.preventDefault()
            void send(mine.base)
          }
        }}
        aria-keyshortcuts="Control+Enter Meta+Enter"
      />
      <FormAlert error={error} />
      {theirs ? null : (
        <p class="actions">
          <Button type="submit" kind="primary" pending={pending} pendingLabel={j.saving} blocked={blocked}>
            {j.save}
          </Button>
          <Button
            kind="quiet"
            onClick={() => {
              store.clear()
              onCancel()
            }}
          >
            {j.cancel}
          </Button>
        </p>
      )}
    </form>
  )
}

function ForgetDialog({
  open,
  e,
  onClose,
  onDone,
}: {
  open: boolean
  e: EntryRead
  onClose: () => void
  onDone: () => void
}) {
  const j = T.journal
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const go = async () => {
    if (!reason.trim()) {
      setProblem(j.reasonNeeded)
      document.querySelector<HTMLTextAreaElement>('dialog[open] textarea')?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      await api.call('forgetEntry', { path: { id: e.id }, body: { reason: reason.trim() } })
      setReason('')
      onDone()
    } catch (x) {
      setError(x as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} title={j.forgetTitle} onClose={onClose} closeLabel={j.cancel}>
      <form
        class="form"
        onSubmit={(ev) => {
          ev.preventDefault()
          void go()
        }}
      >
        <p>
          <strong>{e.title}</strong>
        </p>
        <p class="muted">{j.forgetLead}</p>
        <TextArea
          autoFocus
          label={j.reason}
          hint={j.reasonHint}
          problem={problem}
          maxLength={500}
          value={reason}
          onValue={(v) => {
            setReason(v)
            if (v.trim()) setProblem(null)
          }}
        />
        <FormAlert error={error} />
        <p class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={j.forgetting}
            blocked={blockedNow(pending)}
          >
            {j.forgetConfirm}
          </Button>
          <Button kind="quiet" onClick={onClose}>
            {j.cancel}
          </Button>
        </p>
      </form>
    </Dialog>
  )
}

const CHOICES: RelateChoice[] = ['contradicts', 'supersedes', 'superseded', 'not_related']

function RelateDialog({
  open,
  slug,
  e,
  role,
  onClose,
  onDone,
}: {
  open: boolean
  slug: string
  e: EntryRead
  role: string
  onClose: () => void
  onDone: (text: string) => void
}) {
  const j = T.journal
  const [choice, setChoice] = useState<RelateChoice>('contradicts')
  const [text, setText] = useState('')
  const [other, setOther] = useState<{ id: string; title: string } | null>(null)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const look = useEntries(slug)
  // Replacing this entry, or dismissing it when it is a correction, is for its author or a curator; the
  // other entry's author is known once the server answers (a refusal says why and whom to ask).
  const who = { role, me: accountId(), archived: false }
  const mine = mayDecide(e, who)
  const curator = role === 'curator'
  const off = (c: RelateChoice) =>
    !mine && (c === 'superseded' || (c === 'not_related' && e.type === 'correction'))
  const go = async () => {
    if (!other) {
      setProblem(j.otherNeeded)
      document.getElementById('relate-other')?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ relation: { status: string } }>('relate', {
        path: { slug },
        body: { ...relateBody(choice, e.id, other.id), ...(reason.trim() ? { reason: reason.trim() } : {}) },
      })
      setOther(null)
      setText('')
      setReason('')
      onDone(r.relation.status === 'pending_person' ? j.relatedWaits : j.related)
    } catch (x) {
      setError(x as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} title={j.relateTitle} onClose={onClose} closeLabel={j.cancel}>
      <form
        class="form"
        onSubmit={(ev) => {
          ev.preventDefault()
          void go()
        }}
      >
        <p class="muted">{j.relateLead}</p>
        <fieldset class="choice">
          <legend>{j.relateHow}</legend>
          {CHOICES.map((c) => (
            <label key={c} class="radio">
              <input
                type="radio"
                name="relate-how"
                value={c}
                checked={choice === c}
                disabled={off(c)}
                // The dialog opens on what it asks first, not on its Cancel.
                autoFocus={choice === c}
                onChange={() => setChoice(c)}
              />
              <span>{j.relateChoices[c]}</span>
            </label>
          ))}
          {curator ? null : <p class="hint">{j.relateWho}</p>}
        </fieldset>
        <div class="field suggest-host">
          <label for="relate-other">{j.otherEntry}</label>
          <span id="relate-other-hint" class="hint">
            {other ? j.otherPicked(other.title) : j.otherHint}
          </span>
          <input
            id="relate-other"
            type="search"
            autocomplete="off"
            value={text}
            aria-describedby={`relate-other-hint${problem ? ' relate-other-problem' : ''}`}
            aria-invalid={problem ? 'true' : undefined}
            {...comboOf(look)}
            onInput={(ev) => {
              const v = (ev.currentTarget as HTMLInputElement).value
              setText(v)
              setOther(null)
              look.ask(v)
            }}
            onFocus={() => look.ask(text)}
            onBlur={() => look.close()}
            onKeyDown={(ev) => {
              const pick = (x: { id: string; title: string }) => {
                setOther({ id: x.id, title: x.title })
                setText(x.title)
                setProblem(null)
                look.close()
              }
              if (look.key(ev, pick)) {
                ev.preventDefault()
                return
              }
              // Enter in this field picks or does nothing: it never sends the form.
              if (ev.key === 'Enter') ev.preventDefault()
            }}
          />
          <EntryList
            s={{ ...look, items: look.items.filter((x) => x.id !== e.id) }}
            onPick={(x) => {
              setOther({ id: x.id, title: x.title })
              setText(x.title)
              setProblem(null)
              look.close()
            }}
          />
          {problem ? (
            <span id="relate-other-problem" class="problem">
              {problem}
            </span>
          ) : null}
        </div>
        <TextArea label={j.relationReason} rows={2} maxLength={500} value={reason} onValue={setReason} />
        <FormAlert error={error} />
        <p class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={j.saving}
            blocked={blockedNow(pending)}
          >
            {j.saveRelation}
          </Button>
          <Button kind="quiet" onClick={onClose}>
            {j.cancel}
          </Button>
        </p>
      </form>
    </Dialog>
  )
}

function DatesForm({ e, onDone }: { e: EntryRead; onDone: (text: string) => void }) {
  const j = T.journal
  const [review, setReview] = useState(dayOf(e.reviewAfter))
  const [expires, setExpires] = useState(dayOf(e.expiresAt))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  // Folded until needed: the dates are the least used action, and an open form crowds the others.
  return (
    <details class="filter-box" open={Boolean(e.reviewAfter || e.expiresAt) || undefined}>
      <summary>{j.dates}</summary>
      <form
        class="form"
        aria-label={j.dates}
        onSubmit={async (ev) => {
          ev.preventDefault()
          setPending(true)
          setError(null)
          try {
            await api.call('scheduleEntry', {
              path: { id: e.id },
              body: { reviewAfter: review || null, expiresAt: expires || null },
            })
            onDone(j.datesSaved)
          } catch (x) {
            setError(x as ApiError)
          } finally {
            setPending(false)
          }
        }}
      >
        <p class="muted small">{j.datesLead}</p>
        <div class="row-fields">
          <div class="field">
            <label for="entry-review">{j.reviewField}</label>
            <input
              id="entry-review"
              type="date"
              value={review}
              aria-describedby="entry-date-hint"
              onInput={(ev) => setReview((ev.currentTarget as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="entry-expires">{j.expiresField}</label>
            <input
              id="entry-expires"
              type="date"
              value={expires}
              aria-describedby="entry-date-hint"
              onInput={(ev) => setExpires((ev.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </div>
        <span id="entry-date-hint" class="hint">
          {j.dateHint}
        </span>
        <FormAlert error={error} />
        <p class="actions">
          <Button type="submit" pending={pending} pendingLabel={j.saving} blocked={blockedNow(pending)}>
            {j.saveDates}
          </Button>
        </p>
      </form>
    </details>
  )
}

function Actions({
  slug,
  brain,
  e,
  onSaid,
}: {
  slug: string
  brain: BrainOne
  e: EntryRead
  onSaid: (text: string, tone?: 'ok' | 'error', focus?: boolean) => void
}) {
  const j = T.journal
  const { route } = useLocation()
  const p = entryPowers(e, { role: brain.role, me: accountId(), archived: brain.status === 'archived' })
  const store = useCorrectionDraft(slug, e.id)
  const [editing, setEditing] = useState(() => store.read() !== null)
  const [asked, setAsked] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [relating, setRelating] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const curators = curatorNames(slug)
  const any = Object.values(p).some(Boolean)
  const act = async (name: 'pinEntry' | 'unpinEntry' | 'recoverEntry', said: string) => {
    setPending(name)
    try {
      await api.call(name, { path: { id: e.id } })
      journalChanged(slug)
      // Recovering takes its button away: the keyboard goes to what happened.
      onSaid(said, 'ok', name === 'recoverEntry')
    } catch (x) {
      const err = x as ApiError
      onSaid(`${err.message} ${err.howToProceed}`, 'error')
    } finally {
      setPending(null)
    }
  }
  if (!any) {
    const why =
      brain.status === 'archived'
        ? j.archived
        : brain.role === 'reader'
          ? j.noActions(brain.name, curators)
          : e.state === 'active'
            ? j.notYours
            : null
    return why ? (
      <section class="aside-block" aria-labelledby="entry-actions">
        <h2 id="entry-actions" class="section-title">
          {j.actions}
        </h2>
        <p class="muted small" data-state="no-actions">
          {why}
        </p>
      </section>
    ) : null
  }
  return (
    <section class="entry-actions" aria-labelledby="entry-actions">
      <h2 id="entry-actions" class="section-title">
        {j.actions}
      </h2>
      <p class="actions wrap">
        {p.correct && !editing ? (
          <Button
            kind="primary"
            onClick={() => {
              setAsked(true)
              setEditing(true)
            }}
          >
            {j.correct}
          </Button>
        ) : null}
        {p.pin ? (
          <Button
            pending={pending === 'pinEntry' || pending === 'unpinEntry'}
            pendingLabel={j.saving}
            blocked={blockedNow(false)}
            aria-pressed={e.pinned ? 'true' : 'false'}
            onClick={() =>
              void act(e.pinned ? 'unpinEntry' : 'pinEntry', e.pinned ? j.unpinnedNow : j.pinnedNow)
            }
          >
            {e.pinned ? j.unpin : j.pin}
          </Button>
        ) : null}
        {p.relate ? <Button onClick={() => setRelating(true)}>{j.relate}</Button> : null}
        {p.addCorrection && e.state === 'active' ? (
          <a class="button secondary" href={correctHref(slug, { entry: e.id })}>
            {j.addCorrectionHere}
          </a>
        ) : null}
        {p.recover ? (
          <Button
            kind="primary"
            pending={pending === 'recoverEntry'}
            pendingLabel={j.recovering}
            blocked={blockedNow(false)}
            aria-label={`${j.recover}: ${e.title}`}
            onClick={() => void act('recoverEntry', j.recovered)}
          >
            {j.recover}
          </Button>
        ) : null}
        {p.forget ? (
          <Button kind="quiet" onClick={() => setForgetting(true)}>
            {j.forget}
          </Button>
        ) : null}
      </p>
      {p.pin ? <p class="muted small">{j.pinLead}</p> : null}
      {p.correct && editing ? (
        <CorrectForm
          slug={slug}
          e={e}
          focus={asked}
          onCancel={() => setEditing(false)}
          onDone={(text) => {
            setEditing(false)
            onSaid(text)
          }}
        />
      ) : null}
      {p.schedule ? (
        <DatesForm
          key={`${e.reviewAfter}|${e.expiresAt}`}
          e={e}
          onDone={(t) => {
            journalChanged(slug)
            onSaid(t)
          }}
        />
      ) : null}
      {p.forget ? (
        <ForgetDialog
          open={forgetting}
          e={e}
          onClose={() => setForgetting(false)}
          onDone={() => {
            setForgetting(false)
            journalChanged(slug)
            if (brain.role === 'curator') onSaid(j.forgottenNow, 'ok', true)
            else {
              // Only curators read forgotten entries: the person goes back to the session it was in.
              const to = sessionHref(slug, e.sessionId)
              journalNotice.value = { path: to, text: j.forgottenNow }
              route(to)
            }
          }}
        />
      ) : null}
      {p.relate ? (
        <RelateDialog
          open={relating}
          slug={slug}
          e={e}
          role={brain.role}
          onClose={() => setRelating(false)}
          onDone={(t) => {
            setRelating(false)
            journalChanged(slug)
            onSaid(t)
          }}
        />
      ) : null}
    </section>
  )
}

export function JournalEntry({ slug, id }: { slug: string; id: string }) {
  const { brain, gate } = useBrain(slug)
  const r = entryResource(slug, id)
  useFresh(r)
  membersResource(slug)
  const { path } = useLocation()
  const [said, setSaid] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  useEffect(() => {
    setSaid(null)
  }, [id])
  if (!brain) return gate
  const j = T.journal
  const reading = r.data.value
  if (!reading) {
    if (r.error.value?.code === 'not_found')
      return (
        <>
          <h1 class="title">{j.noEntry}</h1>
          <p class="lead">{j.noEntryLead}</p>
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
      <Skeleton rows={5} />
    )
  }
  const e = reading.entry
  const session = reading.session
  const notice = journalNotice.value?.path === path ? journalNotice.value.text : null
  const html = renderMarkdown(e.content, { slug, links: [] })
  return (
    <>
      <nav class="crumbs" aria-label={j.title}>
        <a href={sessionsBackHref(slug)}>{j.sessionCrumb}</a>
        <span aria-hidden="true"> / </span>
        <SessionLink slug={slug} s={session} />
      </nav>
      <div class="title-row start">
        <h1 class="title">{e.title || e.id}</h1>
      </div>
      <p class="page-meta meta">
        <TypeTag type={e.type} />{' '}
        {e.state !== 'active' ? (
          <span class="tag warn">{e.state === 'forgotten' ? j.forgotten : j.purgedTag}</span>
        ) : null}{' '}
        {e.pinned ? <span class="tag">{j.pinnedTag}</span> : null} <span>{byline(e)}</span>{' '}
        <span class="mono">{T.date(e.createdAt)}</span>
      </p>
      {/* Its own «Add a correction about this entry» is among its actions: one is enough. */}
      <JournalNav brain={brain} correct={false} />
      <Said text={said?.text ?? notice} tone={said?.tone ?? 'ok'} />
      {r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
      ) : null}
      <div class="wiki-page">
        <article class="page-main">
          <Notices slug={slug} e={e} />
          {/* The one HTML the web did not build itself: markdown with raw HTML off (lib/markdown.ts). */}
          <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />
          {e.tags.length ? (
            <p class="meta tags">
              {e.tags.map((t) => (
                <span key={t} class="tag">
                  {t}
                </span>
              ))}
            </p>
          ) : null}
          <Refs slug={slug} refs={e.refs} />
          <Actions
            slug={slug}
            brain={brain}
            e={e}
            onSaid={(text, tone = 'ok', focus = false) => {
              setSaid({ text, tone })
              // Forget and Recover take their button away: the keyboard goes to what happened, which a
              // screen reader reads. Otherwise only a button that is gone sends it to the heading.
              requestAnimationFrame(() => {
                const said = document.querySelector<HTMLElement>('main .said')
                if (focus && said) {
                  if (!said.hasAttribute('tabindex')) said.setAttribute('tabindex', '-1')
                  focusOnArrival(said)
                  return
                }
                const a = document.activeElement
                if (a && a !== document.body && a.isConnected) return
                const h = document.querySelector<HTMLElement>('main h1')
                if (!h) return
                if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
                h.focus()
              })
            }}
          />
        </article>
        <aside class="page-aside" aria-label={j.entryFacts}>
          <Facts slug={slug} e={e} session={session} />
          <Relations slug={slug} relations={reading.relations} />
          <History reading={reading} />
        </aside>
      </div>
    </>
  )
}
