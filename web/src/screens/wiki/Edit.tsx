// A curator edits a wiki page by hand (spec B6 «Wiki › Page», B2 «Editar a mano», CA10; T019). Who: a
// curator, in the web (a token is refused by the server: agents propose). Job: correct a page — its
// words, links, sources, status or address — or go back to an older revision (History). Done when: the
// page shows the change and says «Saved as revision N». Risk: losing what was typed. The edit goes
// against the revision read; if the page moved on, nothing is saved, the new version is shown with what
// changed meanwhile, and the curator's text stays (to save over theirs or to copy from). What is typed
// lives in a draft of this tab (never a secret), so a reload or a lost connection loses nothing.
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
  PAGE_STATUSES,
  PAGE_TYPES,
  parseTags,
  type Source,
  sourceKey,
  wordDiff,
} from '../../lib/wiki.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { CopyButton } from '../../ui/CopyButton.tsx'
import { Field } from '../../ui/Field.tsx'
import { Empty, FormAlert } from '../../ui/states.tsx'
import type { BrainOne } from '../Brain.tsx'
import { blockedNow, isCurator, pageHref } from './common.tsx'
import { type Changed, pageResource, type Reading, wikiChanged } from './data.ts'
import { comboOf, SuggestList, useSuggest } from './Suggest.tsx'

// What the page says after a change made from here, until the person goes elsewhere.
export const wikiNotice = signal<{ path: string; text: string } | null>(null)

type Form = { type: string; title: string; summary: string; tags: string; body: string; sources: Source[] }
type Base = Editable & { revision: number }
type Saved = { base: Base; form: Form; mine: string | null; reason: string }

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
})
const formOf = (b: Editable): Form => ({ ...b, tags: b.tags.join(', ') })
const asEditable = (f: Form): Editable => ({ ...f, tags: parseTags(f.tags) })

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
  mark.textContent = '\u200b'
  copy.append(mark)
  document.body.append(copy)
  const top = mark.offsetTop - el.scrollTop
  const bottom = top + (Number.parseFloat(cs.lineHeight) || mark.offsetHeight)
  copy.remove()
  return { top, bottom }
}

// The tab's draft of this page's edit (sessionStorage: it goes with the tab).
function useDraft(slug: string, pageId: string) {
  return useMemo(() => {
    const store = typeof sessionStorage === 'undefined' ? null : sessionStorage
    const d = store ? draft(draftKeyOf(slug, pageId), store) : null
    return {
      read(): Saved | null {
        try {
          const v = JSON.parse(d?.get() || 'null') as Saved | null
          return v && typeof v.form?.body === 'string' && typeof v.base?.revision === 'number' ? v : null
        } catch {
          return null
        }
      },
      write: (v: Saved) => d?.set(JSON.stringify(v)),
      clear: () => d?.clear(),
    }
  }, [slug, pageId])
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

function SourcesEditor({ sources, onChange }: { sources: Source[]; onChange: (s: Source[]) => void }) {
  const w = T.wiki
  const [entry, setEntry] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const add = () => {
    const e = entry.trim()
    const u = url.trim()
    let next: Source | null = null
    if (e && /^ent_[A-Za-z0-9_-]+$/.test(e)) next = { entryId: e }
    else if (!e && /^https?:\/\/\S+$/i.test(u))
      next = title.trim() ? { url: u, title: title.trim() } : { url: u }
    if (!next) return setProblem(w.sourceBad)
    const n = next
    setProblem(null)
    if (!sources.some((s) => sourceKey(s) === sourceKey(n))) onChange([...sources, n])
    setEntry('')
    setUrl('')
    setTitle('')
  }
  return (
    <fieldset class="sources-edit" aria-labelledby="sources-legend">
      <legend id="sources-legend">{w.sources}</legend>
      <p class="hint">{w.sourcesHint}</p>
      {sources.length ? (
        <ul class="plain">
          {sources.map((s) => (
            <li key={sourceKey(s)} class="row">
              <span class="mono">{'entryId' in s ? s.entryId : (s.title ?? s.url)}</span>
              {'url' in s && s.title ? <span class="meta"> {s.url}</span> : null}
              <button
                type="button"
                class="button quiet"
                onClick={() => onChange(sources.filter((x) => sourceKey(x) !== sourceKey(s)))}
              >
                {w.remove}
                <span class="sr-only"> {'entryId' in s ? s.entryId : s.url}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">{w.noSources}</p>
      )}
      <div class="source-add">
        <Field label={w.addEntry} hint={w.addEntryHint} value={entry} onValue={setEntry} problem={problem} />
        <Field label={w.addUrl} hint={w.addUrlHint} value={url} onValue={setUrl} type="url" />
        <Field label={w.addUrlTitle} value={title} onValue={setTitle} />
        <p class="actions">
          <Button onClick={add}>{w.addSource}</Button>
        </p>
      </div>
    </fieldset>
  )
}

function Conflict({
  base,
  current,
  mine,
  onMine,
  onTheirs,
  pending,
}: {
  base: Base
  current: Reading
  mine: string
  onMine: () => void
  onTheirs: () => void
  pending: boolean
}) {
  const w = T.wiki
  const ref = useRef<HTMLElement>(null)
  useEffect(() => ref.current?.focus(), [current.page.revision])
  const parts = (
    [
      ['title', base.title, current.page.title],
      ['summary', base.summary, current.page.summary],
      ['body', base.body, current.page.body],
    ] as const
  ).filter(([, a, b]) => a !== b)
  return (
    <section class="conflict alert warn" aria-labelledby="conflict-title" tabIndex={-1} ref={ref}>
      <h2 id="conflict-title">{w.conflictTitle}</h2>
      <p>{w.conflictLead(current.page.revision)}</p>
      <section aria-labelledby="theirs-title">
        <h3 id="theirs-title">{w.theirChanges}</h3>
        {parts.length === 0 ? (
          <p class="muted">{w.noChange}</p>
        ) : (
          parts.map(([part, a, b]) => (
            <div key={part} class="diff-part">
              <h4>{w.parts[part]}</h4>
              <p class="diff">
                {wordDiff(a, b).map((s, i) =>
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
          ))
        )}
      </section>
      <div class="field">
        <label for="mine">{w.yourText}</label>
        <textarea id="mine" readOnly rows={5} value={mine} />
      </div>
      <CopyButton text={mine} label={w.copyYours} />
      <div class="conflict-actions">
        <div>
          <Button
            kind="primary"
            pending={pending}
            pendingLabel={w.saving}
            blocked={blockedNow(false)}
            onClick={onMine}
          >
            {w.keepMine}
          </Button>
          <p class="hint">{w.keepMineHint}</p>
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

function ContentForm({ slug, reading }: { slug: string; reading: Reading }) {
  const w = T.wiki
  const { route } = useLocation()
  const store = useDraft(slug, reading.page.id)
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
  const body = useRef<HTMLTextAreaElement>(null)
  const suggest = useSuggest(slug, reading.page.address)
  const dirty = editChanges(base, asEditable(form)) !== null
  // Written with the render, not after the paint: a reload right after typing keeps the last key.
  useLayoutEffect(() => {
    if (dirty || mine !== null) store.write({ base, form, mine, reason })
    else store.clear()
  }, [base, form, mine, reason, dirty])
  // The page moved on (a link or status changed from here, or someone saved): an untouched form follows
  // it; an edit in progress follows only when its content did not change.
  const now = reading.page.revision
  // With the render: a Save pressed right after a link or status change already goes on the new revision.
  useLayoutEffect(() => {
    if (now === base.revision || conflict) return
    const current = editableOf(reading)
    if (!dirty) {
      setBase(current)
      setForm(formOf(current))
    } else if (canRebase(base, current)) setBase({ ...base, revision: now })
  }, [now])

  // `onto`: save my changes (what differs from the revision I started from) on a newer revision; what
  // only the other person changed keeps their words.
  const save = async (onto?: number) => {
    const mine = editChanges(base, asEditable(form))
    const changes = mine && onto !== undefined ? { ...mine, baseRevision: onto } : mine
    setError(null)
    setSaid(null)
    if (!changes) return setSaid(w.nothingChanged)
    setPending(true)
    try {
      const out = await api.call<Changed>('editPage', {
        path: { slug, address: reading.page.address },
        body: { ...changes, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      })
      store.clear()
      wikiChanged(slug)
      const at = pageHref(slug, out.page?.page.address ?? reading.page.address)
      wikiNotice.value = { path: at, text: w.saved(out.revised.at(-1)?.revision ?? now + 1) }
      route(at)
      requestAnimationFrame(() => {
        const h = document.querySelector<HTMLElement>('main h1')
        h?.setAttribute('tabindex', '-1')
        h?.focus()
      })
    } catch (e) {
      const err = e as ApiError
      setPending(false)
      if (err.code === 'page_changed' && err.current) {
        setConflict(err.current as Reading)
      } else if (err.code === 'page_not_found') setGone(true)
      else setError(err)
    }
  }
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
          mine={form.body}
          pending={pending}
          onMine={() => {
            const onto = conflict.page.revision
            setConflict(null)
            void save(onto)
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
        onSubmit={(e) => {
          e.preventDefault()
          void save()
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
                  if (suggest.key(e, (p) => pick(p.address))) e.preventDefault()
                  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    if (!blocked) void save()
                  }
                }}
                onBlur={() => suggest.close()}
              />
              <SuggestList s={suggest} onPick={(p) => pick(p.address)} over={near} />
            </div>
          )}
        </div>
        <SourcesEditor sources={form.sources} onChange={(s) => setForm({ ...form, sources: s })} />
        <Field label={w.reason} hint={w.reasonHint} value={reason} onValue={setReason} />
        <Problems error={error} />
        <p class="said ok" role="status">
          {said}
        </p>
        <p class="actions">
          <Button kind="primary" type="submit" pending={pending} pendingLabel={w.saving} blocked={blocked}>
            {w.save}
          </Button>
          <a class="button quiet" href={pageHref(slug, reading.page.address)}>
            {w.back}
          </a>
        </p>
      </form>
      {mine !== null && !conflict ? <Mine text={mine} /> : null}
    </section>
  )
}

// One change made at once (a link, a status, an address): pending, refused with its problems, or said.
function useChange(slug: string) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const run = async (op: Record<string, unknown>, after: (out: Changed) => void) => {
    setPending(true)
    setError(null)
    try {
      const out = await api.call<Changed>('wikiChange', {
        path: { slug },
        body: { reason: 'Changed by hand in the web.', ...op },
      })
      // The page as the change left it, at once: the content form moves on to its revision before
      // anything else can be pressed (a Save right after would otherwise meet its own change as a conflict).
      if (out.page) pageResource(slug, out.page.page.address).data.value = out.page
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
  const suggest = useSuggest(slug)
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
                  <span class="meta">{w.kinds[l.kind] ?? l.kind}</span> <span class="mono">{l.address}</span>
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

function StatusEditor({ slug, reading, say }: { slug: string; reading: Reading; say: (t: string) => void }) {
  const w = T.wiki
  const { route } = useLocation()
  const [status, setStatus] = useState(reading.page.status)
  const [by, setBy] = useState('')
  const [to, setTo] = useState(reading.page.address)
  const suggest = useSuggest(slug)
  const c = useChange(slug)
  const address = reading.page.address
  return (
    <section aria-labelledby="status-title" class="edit-block">
      <h2 id="status-title" class="section-title">
        {w.statusTitle}
      </h2>
      <form
        class="filters"
        onSubmit={(e) => {
          e.preventDefault()
          const op =
            status === 'superseded' && by.trim()
              ? { op: 'status', address, status, supersededBy: by.trim() }
              : { op: 'status', address, status }
          void c.run(op, () => say(w.statusChanged(w.statuses[status] ?? status)))
        }}
      >
        <div class="field">
          <label for="new-status">{w.newStatus}</label>
          <select
            id="new-status"
            value={status}
            onChange={(e) => setStatus((e.currentTarget as HTMLSelectElement).value)}
          >
            {PAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {w.statuses[s]}
              </option>
            ))}
          </select>
        </div>
        {status === 'superseded' ? (
          <div class="field grow suggest-host">
            <label for="replaced-by">{w.replacedBy}</label>
            <input
              id="replaced-by"
              type="text"
              value={by}
              autoComplete="off"
              aria-describedby="replaced-by-hint"
              {...comboOf(suggest)}
              onInput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value
                setBy(v)
                suggest.ask(v.trim() ? v.trim() : null)
              }}
              onKeyDown={(e) => {
                if (
                  suggest.key(e, (p) => {
                    setBy(p.address)
                    suggest.close()
                  })
                )
                  e.preventDefault()
              }}
              onBlur={() => suggest.close()}
            />
            <span id="replaced-by-hint" class="hint">
              {w.replacedByHint}
            </span>
            <SuggestList
              s={suggest}
              onPick={(p) => {
                setBy(p.address)
                suggest.close()
              }}
            />
          </div>
        ) : null}
        <p class="actions">
          <Button type="submit" pending={c.pending} pendingLabel={w.working} blocked={blockedNow(c.pending)}>
            {w.changeStatus}
          </Button>
        </p>
      </form>
      <form
        class="filters"
        onSubmit={(e) => {
          e.preventDefault()
          const target = to.trim()
          if (!target || target === address) return
          void c.run({ op: 'move', address, to: target }, (out) => {
            const at = pageHref(slug, out.page?.page.address ?? target)
            wikiNotice.value = { path: at, text: w.moved(target) }
            route(`${at}?view=edit`, true)
          })
        }}
      >
        <Field label={w.address} hint={w.addressHint} value={to} onValue={setTo} class="mono" />
        <p class="actions">
          <Button type="submit" pending={c.pending} pendingLabel={w.working} blocked={blockedNow(c.pending)}>
            {w.move}
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
      <ContentForm key={reading.page.id} slug={slug} reading={reading} />
      <LinksEditor slug={slug} reading={reading} say={say} />
      <StatusEditor
        key={`${reading.page.status}:${reading.page.address}`}
        slug={slug}
        reading={reading}
        say={say}
      />
    </div>
  )
}
