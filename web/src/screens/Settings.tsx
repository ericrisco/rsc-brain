// A brain's settings (spec B6 «Settings de un cerebro», plan T046; PR25a). Who: its curators (and, for
// deleting it, the administration). Jobs: say who is in the brain and with which role; link the
// repositories agents find it by; write the compile guide and the usage note, or go back to the default;
// leave it out of meaning search; set the health thresholds; archive it or bring it back. Done when: each
// part says it is saved, in words. Risks: a brain left without a curator (refused by the server, and said
// on the row before anyone tries); two curators saving at once (a save carries the revision it read: the
// second is refused, sees the other's version and keeps what it typed); archiving by mistake (asked first,
// with what stops). Who may do what is the server's (B4); this screen only offers it to whoever may.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { draft } from '../api/draft.ts'
import { api } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import { ago } from '../lib/brains.ts'
import {
  type MemberRow,
  memberRows,
  ROLES,
  repoKey,
  savedSettings,
  THRESHOLDS,
  type ThresholdName,
  thresholdProblems,
} from '../lib/settings.ts'
import { draftKeyOf } from '../lib/wiki.ts'
import { justDeleted, me, online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Field } from '../ui/Field.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'
import { TextArea } from '../ui/TextArea.tsx'
import { brainResource } from './Brain.tsx'
import { brainsResource } from './Home.tsx'

const S = T.settings

type Settings = {
  guide: string
  guideDefault: string
  customGuide: boolean
  usageNote: string
  usageNoteDefault: string
  meaningExcluded: boolean
  staleDays: number
  longChars: number
  maintenanceEvery: number
  revision: string
}
type Member = { accountId: string; kind: string; name: string; email: string | null; role: string }
type Repo = { repo: string; linkedAt: string }
type BrainInfo = { slug: string; name: string; role: string; status: string }

const settingsResource = (slug: string) =>
  resource<Settings>(`brain:${slug}:settings`, () => api.call<Settings>('wikiSettings', { path: { slug } }))
// The members with their emails (curators see them); the journal reads the same list for names.
const membersResource = (slug: string) =>
  resource<{ members: Member[] }>(`brain:${slug}:members`, () =>
    api.call<{ members: Member[] }>('members', { path: { slug } }),
  )
const reposResource = (slug: string) =>
  resource<{ repos: Repo[] }>(`brain:${slug}:repos`, () =>
    api.call<{ repos: Repo[] }>('repos', { path: { slug } }),
  )

const blocked = (pending = false) => writeBlocked({ online: online.value, pending })

// A part of the page: a region named by its heading.
function Part({
  id,
  title,
  lead,
  children,
}: {
  id: string
  title: string
  lead?: string
  children: ComponentChildren
}) {
  return (
    <section class="settings-part" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} class="section-title flush">
        {title}
      </h2>
      {lead ? <p class="muted">{lead}</p> : null}
      {children}
    </section>
  )
}

// What a part says once done; announced, and in words (never colour alone).
function Said({ text, id }: { text: string | null; id?: string }) {
  return (
    <p class="said ok" role="status" id={id} tabIndex={-1}>
      {text}
    </p>
  )
}

function Members({ brain, me: myId }: { brain: BrainInfo; me: string }) {
  const r = membersResource(brain.slug)
  const [said, setSaid] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ id: string; error: ApiError } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const [selfDemote, setSelfDemote] = useState<string | null>(null)
  const [who, setWho] = useState('')
  const [role, setRole] = useState('contributor')
  const [problem, setProblem] = useState<string | null>(null)
  const [addError, setAddError] = useState<ApiError | null>(null)
  const [adding, setAdding] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const rows = r.data.value ? memberRows(r.data.value.members, myId) : undefined
  const { route } = useLocation()

  const changeRole = async (m: MemberRow, next: string) => {
    setBusy(m.accountId)
    setFailed(null)
    setSaid(null)
    try {
      await api.call('setMemberRole', {
        path: { slug: brain.slug, account: m.accountId },
        body: { role: next },
      })
      await r.reload()
      setSaid(S.nowRole(m.name, next))
      if (m.you) {
        // What I may do here changed: the brain is read again (a non-curator is shown why it cannot stay).
        invalidate(`brain:${brain.slug}:basic`)
        invalidate('brains')
      }
    } catch (e) {
      setFailed({ id: m.accountId, error: e as ApiError })
      await r.reload()
    } finally {
      setBusy(null)
    }
  }
  const remove = async (m: MemberRow) => {
    setBusy(m.accountId)
    setFailed(null)
    setSaid(null)
    try {
      await api.call('removeMember', { path: { slug: brain.slug, account: m.accountId } })
      setAsking(null)
      if (m.you) {
        invalidate('brains')
        route('/', true)
        return
      }
      await r.reload()
      setSaid(S.removed(m.name, brain.name))
      heading.current?.focus()
    } catch (e) {
      setFailed({ id: m.accountId, error: e as ApiError })
    } finally {
      setBusy(null)
    }
  }
  const add = async (e: Event) => {
    e.preventDefault()
    if (adding || !online.value) return
    setAddError(null)
    setSaid(null)
    const v = who.trim()
    if (!v) {
      setProblem(S.needWho)
      document.getElementById('member-who')?.focus()
      return
    }
    setProblem(null)
    setAdding(true)
    try {
      const out = await api.call<{ member: { name: string; role: string } }>('addMember', {
        path: { slug: brain.slug },
        body: { account: v, role },
      })
      setWho('')
      await r.reload()
      setSaid(S.added(out.member.name, out.member.role))
    } catch (err) {
      setAddError(err as ApiError)
    } finally {
      setAdding(false)
    }
  }

  return (
    <section class="settings-part" aria-labelledby="members-title">
      <h2 id="members-title" class="section-title flush" tabIndex={-1} ref={heading}>
        {S.members}
      </h2>
      <p class="muted">{S.membersLead}</p>
      <Said text={said} />
      {!rows ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : (
        <ul class="list">
          {rows.map((m) => (
            <li key={m.accountId} class="with-actions">
              <div>
                <p class="list-title">
                  {m.name}
                  {m.you ? <span class="tag">{S.you}</span> : null}
                  {m.kind === 'service' ? <span class="tag">{S.service}</span> : null}
                  {m.lastCurator ? <span class="tag ok">{S.onlyCurator}</span> : null}
                </p>
                {m.email ? <p class="meta mono">{m.email}</p> : null}
                {m.lastCurator ? <p class="meta">{S.onlyCuratorWhy}</p> : null}
                {failed?.id === m.accountId ? (
                  <p class="problem" role="alert">
                    {failed.error.message} {failed.error.howToProceed}
                  </p>
                ) : null}
              </div>
              <div class="actions member-actions">
                <select
                  aria-label={S.roleOf(m.name)}
                  value={m.role}
                  disabled={m.lastCurator || busy === m.accountId || !online.value}
                  onChange={(e) => {
                    const next = e.currentTarget.value
                    if (m.you && m.role === 'curator' && next !== 'curator') {
                      e.currentTarget.value = m.role
                      setSelfDemote(next)
                      return
                    }
                    void changeRole(m, next)
                  }}
                >
                  {m.roles.map((x) => (
                    <option key={x} value={x}>
                      {T.people.roles[x]}
                    </option>
                  ))}
                </select>
                {m.lastCurator ? null : asking === m.accountId ? null : (
                  <Button
                    blocked={blocked()}
                    aria-label={S.remove(m.name)}
                    onClick={() => setAsking(m.accountId)}
                  >
                    {S.removeShort}
                  </Button>
                )}
              </div>
              {asking === m.accountId ? (
                <div class="confirm">
                  <p>{m.you ? S.removeSelfLead(brain.name) : S.removeLead(m.name, brain.name)}</p>
                  <div class="actions">
                    <Button
                      kind="primary"
                      pending={busy === m.accountId}
                      pendingLabel={T.states.pending}
                      blocked={blocked()}
                      onClick={() => void remove(m)}
                      autoFocus
                    >
                      {S.removeFrom(m.name, brain.name)}
                    </Button>
                    <Button kind="quiet" onClick={() => setAsking(null)}>
                      {S.keep}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form class="settings-form" aria-label={S.add} onSubmit={add} noValidate>
        <h3 class="part-title">{S.add}</h3>
        <p class="muted small">{S.addLead}</p>
        <FormAlert error={addError} />
        <div class="add-member">
          <Field
            id="member-who"
            label={S.who}
            value={who}
            problem={problem}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            onValue={(v) => {
              setWho(v)
              if (problem) setProblem(null)
            }}
          />
          <div class="field">
            <label for="member-role">{S.newRole}</label>
            <select id="member-role" value={role} onChange={(e) => setRole(e.currentTarget.value)}>
              {ROLES.map((x) => (
                <option key={x} value={x}>
                  {T.people.roles[x]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div class="actions">
          <Button type="submit" pending={adding} pendingLabel={S.adding} blocked={blocked()}>
            {S.addButton}
          </Button>
        </div>
      </form>
      <Dialog open={selfDemote !== null} title={S.demoteSelfTitle} onClose={() => setSelfDemote(null)}>
        {selfDemote ? (
          <>
            <p>{S.demoteSelfLead(brain.name, selfDemote)}</p>
            <div class="actions">
              <Button
                kind="primary"
                onClick={() => {
                  const me_ = rows?.find((x) => x.you)
                  const next = selfDemote
                  setSelfDemote(null)
                  if (me_) void changeRole(me_, next)
                }}
              >
                {S.demoteSelfConfirm}
              </Button>
              <Button kind="quiet" onClick={() => setSelfDemote(null)}>
                {S.keep}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
    </section>
  )
}

function Repositories({ brain }: { brain: BrainInfo }) {
  const r = reposResource(brain.slug)
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const key = repoKey(text)
  const folder = /^(\/|~|[a-z]:\\|\.)/i.test(text.trim())
  const verdict = !text.trim() ? null : key ? S.matches(key) : folder ? S.folder : S.notRepo
  const list = r.data.value?.repos

  const link = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setTried(true)
    setError(null)
    setSaid(null)
    if (!key) {
      document.getElementById('repo-address')?.focus()
      return
    }
    setPending(true)
    try {
      const out = await api.call<{ repo: string }>('linkRepo', {
        path: { slug: brain.slug },
        body: { repo: text },
      })
      setText('')
      setTried(false)
      await r.reload()
      setSaid(S.linked(out.repo))
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  const unlink = async (repo: string) => {
    setBusy(repo)
    setError(null)
    try {
      await api.call('unlinkRepo', { path: { slug: brain.slug }, body: { repo } })
      setAsking(null)
      await r.reload()
      setSaid(S.unlinked(repo))
      heading.current?.focus()
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(null)
    }
  }
  return (
    <section class="settings-part" aria-labelledby="repos-title">
      <h2 id="repos-title" class="section-title flush" tabIndex={-1} ref={heading}>
        {S.repos}
      </h2>
      <p class="muted">{S.reposLead}</p>
      <Said text={said} />
      {!list ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={1} />
        )
      ) : list.length === 0 ? (
        <p class="quiet-empty" data-state="empty">
          {S.noRepos}
        </p>
      ) : (
        <ul class="list">
          {list.map((x) => (
            <li key={x.repo} class="with-actions">
              <div>
                <p class="list-title mono wrap">{x.repo}</p>
                <p class="meta">{S.linkedOn(ago(x.linkedAt) ?? T.date(x.linkedAt))}</p>
              </div>
              {asking === x.repo ? (
                <div class="confirm">
                  <p>{S.unlinkLead}</p>
                  <div class="actions">
                    <Button
                      kind="primary"
                      pending={busy === x.repo}
                      pendingLabel={T.states.pending}
                      blocked={blocked()}
                      onClick={() => void unlink(x.repo)}
                      autoFocus
                    >
                      {S.unlinkConfirm}
                    </Button>
                    <Button kind="quiet" onClick={() => setAsking(null)}>
                      {S.keep}
                    </Button>
                  </div>
                </div>
              ) : (
                <div class="actions">
                  <Button blocked={blocked()} aria-label={S.unlink(x.repo)} onClick={() => setAsking(x.repo)}>
                    {S.unlinkShort}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form class="settings-form" aria-label={S.link} onSubmit={link} noValidate>
        <FormAlert error={error} />
        <Field
          id="repo-address"
          label={S.repo}
          hint={S.repoHint}
          value={text}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          problem={tried && !key ? verdict : null}
          note={tried && !key ? null : verdict}
          onValue={(v) => {
            setText(v)
            setTried(false)
          }}
        />
        <div class="actions">
          <Button type="submit" pending={pending} pendingLabel={S.linking} blocked={blocked()}>
            {S.link}
          </Button>
        </div>
      </form>
    </section>
  )
}

// The settings every text and number part reads, and what a save does with an answer or a conflict.
function useSave(slug: string) {
  const r = settingsResource(slug)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const save = async (body: Record<string, unknown>): Promise<boolean> => {
    if (pending || !online.value) return false
    setPending(true)
    setError(null)
    setSaid(null)
    try {
      r.data.value = await api.call<Settings>('saveWikiSettings', { path: { slug }, body })
      setConflict(false)
      setSaid(S.saved)
      return true
    } catch (e) {
      const a = e as ApiError
      if (a.code === 'settings_changed') {
        // Theirs comes back; what this person typed stays in the field, to save again on top.
        await r.reload()
        setConflict(true)
      } else setError(a)
      return false
    } finally {
      setPending(false)
    }
  }
  return { r, pending, error, said, conflict, save, setSaid }
}

function Conflict({ theirs }: { theirs?: string | undefined }) {
  return (
    <>
      <FormAlert error={{ message: S.changedTitle, howToProceed: S.changedHow }} />
      {theirs !== undefined ? (
        <div class="theirs">
          <p class="meta">{S.theirs}</p>
          <pre class="command">
            <code>{theirs || '—'}</code>
          </pre>
        </div>
      ) : null}
    </>
  )
}

// A text of the brain (the compile guide or the usage note): the default beside it, «reset to default»,
// one Save, a draft of this tab per person and brain, and a conflict that keeps what was typed.
function TextPart({
  slug,
  archived,
  account,
  part,
}: {
  slug: string
  archived: boolean
  account: string
  part: 'guide' | 'usage'
}) {
  const guide = part === 'guide'
  const { r, pending, error, said, conflict, save, setSaid } = useSave(slug)
  const s = r.data.value
  const store = typeof sessionStorage === 'undefined' ? null : sessionStorage
  const d = store ? draft(draftKeyOf(account, slug, `settings:${part}`), store) : null
  const [text, setText] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const max = guide ? 20_000 : 2000
  const current = s ? (guide ? s.guide : s.usageNote) : ''
  const fallback = s ? (guide ? s.guideDefault : s.usageNoteDefault) : ''
  // The field starts from the brain's text, or from what this person typed and did not save.
  useEffect(() => {
    if (s && text === null) setText(d?.get() || current)
  }, [s])
  const id = `${part}-text`
  const value = text ?? ''
  const isDefault = s ? (guide ? !s.customGuide : s.usageNote === s.usageNoteDefault) : true
  const label = guide ? S.guide : S.usage
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!s) return
    if (value.trim().length > max) {
      setProblem(S.tooLong(max))
      document.getElementById(id)?.focus()
      return
    }
    const body = savedSettings(s, guide ? { guide: value } : { usageNote: value })
    if (await save(body)) {
      d?.clear()
      const fresh = r.data.value
      if (fresh) setText(guide ? fresh.guide : fresh.usageNote)
    }
  }
  return (
    <Part id={part} title={label} lead={guide ? S.guideLead : S.usageLead}>
      {!s ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : (
        <form class="settings-form" onSubmit={submit} noValidate>
          <p class="meta">
            <span class={`tag ${isDefault ? '' : 'ok'}`}>{isDefault ? S.isDefault : S.isCustom}</span>
          </p>
          {archived ? <p class="note">{S.archivedNote}</p> : null}
          <FormAlert error={error} />
          {conflict ? <Conflict theirs={current} /> : null}
          <TextArea
            id={id}
            label={label}
            hint={guide ? S.chars(value.length, max) : `${S.usageHint} ${S.chars(value.length, max)}`}
            rows={guide ? 12 : 4}
            value={value}
            problem={problem}
            onValue={(v) => {
              setText(v)
              setSaid(null)
              setProblem(null)
              if (d) v === current ? d.clear() : d.set(v)
            }}
          />
          <Said text={said} />
          <div class="actions">
            <Button
              type="submit"
              kind="primary"
              pending={pending}
              pendingLabel={S.saving}
              blocked={archived ? S.archivedNote : blocked()}
            >
              {guide ? S.saveGuide : S.saveNote}
            </Button>
            <Button
              kind="quiet"
              blocked={archived ? S.archivedNote : null}
              onClick={() => {
                setText(fallback)
                d?.set(fallback === current ? '' : fallback)
                setSaid(S.resetNote)
                document.getElementById(id)?.focus()
              }}
            >
              {S.resetDefault}
            </Button>
          </div>
          {guide ? (
            <details class="default-text">
              <summary class="default-summary">{S.showDefault}</summary>
              <pre class="command">
                <code>{s.guideDefault}</code>
              </pre>
            </details>
          ) : null}
        </form>
      )}
    </Part>
  )
}

function Meaning({ slug, archived }: { slug: string; archived: boolean }) {
  const { r, pending, error, said, conflict, save, setSaid } = useSave(slug)
  const s = r.data.value
  const [out, setOut] = useState<boolean | null>(null)
  useEffect(() => {
    if (s && out === null) setOut(s.meaningExcluded)
  }, [s])
  return (
    <Part id="meaning" title={S.meaning} lead={S.meaningLead}>
      {!s ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={1} />
        )
      ) : (
        <form
          class="settings-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save({ revision: s.revision, meaningExcluded: out === true })
          }}
        >
          {archived ? <p class="note">{S.archivedNote}</p> : null}
          <FormAlert error={error} />
          {conflict ? <Conflict /> : null}
          <div class="pick">
            <input
              type="checkbox"
              id="meaning-out"
              checked={out === true}
              aria-describedby="meaning-out-hint"
              onChange={(e) => {
                setOut(e.currentTarget.checked)
                setSaid(null)
              }}
            />
            <label for="meaning-out">{S.meaningOut}</label>
          </div>
          <p class="hint" id="meaning-out-hint">
            {S.meaningOutHint}
          </p>
          <Said text={said} />
          <div class="actions">
            <Button
              type="submit"
              pending={pending}
              pendingLabel={S.saving}
              blocked={archived ? S.archivedNote : blocked()}
            >
              {S.save}
            </Button>
          </div>
        </form>
      )}
    </Part>
  )
}

function Health({ slug, archived }: { slug: string; archived: boolean }) {
  const { r, pending, error, said, conflict, save, setSaid } = useSave(slug)
  const s = r.data.value
  const [v, setV] = useState<Record<ThresholdName, string> | null>(null)
  const [problems, setProblems] = useState<Partial<Record<ThresholdName, string>>>({})
  useEffect(() => {
    if (s && v === null)
      setV({
        staleDays: String(s.staleDays),
        longChars: String(s.longChars),
        maintenanceEvery: String(s.maintenanceEvery),
      })
  }, [s])
  const fields: Array<{ k: ThresholdName; label: string; hint: string }> = [
    { k: 'staleDays', label: S.staleDays, hint: S.staleHint },
    { k: 'longChars', label: S.longChars, hint: S.longHint },
    { k: 'maintenanceEvery', label: S.every, hint: S.everyHint },
  ]
  return (
    <Part id="health" title={S.health} lead={S.healthLead}>
      {!s || !v ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : (
        <form
          class="settings-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            const p = thresholdProblems(v)
            setProblems(p)
            const first = fields.find((f) => p[f.k])
            if (first) {
              document.getElementById(`threshold-${first.k}`)?.focus()
              return
            }
            void save({
              revision: s.revision,
              staleDays: Number(v.staleDays),
              longChars: Number(v.longChars),
              maintenanceEvery: Number(v.maintenanceEvery),
            })
          }}
        >
          {archived ? <p class="note">{S.archivedNote}</p> : null}
          <FormAlert error={error} />
          {conflict ? <Conflict /> : null}
          <div class="thresholds">
            {fields.map((f) => (
              <Field
                key={f.k}
                id={`threshold-${f.k}`}
                label={f.label}
                hint={f.hint}
                inputMode="numeric"
                value={v[f.k]}
                problem={problems[f.k] ?? null}
                min={THRESHOLDS[f.k].min}
                max={THRESHOLDS[f.k].max}
                onValue={(x) => {
                  setV({ ...v, [f.k]: x })
                  setSaid(null)
                  if (problems[f.k]) setProblems({ ...problems, [f.k]: undefined })
                }}
              />
            ))}
          </div>
          <Said text={said} />
          <div class="actions">
            <Button
              type="submit"
              pending={pending}
              pendingLabel={S.saving}
              blocked={archived ? S.archivedNote : blocked()}
            >
              {S.save}
            </Button>
          </div>
        </form>
      )}
    </Part>
  )
}

function Archive({ brain }: { brain: BrainInfo }) {
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const archived = brain.status === 'archived'
  // Once what it says is drawn, the keyboard goes there (the button it pressed is gone).
  const [toSaid, setToSaid] = useState(0)
  useEffect(() => {
    if (toSaid) document.getElementById('archive-said')?.focus()
  }, [toSaid])
  const run = async (to: boolean) => {
    setPending(true)
    setError(null)
    try {
      await api.call(to ? 'archiveBrain' : 'unarchiveBrain', { path: { slug: brain.slug } })
      setAsking(false)
      await brainResource(brain.slug).reload()
      invalidate('brains')
      setSaid(to ? S.archived(brain.name) : S.active(brain.name))
      setToSaid((n) => n + 1)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <Part id="archive" title={S.archive} lead={archived ? S.archivedLead : S.archiveLead}>
      <Said text={said} id="archive-said" />
      <FormAlert error={asking ? null : error} />
      <div class="actions">
        {archived ? (
          <Button
            pending={pending}
            pendingLabel={T.states.pending}
            blocked={blocked()}
            onClick={() => void run(false)}
          >
            {S.unarchiveButton}
          </Button>
        ) : (
          <Button blocked={blocked()} onClick={() => setAsking(true)}>
            {S.archiveButton}
          </Button>
        )}
      </div>
      <Dialog open={asking} title={S.archiveTitle(brain.name)} onClose={() => setAsking(false)}>
        <p>{S.archiveStops}</p>
        <p>{S.archiveKeeps}</p>
        <FormAlert error={error} />
        <div class="actions">
          <Button
            kind="primary"
            pending={pending}
            pendingLabel={T.states.pending}
            blocked={blocked()}
            onClick={() => void run(true)}
          >
            {S.archiveConfirm(brain.name)}
          </Button>
          <Button kind="quiet" onClick={() => setAsking(false)}>
            {S.cancel}
          </Button>
        </div>
      </Dialog>
    </Part>
  )
}

function Delete({ brain }: { brain: BrainInfo }) {
  const [asking, setAsking] = useState(false)
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const { route } = useLocation()
  const go = async () => {
    if (typed.trim() !== brain.slug) {
      setProblem(S.deleteNeed(brain.slug))
      document.getElementById('delete-confirm')?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      await api.call('deleteBrain', { path: { slug: brain.slug }, body: { confirm: brain.slug } })
      setAsking(false)
      invalidate('brains')
      justDeleted.value = brain.name
      route('/', true)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <Part id="delete" title={S.deleteSection} lead={S.deleteLead}>
      <div class="actions">
        <Button blocked={blocked()} onClick={() => setAsking(true)}>
          {S.deleteButton}
        </Button>
      </div>
      <Dialog
        open={asking}
        title={S.deleteTitle(brain.name)}
        onClose={() => {
          setAsking(false)
          setTyped('')
          setProblem(null)
        }}
      >
        <p>{S.deleteWarn}</p>
        <FormAlert error={error} />
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
        >
          <Field
            id="delete-confirm"
            label={S.typeToConfirm(brain.slug)}
            value={typed}
            problem={problem}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            onValue={(v) => {
              setTyped(v)
              setProblem(null)
            }}
          />
          <div class="actions">
            <Button
              type="submit"
              kind="primary"
              pending={pending}
              pendingLabel={T.states.pending}
              blocked={blocked()}
            >
              {S.deleteConfirm(brain.name)}
            </Button>
            <Button kind="quiet" onClick={() => setAsking(false)}>
              {S.cancel}
            </Button>
          </div>
        </form>
      </Dialog>
    </Part>
  )
}

export function BrainSettings({ slug }: { slug: string }) {
  const who = me().data.value
  const b = brainResource(slug)
  const brain = b.data.value?.brain
  // A role that changed (here, or elsewhere) is read again with the list of brains.
  useEffect(() => {
    void brainsResource()
  }, [])
  if (!brain || !who) {
    return (
      <>
        <div class="title-row">
          <h1 class="title">{S.title}</h1>
        </div>
        {b.error.value ? (
          <ErrorState error={b.error.value} onRetry={() => void b.reload()} />
        ) : (
          <Skeleton rows={4} />
        )}
      </>
    )
  }
  if (brain.role !== 'curator') {
    return (
      <>
        <div class="title-row">
          <h1 class="title">{S.title}</h1>
        </div>
        <div class="state forbidden" role="alert" data-state="forbidden">
          <span class="kind">{T.kind.noAccess}</span>
          <h2>{T.states.forbiddenTitle}</h2>
          <p>{S.cannot(brain.name)}</p>
          <p class="how">{S.cannotHow(brain.name)}</p>
        </div>
      </>
    )
  }
  const archived = brain.status === 'archived'
  const info: BrainInfo = { slug: brain.slug, name: brain.name, role: brain.role, status: brain.status }
  return (
    <div class="settings">
      <div class="title-row">
        <div class="title-group">
          <h1 class="title">{S.title}</h1>
          <span class="meta">{brain.name}</span>
        </div>
      </div>
      <p class="lead">{S.lead(brain.name)}</p>
      <div class="settings-grid">
        <div class="settings-main">
          <Members brain={info} me={who.account.id} />
          <TextPart slug={brain.slug} archived={archived} account={who.account.id} part="guide" />
          <TextPart slug={brain.slug} archived={archived} account={who.account.id} part="usage" />
        </div>
        <div class="settings-side">
          <Repositories brain={info} />
          <Meaning slug={brain.slug} archived={archived} />
          <Health slug={brain.slug} archived={archived} />
          <Part id="export" title={S.exportTitle}>
            <p class="muted">{S.exportLead}</p>
          </Part>
          <Archive brain={info} />
          {who.account.isAdmin ? <Delete brain={info} /> : null}
        </div>
      </div>
    </div>
  )
}
