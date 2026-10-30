// A curator edits a wiki page by hand (spec B6 «Wiki › Page», B2 «Editar a mano», CA10; T019). Who: a
// curator, in the web (a token is refused by the server: agents propose). Job: correct a page — its
// words, sources, status or address — or go back to an older revision (History). Done when: the page
// shows the change and says «Saved as revision N». Risk: losing what was typed. One «Save changes» sends
// every part that changed: the content first, against the revision read (the one conflict check), then
// the status, then the address. If the page moved on, nothing is saved, what the other person changed is
// shown with who did it, and the result of keeping both is shown before anything is saved. What is typed
// lives in a draft of this tab, kept per person and page (never a secret) and gone when the session is,
// so a reload or a lost connection loses nothing and a page left with changes says they are not saved.
// Typed links are a list of their own: each one is added or removed at once.
import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { draft } from '../../api/draft.ts'
import { api } from '../../api/index.ts'
import { renderMarkdown } from '../../lib/markdown.ts'
import {
  canRebase,
  completeAt,
  completionAt,
  draftKeyOf,
  type Editable,
  editChanges,
  LINK_KINDS,
  merge3,
  mergeList,
  PAGE_STATUSES,
  PAGE_TYPES,
  parseTags,
  type Source,
  sourceKey,
  wordDiff,
} from '../../lib/wiki.ts'
import { me } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { CopyButton } from '../../ui/CopyButton.tsx'
import { Field } from '../../ui/Field.tsx'
import { Empty, FormAlert } from '../../ui/states.tsx'
import type { BrainOne } from '../Brain.tsx'
import { blockedNow, isCurator, pageHref } from './common.tsx'
import { type Changed, pageChanged, type Reading, wikiChanged } from './data.ts'
import { BodyDiff, ListDiff } from './History.tsx'
import { comboOf, EntryList, SuggestList, useEntries, useSuggest } from './Suggest.tsx'

// What the page says after a change made from here, until the person goes elsewhere.
export const wikiNotice = signal<{ path: string; text: string } | null>(null)

type Link = { kind: string; to: string }
type Form = {
  type: string
  title: string
  summary: string
  tags: string
  body: string
  sources: Source[]
  status: string
  by: string
  address: string
}
type Base = Editable & { revision: number; status: string; by: string; address: string; links: Link[] }
type Saved = { base: Base; form: Form; mine: string | null; reason: string }

// The page that replaces a superseded one, by address (the reading names it in its notice).
const byOf = (r: Reading) =>
  /superseded by "([^"]+)"/.exec(r.notice ?? '')?.[1] ??
  r.links.in.find((l) => l.kind === 'supersedes')?.address ??
  ''

const editableOf = (r: Reading): Base => ({
  revision: r.page.revision,
  type: r.page.type,
  title: r.page.title,
  summary: r.page.summary,
  body: r.page.body,
  tags: r.page.tags,
  // A forgotten or purged source keeps its place; the edit keeps it unless removed.
  sources: r.sources.map((s) =>
    'entryId' in s ? { entryId: s.entryId } : { url: s.url, ...(s.title ? { title: s.title } : {}) },
  ),
  status: r.page.status,
  by: r.page.status === 'superseded' ? byOf(r) : '',
  address: r.page.address,
  links: r.links.out.filter((l) => l.kind !== 'mentions').map((l) => ({ kind: l.kind, to: l.address })),
})
const formOf = (b: Base): Form => ({
  type: b.type,
  title: b.title,
  summary: b.summary,
  tags: b.tags.join(', '),
  body: b.body,
  sources: b.sources,
  status: b.status,
  by: b.by,
  address: b.address,
})
const asEditable = (f: Form): Editable => ({
  type: f.type,
  title: f.title,
  summary: f.summary,
  tags: parseTags(f.tags),
  body: f.body,
  sources: f.sources,
})

// The status change a form asks for, or null (choosing the status the page has is no change).
function statusOp(b: Base, f: Form): Record<string, unknown> | null {
  const by = f.by.trim()
  if (f.status === b.status && (f.status !== 'superseded' || by === b.by)) return null
  return f.status === 'superseded' && by
    ? { op: 'status', address: b.address, status: f.status, supersededBy: by }
    : { op: 'status', address: b.address, status: f.status }
}
const moveTo = (b: Base, f: Form) => {
  const to = f.address.trim()
  return to && to !== b.address ? to : null
}
const changed = (b: Base, f: Form) =>
  editChanges(b, asEditable(f)) !== null || statusOp(b, f) !== null || moveTo(b, f) !== null

const accountId = () => me().data.value?.account.id ?? ''

// Where the caret's line is inside a text field (its top and bottom, from the field's top, as shown):
// a copy of the field's text up to the caret, laid out the same way, measured, and removed.
function caretBox(el: HTMLTextAreaElement): { top: number; bottom: number } {
  const cs = getComputedStyle(el)
  const copy = document.createElement('div')
  for (const k of [
    'font',
    'lineHeight',
    'padding',
    'border',
    'boxSizing',
    'letterSpacing',
    'tabSize',
  ] as const)
    copy.style[k] = cs[k]
  copy.style.width = `${el.clientWidth}px`
  copy.style.position = 'absolute'
  copy.style.visibility = 'hidden'
  copy.style.whiteSpace = 'pre-wrap'
  copy.style.overflowWrap = 'break-word'
  copy.textContent = el.value.slice(0, el.selectionStart)
  const mark = document.createElement('span')
  mark.textContent = '​'
  copy.append(mark)
  document.body.append(copy)
  const top = mark.offsetTop - el.scrollTop
  const bottom = top + (Number.parseFloat(cs.lineHeight) || mark.offsetHeight)
  copy.remove()
  return { top, bottom }
}

// The tab's draft of this page's edit (sessionStorage: it goes with the tab), kept per person.
function useDraft(account: string, slug: string, pageId: string) {
  return useMemo(() => {
    const store = typeof sessionStorage === 'undefined' ? null : sessionStorage
    const d = store && account ? draft(draftKeyOf(account, slug, pageId), store) : null
    return {
      read(): Saved | null {
        try {
          const v = JSON.parse(d?.get() || 'null') as Saved | null
          return v &&
            typeof v.form?.body === 'string' &&
            typeof v.form?.status === 'string' &&
            typeof v.base?.revision === 'number'
            ? v
            : null
        } catch {
          return null
        }
      },
      write: (v: Saved) => d?.set(JSON.stringify(v)),
      clear: () => d?.clear(),
    }
  }, [account, slug, pageId])
}

// On the page (read or history) of a page left with changes not saved: says so and leads back.
export function UnsavedEdit({ slug, reading }: { slug: string; reading: Reading }) {
  const store = useDraft(accountId(), slug, reading.page.id)
  const saved = store.read()
  if (!saved || (!changed(saved.base, saved.form) && saved.mine === null)) return null
  return (
    <p class="alert warn" role="note">
      <span class="kind">{T.wiki.unsavedKind}</span>
      <span>
        {T.wiki.unsaved} <a href={`${pageHref(slug, reading.page.address)}?view=edit`}>{T.wiki.backToEdit}</a>
      </span>
    </p>
  )
}

function Problems({ error }: { error: ApiError | null }) {
  if (!error) return null
  if (!error.problems.length) return <FormAlert error={error} />
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

function SourcesEditor({
  slug,
  sources,
  titles,
  onChange,
}: {
  slug: string
  sources: Source[]
  titles: Map<string, string>
  onChange: (s: Source[], title?: [string, string]) => void
}) {
  const w = T.wiki
  const [entry, setEntry] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const entries = useEntries(slug)
  const put = (n: Source, named?: [string, string]) => {
    setProblem(null)
    if (!sources.some((s) => sourceKey(s) === sourceKey(n))) onChange([...sources, n], named)
    setEntry('')
    setUrl('')
    setTitle('')
    entries.close()
  }
  const add = () => {
    const e = entry.trim()
    const u = url.trim()
    if (e && /^ent_[A-Za-z0-9_-]+$/.test(e)) return put({ entryId: e })
    if (!e && /^https?:\/\/\S+$/i.test(u))
      return put(title.trim() ? { url: u, title: title.trim() } : { url: u })
    setProblem(e ? w.sourcePick : w.sourceBad)
  }
  // Enter in a source field adds the source; it never sends the whole page.
  const enter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    add()
  }
  const named = (s: Source) =>
    'entryId' in s ? (titles.get(s.entryId) ?? w.untitledEntry) : (s.title ?? s.url)
  return (
    <fieldset class="sources-edit" aria-labelledby="sources-legend">
      <legend id="sources-legend">{w.sources}</legend>
      <p class="hint">{w.sourcesHint}</p>
      {sources.length ? (
        <ul class="plain">
          {sources.map((s) => (
            <li key={sourceKey(s)} class="row">
              <span>{named(s)}</span>
              <span class="meta mono"> {'entryId' in s ? s.entryId : s.title ? s.url : ''}</span>
              <button
                type="button"
                class="button quiet"
                onClick={() => onChange(sources.filter((x) => sourceKey(x) !== sourceKey(s)))}
              >
                {w.remove}
                <span class="sr-only"> {named(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">{w.noSources}</p>
      )}
      <div class="source-add">
        <div class="field grow suggest-host">
          <label for="source-entry">{w.addEntry}</label>
          <span id="source-entry-hint" class="hint">
            {w.addEntryHint}
          </span>
          <input
            id="source-entry"
            type="text"
            value={entry}
            autoComplete="off"
            aria-describedby={problem ? 'source-entry-hint source-entry-problem' : 'source-entry-hint'}
            aria-invalid={problem ? 'true' : undefined}
            {...comboOf(entries)}
            onInput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value
              setEntry(v)
              entries.ask(v.trim() && !/^ent_/.test(v.trim()) ? v.trim() : null)
            }}
            onFocus={() => {
              if (!entry.trim()) entries.ask('')
            }}
            onKeyDown={(e) => {
              if (entries.key(e, (x) => put({ entryId: x.id }, [x.id, x.title]))) e.preventDefault()
              else enter(e)
            }}
            onBlur={() => entries.close()}
          />
          {problem ? (
            <span id="source-entry-problem" class="problem">
              {problem}
            </span>
          ) : null}
          <EntryList s={entries} onPick={(x) => put({ entryId: x.id }, [x.id, x.title])} />
        </div>
        <Field
          label={w.addUrl}
          hint={w.addUrlHint}
          value={url}
          onValue={setUrl}
          type="url"
          onKeyDown={(e) => enter(e as unknown as KeyboardEvent)}
        />
        <Field
          label={w.addUrlTitle}
          value={title}
          onValue={setTitle}
          onKeyDown={(e) => enter(e as unknown as KeyboardEvent)}
        />
        <p class="actions">
          <Button onClick={add}>{w.addSource}</Button>
        </p>
      </div>
    </fieldset>
  )
}

type Part = 'title' | 'summary' | 'type' | 'status' | 'address' | 'body'
type Choice = 'both' | 'mine' | 'theirs'

// Saving over a newer revision (CA10, review of PR19): what only one side changed is kept; lists (tags,
// sources) keep both sides' additions and the removals the other side did not touch; where both changed
// the same part, «Keep both» when a line merge works (the body), else the person picks a version. The
// result is shown before it is saved.
function Conflict({
  base,
  current,
  form,
  onSave,
  onTheirs,
  pending,
}: {
  base: Base
  current: Reading
  form: Form
  onSave: (result: Form, theirs: Base) => void
  onTheirs: () => void
  pending: boolean
}) {
  const w = T.wiki
  const ref = useRef<HTMLElement>(null)
  useEffect(() => ref.current?.focus(), [current.page.revision])
  const theirs = editableOf(current)
  const mineTags = parseTags(form.tags)
  const value = (x: Base | Form, p: Part) => (p === 'status' ? `${x.status}${x.by ? ` ${x.by}` : ''}` : x[p])
  const parts: Part[] = ['title', 'summary', 'type', 'status', 'address', 'body']
  const merged = merge3(base.body, form.body, theirs.body)
  const clash = parts.filter((p) => {
    const b = value(base, p)
    const m = value(form, p)
    const t = value(theirs, p)
    return m !== b && t !== b && m !== t
  })
  const [choice, setChoice] = useState<Partial<Record<Part, Choice>>>(
    merged.ok && clash.includes('body') ? { body: 'both' } : {},
  )
  const pick = (p: Part): 'mine' | 'theirs' | 'both' =>
    clash.includes(p) ? (choice[p] ?? 'theirs') : value(form, p) !== value(base, p) ? 'mine' : 'theirs'
  const open = clash.filter((p) => !choice[p])
  const result: Form = {
    type: pick('type') === 'mine' ? form.type : theirs.type,
    title: pick('title') === 'mine' ? form.title : theirs.title,
    summary: pick('summary') === 'mine' ? form.summary : theirs.summary,
    body:
      pick('body') === 'both' && merged.ok ? merged.text : pick('body') === 'mine' ? form.body : theirs.body,
    status: pick('status') === 'mine' ? form.status : theirs.status,
    by: pick('status') === 'mine' ? form.by : theirs.by,
    address: pick('address') === 'mine' ? form.address : theirs.address,
    tags: mergeList(base.tags, mineTags, theirs.tags, (x) => x).join(', '),
    sources: mergeList(base.sources, form.sources, theirs.sources, sourceKey),
  }
  const shown = (p: Part, x: Base | Form) =>
    p === 'status'
      ? `${w.statuses[x.status] ?? x.status}${x.by ? ` → ${x.by}` : ''}`
      : p === 'type'
        ? (w.types[x.type] ?? x.type)
        : x[p]
  // What the other person changed, every part of it.
  const sourceText = (s: Source) => ('entryId' in s ? s.entryId : (s.title ?? s.url))
  const theirParts = [
    ...(['title', 'summary', 'type', 'status', 'address'] as const)
      .filter((p) => value(base, p) !== value(theirs, p))
      .map((p) => (
        <div key={p} class="diff-part">
          <h4>{w.parts[p]}</h4>
          <p class="diff">
            {wordDiff(shown(p, base), shown(p, theirs)).map((s, i) =>
              s.kind === 'added' ? (
                <ins key={i}>
                  <span class="sr-only">{w.added}:</span>
                  {s.text}
                </ins>
              ) : s.kind === 'removed' ? (
                <del key={i}>
                  <span class="sr-only">{w.removed}:</span>
                  {s.text}
                </del>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        </div>
      )),
    ...(
      [
        ['tags', base.tags, theirs.tags],
        ['sources', base.sources.map(sourceText), theirs.sources.map(sourceText)],
        [
          'links',
          base.links.map((l) => `${w.kinds[l.kind] ?? l.kind} ${l.to}`),
          theirs.links.map((l) => `${w.kinds[l.kind] ?? l.kind} ${l.to}`),
        ],
      ] as const
    )
      .filter(([, a, b]) => a.join('\n') !== b.join('\n'))
      .map(([p, a, b]) => (
        <div key={p} class="diff-part">
          <h4>{w.parts[p]}</h4>
          <ListDiff a={[...a]} b={[...b]} />
        </div>
      )),
    ...(base.body === theirs.body
      ? []
      : [
          <div key="body" class="diff-part">
            <h4>{w.parts.body}</h4>
            <BodyDiff a={base.body} b={theirs.body} />
          </div>,
        ]),
  ]
  // What saving now writes over their revision.
  const after = editableOf(current)
  const outcome = [
    ...(['title', 'summary', 'type', 'status', 'address'] as const)
      .filter((p) => value(result, p) !== value(after, p))
      .map((p) => (
        <div key={p} class="result-part">
          <h4>{w.parts[p]}</h4>
          <p>{shown(p, result)}</p>
        </div>
      )),
    ...(result.tags !== after.tags.join(', ')
      ? [
          <div key="tags" class="result-part">
            <h4>{w.parts.tags}</h4>
            <p>{result.tags || w.none}</p>
          </div>,
        ]
      : []),
    ...(result.sources.map(sourceKey).join() !== after.sources.map(sourceKey).join()
      ? [
          <div key="sources" class="result-part">
            <h4>{w.parts.sources}</h4>
            <ListDiff a={after.sources.map(sourceText)} b={result.sources.map(sourceText)} />
          </div>,
        ]
      : []),
    ...(result.body !== after.body
      ? [
          <div key="body" class="result-part">
            <h4>{w.parts.body}</h4>
            <pre class="version" data-part="result-body">
              {result.body}
            </pre>
          </div>,
        ]
      : []),
  ]
  const who = current.lastChange?.authorName || w.someone
  return (
    <section class="conflict alert warn" aria-labelledby="conflict-title" tabIndex={-1} ref={ref}>
      <h2 id="conflict-title">{w.conflictTitle(who, current.page.revision)}</h2>
      <p>{w.conflictLead(current.page.revision)}</p>
      <section aria-labelledby="theirs-title">
        <h3 id="theirs-title">{w.theirChanges(who)}</h3>
        {theirParts.length ? theirParts : <p class="muted">{w.noChange}</p>}
      </section>
      {clash.length ? (
        <section aria-labelledby="clash-title">
          <h3 id="clash-title">{w.bothChanged}</h3>
          {clash.map((p) => (
            <fieldset key={p} class="choice">
              <legend>{w.parts[p]}</legend>
              {(p === 'body' && merged.ok
                ? (['both', 'mine', 'theirs'] as const)
                : (['mine', 'theirs'] as const)
              ).map((c) => (
                <label key={c} class="radio">
                  <input
                    type="radio"
                    name={`choice-${p}`}
                    checked={choice[p] === c}
                    onChange={() => setChoice({ ...choice, [p]: c })}
                  />
                  {w.choices[c]}
                </label>
              ))}
              <div class="versions">
                <div>
                  <h4>{w.yourVersion}</h4>
                  <pre class="version">{shown(p, form)}</pre>
                </div>
                <div>
                  <h4>{w.theirVersion(who)}</h4>
                  <pre class="version">{shown(p, theirs)}</pre>
                </div>
              </div>
            </fieldset>
          ))}
        </section>
      ) : null}
      <section aria-labelledby="result-title">
        <h3 id="result-title">{w.resultTitle}</h3>
        {open.length ? (
          <p class="muted">{w.chooseFirst(open.map((p) => w.parts[p] ?? p).join(', '))}</p>
        ) : outcome.length ? (
          outcome
        ) : (
          <p class="muted">{w.resultSame}</p>
        )}
      </section>
      <div class="field">
        <label for="mine">{w.yourText}</label>
        <textarea id="mine" readOnly rows={5} value={form.body} />
      </div>
      <CopyButton text={form.body} label={w.copyYours} />
      <div class="conflict-actions">
        <div>
          <Button
            kind="primary"
            pending={pending}
            pendingLabel={w.saving}
            blocked={
              blockedNow(false) ??
              (open.length ? w.chooseFirst(open.map((p) => w.parts[p] ?? p).join(', ')) : null)
            }
            onClick={() => onSave(result, theirs)}
          >
            {w.saveResult}
          </Button>
          <p class="hint">{w.saveResultHint}</p>
        </div>
        <div>
          <Button onClick={onTheirs}>{w.takeTheirs}</Button>
          <p class="hint">{w.takeTheirsHint}</p>
        </div>
      </div>
    </section>
  )
}

function Mine({ text }: { text: string }) {
  return (
    <div class="mine">
      <div class="field">
        <label for="mine">{T.wiki.yourText}</label>
        <textarea id="mine" readOnly rows={5} value={text} />
      </div>
      <CopyButton text={text} label={T.wiki.copyYours} />
    </div>
  )
}

function EditForm({ slug, reading }: { slug: string; reading: Reading }) {
  const w = T.wiki
  const { route } = useLocation()
  const store = useDraft(accountId(), slug, reading.page.id)
  const restored = useMemo(() => store.read(), [store])
  const [base, setBase] = useState<Base>(restored?.base ?? editableOf(reading))
  const [form, setForm] = useState<Form>(restored?.form ?? formOf(editableOf(reading)))
  const [reason, setReason] = useState(restored?.reason ?? '')
  // My text after a conflict when I started again from theirs.
  const [mine, setMine] = useState<string | null>(restored?.mine ?? null)
  const [back, setBack] = useState(Boolean(restored))
  const [preview, setPreview] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [conflict, setConflict] = useState<Reading | null>(null)
  const [gone, setGone] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  // The titles of journal entries, to show a source by its title rather than its id.
  const [titles, setTitles] = useState(
    () =>
      new Map(
        reading.sources.flatMap((s) =>
          'entryId' in s && s.title ? [[s.entryId, s.title] as [string, string]] : [],
        ),
      ),
  )
  const body = useRef<HTMLTextAreaElement>(null)
  const suggest = useSuggest(slug, reading.page.address, { first: true })
  const replacing = useSuggest(slug, reading.page.address)
  const dirty = changed(base, form)
  // Written with the render, not after the paint: a reload right after typing keeps the last key.
  useLayoutEffect(() => {
    if (dirty || mine !== null) store.write({ base, form, mine, reason })
    else store.clear()
  }, [base, form, mine, reason, dirty])
  // Leaving the web with changes not saved asks first (they stay in this tab's draft either way).
  useEffect(() => {
    if (!dirty) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [dirty])
  // The page moved on (a link changed from here, or someone saved): an untouched form follows it; an edit
  // in progress follows only when nothing it changes changed.
  const now = reading.page.revision
  // With the render: a Save pressed right after a link change already goes on the new revision.
  useLayoutEffect(() => {
    if (now === base.revision || conflict) return
    const current = editableOf(reading)
    if (!dirty) {
      setBase(current)
      setForm(formOf(current))
    } else if (canRebase(base, current) && current.status === base.status && current.address === base.address)
      setBase({ ...base, revision: now, links: current.links })
  }, [now])

  // Every part that changed, from `from` (the revision read, or theirs after a conflict): the content
  // against its revision first (the one conflict check), then the status, then the address.
  const commit = async (from: Base, to: Form) => {
    const content = editChanges(from, asEditable(to))
    const status = statusOp(from, to)
    const move = moveTo(from, to)
    setError(null)
    setSaid(null)
    if (!content && !status && !move) return setSaid(w.nothingChanged)
    setPending(true)
    const why = reason.trim()
    let last: Changed | null = null
    const step = async (op: Record<string, unknown>) => {
      last = await api.call<Changed>('wikiChange', {
        path: { slug },
        body: { reason: why || w.byHand, ...op },
      })
      if (last.page) pageChanged(slug, last.page)
    }
    try {
      if (content) {
        last = await api.call<Changed>('editPage', {
          path: { slug, address: from.address },
          body: { ...content, ...(why ? { reason: why } : {}) },
        })
        if (last.page) pageChanged(slug, last.page)
      }
      if (status) await step(status)
      if (move) await step({ op: 'move', address: from.address, to: move })
    } catch (e) {
      const err = e as ApiError
      setPending(false)
      const done = last as Changed | null
      if (done?.page) {
        // What was saved stays saved; what is left still differs from it.
        wikiChanged(slug)
        setBase(editableOf(done.page))
        setSaid(w.partlySaved(done.revised.at(-1)?.revision ?? now))
      }
      if (err.code === 'page_changed' && err.current) setConflict(err.current as Reading)
      else if (err.code === 'page_not_found') setGone(true)
      else setError(err)
      return
    }
    store.clear()
    wikiChanged(slug)
    const out = last as Changed | null
    const at = pageHref(slug, out?.page?.page.address ?? move ?? from.address)
    const n = out?.revised.at(-1)?.revision ?? now + 1
    wikiNotice.value = {
      path: at,
      text: [
        w.saved(n),
        status ? w.statusChanged(w.statuses[to.status] ?? to.status) : '',
        move ? w.moved(move) : '',
      ]
        .filter(Boolean)
        .join(' '),
    }
    route(at)
    requestAnimationFrame(() => {
      const h = document.querySelector<HTMLElement>('main h1')
      h?.setAttribute('tabindex', '-1')
      h?.focus()
    })
  }
  const save = () => void commit(base, form)
  const pick = (address: string) => {
    const el = body.current
    const caret = el?.selectionStart ?? form.body.length
    const at = completionAt(form.body, caret)
    if (!at) return
    const out = completeAt(form.body, at.start, caret, address)
    setForm({ ...form, body: out.text })
    suggest.close()
    requestAnimationFrame(() => el?.setSelectionRange(out.caret, out.caret))
  }
  // The list shows over the field, next to the line being typed: under it while the caret is in the
  // upper half of the field, above it in the lower half (a list under a long field is out of sight).
  const [near, setNear] = useState<{ top: number } | { bottom: number }>({ top: 0 })
  const follow = (el: HTMLTextAreaElement) => {
    const at = completionAt(el.value, el.selectionStart)
    suggest.ask(at ? at.query : null)
    if (!at) return
    const { top, bottom } = caretBox(el)
    setNear(top < el.clientHeight / 2 ? { top: bottom + 4 } : { bottom: el.clientHeight - top + 4 })
  }
  const blocked = blockedNow(pending)
  // ⌘ Enter / Ctrl+Enter saves from any field of the form.
  const quick = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (!blocked) save()
    }
  }
  return (
    <section aria-labelledby="content-title" class="edit-block">
      <h2 id="content-title" class="section-title">
        {w.content}
      </h2>
      {back ? (
        <div class="alert ok" role="status">
          <span>{w.draftRestored}</span>
          <button
            type="button"
            class="button quiet"
            onClick={() => {
              store.clear()
              const current = editableOf(reading)
              setBase(current)
              setForm(formOf(current))
              setMine(null)
              setReason('')
              setConflict(null)
              setBack(false)
            }}
          >
            {w.discard}
          </button>
        </div>
      ) : null}
      {conflict ? (
        <Conflict
          base={base}
          current={conflict}
          form={form}
          pending={pending}
          onSave={(result, theirs) => {
            setBase(theirs)
            setForm(result)
            setConflict(null)
            void commit(theirs, result)
          }}
          onTheirs={() => {
            const theirs = editableOf(conflict)
            setMine(form.body)
            setBase(theirs)
            setForm(formOf(theirs))
            setConflict(null)
          }}
        />
      ) : null}
      {gone ? <FormAlert error={{ message: w.gone }} /> : null}
      <form
        class="form edit-form"
        onKeyDown={(e) => quick(e as unknown as KeyboardEvent)}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <Field label={w.title} value={form.title} onValue={(v) => setForm({ ...form, title: v })} />
        <Field
          label={w.summary}
          hint={w.summaryHint}
          value={form.summary}
          onValue={(v) => setForm({ ...form, summary: v })}
        />
        <div class="field-row">
          <div class="field">
            <label for="edit-type">{w.type}</label>
            <select
              id="edit-type"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: (e.currentTarget as HTMLSelectElement).value })}
            >
              {PAGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {w.types[t]}
                </option>
              ))}
            </select>
          </div>
          <Field
            label={w.tags}
            hint={w.tagsHint}
            value={form.tags}
            onValue={(v) => setForm({ ...form, tags: v })}
          />
        </div>
        <div class="field body-field">
          <div class="body-head">
            <label for="edit-body">{w.body}</label>
            <span class="toggle">
              <button
                type="button"
                class="button quiet"
                aria-pressed={preview ? 'false' : 'true'}
                onClick={() => setPreview(false)}
              >
                {w.write}
              </button>
              <button
                type="button"
                class="button quiet"
                aria-pressed={preview ? 'true' : 'false'}
                onClick={() => setPreview(true)}
              >
                {w.preview}
              </button>
            </span>
          </div>
          <span id="edit-body-hint" class="hint">
            {w.bodyHint}
          </span>
          {preview ? (
            form.body.trim() ? (
              <div
                class="preview prose"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(form.body, { slug, links: reading.links.out }),
                }}
              />
            ) : (
              <p class="muted">{w.previewEmpty}</p>
            )
          ) : (
            <div class="textarea-wrap">
              <textarea
                id="edit-body"
                ref={body}
                rows={16}
                value={form.body}
                aria-describedby="edit-body-hint"
                aria-keyshortcuts="Control+Enter Meta+Enter"
                {...comboOf(suggest)}
                onInput={(e) => {
                  const el = e.currentTarget as HTMLTextAreaElement
                  setForm({ ...form, body: el.value })
                  follow(el)
                }}
                onClick={(e) => follow(e.currentTarget as HTMLTextAreaElement)}
                onKeyDown={(e) => {
                  if (suggest.key(e, (p) => pick(p.address))) {
                    e.preventDefault()
                    e.stopPropagation()
                  }
                }}
                onBlur={() => suggest.close()}
              />
              <SuggestList s={suggest} onPick={(p) => pick(p.address)} over={near} />
            </div>
          )}
        </div>
        <SourcesEditor
          slug={slug}
          sources={form.sources}
          titles={titles}
          onChange={(s, named) => {
            if (named) setTitles(new Map([...titles, named]))
            setForm({ ...form, sources: s })
          }}
        />
        <fieldset class="status-edit" aria-labelledby="status-legend">
          <legend id="status-legend">{w.statusTitle}</legend>
          <div class="field-row">
            <div class="field">
              <label for="new-status">{w.newStatus}</label>
              <select
                id="new-status"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: (e.currentTarget as HTMLSelectElement).value })}
              >
                {PAGE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {w.statuses[s]}
                  </option>
                ))}
              </select>
            </div>
            {form.status === 'superseded' ? (
              <div class="field grow suggest-host">
                <label for="replaced-by">{w.replacedBy}</label>
                <input
                  id="replaced-by"
                  type="text"
                  value={form.by}
                  autoComplete="off"
                  aria-describedby="replaced-by-hint"
                  {...comboOf(replacing)}
                  onInput={(e) => {
                    const v = (e.currentTarget as HTMLInputElement).value
                    setForm({ ...form, by: v })
                    replacing.ask(v.trim() ? v.trim() : null)
                  }}
                  onKeyDown={(e) => {
                    if (
                      replacing.key(e, (p) => {
                        setForm({ ...form, by: p.address })
                        replacing.close()
                      })
                    )
                      e.preventDefault()
                  }}
                  onBlur={() => replacing.close()}
                />
                <span id="replaced-by-hint" class="hint">
                  {w.replacedByHint}
                </span>
                <SuggestList
                  s={replacing}
                  onPick={(p) => {
                    setForm({ ...form, by: p.address })
                    replacing.close()
                  }}
                />
              </div>
            ) : null}
          </div>
          <Field
            label={w.address}
            hint={w.addressHint}
            value={form.address}
            onValue={(v) => setForm({ ...form, address: v })}
            class="mono"
          />
        </fieldset>
        <Field label={w.reason} hint={w.reasonHint} value={reason} onValue={setReason} />
        <Problems error={error} />
        <p class="said ok" role="status">
          {said}
        </p>
        <p class="actions">
          <Button
            kind="primary"
            type="submit"
            pending={pending}
            pendingLabel={w.saving}
            blocked={blocked}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
            {w.save}
          </Button>
          <a class="button quiet" href={pageHref(slug, reading.page.address)}>
            {w.back}
          </a>
          {dirty ? <span class="meta">{w.notSavedYet}</span> : null}
        </p>
      </form>
      {mine !== null && !conflict ? <Mine text={mine} /> : null}
    </section>
  )
}

// One link added or removed at once: pending, refused with its problems, or said.
function useChange(slug: string) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const run = async (op: Record<string, unknown>, after: (out: Changed) => void) => {
    setPending(true)
    setError(null)
    try {
      const out = await api.call<Changed>('wikiChange', {
        path: { slug },
        body: { reason: T.wiki.byHand, ...op },
      })
      // The page as the change left it, at once: the form moves on to its revision before anything else
      // can be pressed (a Save right after would otherwise meet its own change as a conflict).
      if (out.page) pageChanged(slug, out.page)
      wikiChanged(slug)
      after(out)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return { pending, error, run }
}

function LinksEditor({ slug, reading, say }: { slug: string; reading: Reading; say: (t: string) => void }) {
  const w = T.wiki
  const typed = reading.links.out.filter((l) => l.kind !== 'mentions')
  const [kind, setKind] = useState<string>('related')
  const [to, setTo] = useState('')
  const suggest = useSuggest(slug, reading.page.address)
  const c = useChange(slug)
  const address = reading.page.address
  return (
    <section aria-labelledby="typed-title" class="edit-block">
      <h2 id="typed-title" class="section-title">
        {w.linksTitle}
      </h2>
      <p class="muted small">{w.linksLead}</p>
      {typed.length ? (
        <ul class="list compact">
          {typed.map((l) => (
            <li key={`${l.kind}:${l.address}`} class="with-actions">
              <div>
                <p>
                  <span class="meta">{w.kinds[l.kind] ?? l.kind}</span> <span>{l.title ?? l.address}</span>{' '}
                  <span class="meta mono">{l.address}</span>
                </p>
              </div>
              <p class="actions">
                <Button
                  kind="quiet"
                  blocked={blockedNow(c.pending)}
                  onClick={() =>
                    void c.run({ op: 'unlink', address, kind: l.kind, to: l.address }, () =>
                      say(w.linkRemoved(w.kinds[l.kind] ?? l.kind, l.address)),
                    )
                  }
                >
                  {w.remove}
                  <span class="sr-only">
                    {' '}
                    {w.kinds[l.kind]} {l.address}
                  </span>
                </Button>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">{w.noTyped}</p>
      )}
      <form
        class="filters add-link"
        onSubmit={(e) => {
          e.preventDefault()
          const target = to.trim()
          if (!target) return
          void c.run({ op: 'link', address, kind, to: target }, () => {
            say(w.linkAdded(w.kinds[kind] ?? kind, target))
            setTo('')
          })
        }}
      >
        <div class="field">
          <label for="link-kind">{w.linkKind}</label>
          <select
            id="link-kind"
            value={kind}
            onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value)}
          >
            {LINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {w.kinds[k]}
              </option>
            ))}
          </select>
        </div>
        <div class="field grow suggest-host">
          <label for="link-to">{w.linkTo}</label>
          <input
            id="link-to"
            type="text"
            value={to}
            aria-describedby="link-to-hint"
            autoComplete="off"
            {...comboOf(suggest)}
            onInput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value
              setTo(v)
              suggest.ask(v.trim() ? v.trim() : null)
            }}
            onKeyDown={(e) => {
              if (
                suggest.key(e, (p) => {
                  setTo(p.address)
                  suggest.close()
                })
              )
                e.preventDefault()
            }}
            onBlur={() => suggest.close()}
          />
          <span id="link-to-hint" class="hint">
            {w.linkToHint}
          </span>
          <SuggestList
            s={suggest}
            onPick={(p) => {
              setTo(p.address)
              suggest.close()
            }}
          />
        </div>
        <p class="actions">
          <Button type="submit" pending={c.pending} pendingLabel={w.adding} blocked={blockedNow(c.pending)}>
            {w.addLink}
          </Button>
        </p>
      </form>
      <Problems error={c.error} />
    </section>
  )
}

export function PageEdit({ slug, brain, reading }: { slug: string; brain: BrainOne; reading: Reading }) {
  if (!isCurator(brain)) {
    return (
      <Empty title={T.wiki.edit}>
        <p>{T.wiki.onlyCurators}</p>
      </Empty>
    )
  }
  const say = (text: string) => {
    wikiNotice.value = { path: pageHref(slug, reading.page.address), text }
  }
  return (
    <div class="page-edit">
      <EditForm key={reading.page.id} slug={slug} reading={reading} />
      <LinksEditor slug={slug} reading={reading} say={say} />
    </div>
  )
}
