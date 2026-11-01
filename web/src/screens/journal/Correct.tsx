// Add a correction (spec B6 «Journal › Add a correction», B1, CA12; T024). Who: a person with the
// contributor role or more, in the web (agents cannot write corrections). Job: tell the agents what is
// wrong and what to do instead, about a page of the wiki or an entry of the journal, and optionally for one
// agent. Done when: the correction is saved and the person sees it as an entry. It goes first in the
// context of the agents it touches. Pages and entries are picked by searching their words, never by
// pasting an id. What is typed is kept in a draft of this tab, per person and brain, until it is sent.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { draft } from '../../api/draft.ts'
import { api } from '../../api/index.ts'
import { correctionAbout, journalDraftKey } from '../../lib/journal.ts'
import { pageHref } from '../../lib/markdown.ts'
import { me } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Field } from '../../ui/Field.tsx'
import { FormAlert } from '../../ui/states.tsx'
import { TextArea } from '../../ui/TextArea.tsx'
import { brainResource } from '../Brain.tsx'
import { blockedNow, useBrain, WikiHead } from '../wiki/common.tsx'
import { comboOf, EntryList, type Lookup, SuggestList, useEntries, useSuggest } from '../wiki/Suggest.tsx'
import { entryHref, JournalNav, roleAtLeast, sessionsHref, writable } from './common.tsx'
import { curatorNames, entryResource, journalChanged, membersResource } from './data.ts'
import { journalNotice } from './Entry.tsx'

type About = 'page' | 'entry' | 'nothing'
type Form = {
  about: About
  page: { address: string; title: string } | null
  entry: { id: string; title: string } | null
  title: string
  content: string
  appliesTo: string
}

function useFormDraft(slug: string) {
  const store = useMemo(
    () =>
      typeof sessionStorage === 'undefined'
        ? null
        : draft(journalDraftKey(me().data.value?.account.id ?? '', slug, 'correction'), sessionStorage),
    [slug],
  )
  return {
    read(): Form | null {
      try {
        const v = JSON.parse(store?.get() || 'null') as Form | null
        return v && typeof v.content === 'string' ? v : null
      } catch {
        return null
      }
    },
    write: (f: Form) => store?.set(JSON.stringify(f)),
    clear: () => store?.clear(),
  }
}

// A field that finds what the person means by its words, with the list beside it; Enter picks from the
// list and never sends the form.
function Picker<T>({
  id,
  label,
  hint,
  picked,
  problem,
  look,
  list,
  pick,
}: {
  id: string
  label: string
  hint: string
  picked: string | null
  problem: string | null
  look: Lookup<T>
  list: (onPick: (x: T) => void) => preact.ComponentChildren
  pick: (x: T) => void
}) {
  const [text, setText] = useState(picked ?? '')
  useEffect(() => setText(picked ?? ''), [picked])
  const choose = (x: T) => {
    pick(x)
    look.close()
  }
  return (
    <div class="field suggest-host">
      <label for={id}>{label}</label>
      <span id={`${id}-hint`} class="hint">
        {picked ? T.journal.otherPicked(picked) : hint}
      </span>
      <input
        id={id}
        type="search"
        autocomplete="off"
        value={text}
        aria-invalid={problem ? 'true' : undefined}
        aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ''}`}
        {...comboOf(look)}
        onInput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value
          setText(v)
          look.ask(v)
        }}
        onFocus={() => look.ask(text)}
        onBlur={() => look.close()}
        onKeyDown={(e) => {
          if (look.key(e, choose)) {
            e.preventDefault()
            return
          }
          if (e.key === 'Enter') e.preventDefault()
        }}
      />
      {list(choose)}
      {problem ? (
        <span id={`${id}-problem`} class="problem">
          {problem}
        </span>
      ) : null}
    </div>
  )
}

export function JournalCorrect({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const { query, route } = useLocation()
  const store = useFormDraft(slug)
  membersResource(slug)
  const fromEntry = query.entry ?? ''
  const fromPage = query.page ?? ''
  const [f, setFState] = useState<Form>(() => {
    const kept = store.read()
    if (kept && !fromEntry && !fromPage) return kept
    return {
      about: correctionAbout({
        fromEntry,
        fromPage,
        pages: brainResource(slug).data.value?.brain.stats.pages,
      }),
      page: fromPage ? { address: fromPage, title: fromPage } : null,
      entry: fromEntry ? { id: fromEntry, title: fromEntry } : null,
      title: kept?.title ?? '',
      content: kept?.content ?? '',
      appliesTo: kept?.appliesTo ?? '',
    }
  })
  // What is typed goes to the draft at once, not after the next paint: a reload right after keeps it.
  const setF = (next: Form | ((x: Form) => Form)) =>
    setFState((x) => {
      const v = typeof next === 'function' ? next(x) : next
      if (v.content || v.title) store.write(v)
      return v
    })
  const [problems, setProblems] = useState<
    Partial<Record<'page' | 'entry' | 'title' | 'content', string | undefined>>
  >({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const pages = useSuggest(slug, undefined, { first: true })
  const entries = useEntries(slug)
  // What the person came from has a title: show it, not its address or id.
  const known = fromEntry ? entryResource(slug, fromEntry).data.value?.entry.title : undefined
  useEffect(() => {
    if (known && f.entry?.id === fromEntry && f.entry.title === fromEntry)
      setF((x) => ({ ...x, entry: { id: fromEntry, title: known } }))
  }, [known])
  useEffect(() => {
    if (!fromPage) return
    let live = true
    api
      .call<{ items: Array<{ address: string; title: string }> }>('wikiPages', {
        path: { slug },
        query: { q: fromPage, limit: 5 },
      })
      .then(
        (r) => {
          const p = r.items.find((x) => x.address === fromPage)
          if (live && p) setF((x) => (x.page?.address === fromPage ? { ...x, page: p } : x))
        },
        () => {},
      )
    return () => {
      live = false
    }
  }, [fromPage])
  // The brain arrived after the form was made: a wiki with no page yet starts on «nothing in particular»,
  // unless the person already chose.
  const pagesNow = brain?.stats.pages
  const chose = useRef(false)
  useEffect(() => {
    if (!chose.current && f.about === 'page' && !f.page)
      setFState((x) => ({ ...x, about: correctionAbout({ fromEntry, fromPage, pages: pagesNow }) }))
  }, [pagesNow])
  if (!brain) return gate
  const j = T.journal
  const may = roleAtLeast(brain, 'contributor') && writable(brain)
  if (!may) {
    return (
      <>
        <WikiHead title={j.correctionTitle} lead={j.correctionLead} />
        <JournalNav brain={brain} />
        <div class="state" data-state="forbidden">
          <span class="kind">{T.kind.noAccess}</span>
          <p>{writable(brain) ? j.readerCannot(brain.name, curatorNames(slug)) : j.archived}</p>
        </div>
      </>
    )
  }
  const send = async () => {
    const p: typeof problems = {}
    if (f.about === 'page' && !f.page) p.page = j.pageNeeded
    if (f.about === 'entry' && !f.entry) p.entry = j.entryNeeded
    if (!f.title.trim()) p.title = j.titleNeeded
    if (!f.content.trim()) p.content = j.textNeeded
    setProblems(p)
    const firstBad = Object.keys(p)[0]
    if (firstBad) {
      document.getElementById(`correction-${firstBad}`)?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ receipt: { entryId: string } }>('addCorrection', {
        path: { slug },
        body: {
          title: f.title.trim(),
          content: f.content,
          ...(f.appliesTo.trim() ? { appliesTo: f.appliesTo.trim() } : {}),
          ...(f.about === 'page' && f.page ? { page: f.page.address } : {}),
          ...(f.about === 'entry' && f.entry ? { entry: f.entry.id } : {}),
        },
      })
      store.clear()
      journalChanged(slug)
      const to = entryHref(slug, r.receipt.entryId)
      journalNotice.value = { path: to, text: j.added }
      route(to)
    } catch (x) {
      const err = x as ApiError
      if (err.code === 'page_not_found') {
        setProblems({ page: err.message })
        document.getElementById('correction-page')?.focus()
      } else setError(err)
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <WikiHead title={j.correctionTitle} lead={j.correctionLead} />
      <JournalNav brain={brain} />
      <form
        class="form correction-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <fieldset class="choice">
          <legend>{j.aboutWhat}</legend>
          {(
            [
              ['page', j.aboutPageChoice],
              ['entry', j.aboutEntryChoice],
              ['nothing', j.aboutNothing],
            ] as const
          ).map(([v, label]) => (
            <label key={v} class="radio">
              <input
                type="radio"
                name="about"
                value={v}
                checked={f.about === v}
                onChange={() => {
                  chose.current = true
                  setF({ ...f, about: v })
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {f.about === 'page' ? (
          <Picker<{ address: string; title: string; status: string }>
            id="correction-page"
            label={j.pageField}
            hint={j.pageHint}
            picked={f.page ? f.page.title : null}
            problem={problems.page ?? null}
            look={pages}
            pick={(p) => {
              setF({ ...f, page: { address: p.address, title: p.title } })
              setProblems({ ...problems, page: undefined })
            }}
            list={(onPick) => <SuggestList s={pages} onPick={onPick} />}
          />
        ) : null}
        {f.about === 'entry' ? (
          <Picker<{ id: string; title: string; at: string }>
            id="correction-entry"
            label={j.otherEntry}
            hint={j.otherHint}
            picked={f.entry ? f.entry.title : null}
            problem={problems.entry ?? null}
            look={entries}
            pick={(x) => {
              setF({ ...f, entry: { id: x.id, title: x.title } })
              setProblems({ ...problems, entry: undefined })
            }}
            list={(onPick) => <EntryList s={entries} onPick={onPick} />}
          />
        ) : null}
        <Field
          id="correction-title"
          label={j.correctionShort}
          hint={j.correctionShortHint}
          maxLength={200}
          problem={problems.title ?? null}
          value={f.title}
          onValue={(v) => setF({ ...f, title: v })}
        />
        <TextArea
          label={j.correctionText}
          hint={j.correctionHint}
          rows={6}
          id="correction-content"
          problem={problems.content ?? null}
          value={f.content}
          onValue={(v) => setF({ ...f, content: v })}
        />
        <Field
          label={j.appliesToField}
          hint={j.appliesToHint}
          maxLength={80}
          value={f.appliesTo}
          onValue={(v) => setF({ ...f, appliesTo: v })}
        />
        <FormAlert error={error} />
        <p class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={j.adding}
            blocked={blockedNow(pending)}
          >
            {j.addIt}
          </Button>
          <a
            class="button quiet"
            href={
              fromPage
                ? pageHref(slug, fromPage)
                : fromEntry
                  ? entryHref(slug, fromEntry)
                  : sessionsHref(slug)
            }
          >
            {j.cancel}
          </a>
        </p>
      </form>
    </>
  )
}
