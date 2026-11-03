// A brain's settings (spec B6 «Settings de un cerebro», plan T046; PR25a). Who: its curators (and, for
// deleting it, the administration). Jobs: say who is in the brain and with which role; link the
// repositories agents find it by; write the compile guide and the usage note, or go back to the default;
// leave it out of meaning search; set the health thresholds; archive it or bring it back. Done when: each
// part says it is saved, in words. Risks: a brain left without a curator (refused by the server, and said
// on the row before anyone tries); two curators saving at once (each part sends only the fields it
// changed, each with the value it read: a field someone changed since is refused, the other's value is
// shown and what was typed stays; other fields are never touched); archiving by mistake (asked first,
// with what stops). Who may do what is the server's (B4); this screen only offers it to whoever may.
//
// Four tabs, one job each, each its own address: Members, Agents (what agents find and read: repositories,
// guide, usage note, meaning search), Health, Archive (export, archive, delete). On a phone each fits in
// about two screens.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { useFresh } from '../api/fresh.ts'
import { api } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import { ago } from '../lib/brains.ts'
import { type ExportFormat, exportAsk, sizeLabel } from '../lib/exporting.ts'
import { fileProblem, type ImportReport, importAsk, importDone, whyText } from '../lib/importing.ts'
import { focusOnArrival } from '../lib/screen.ts'
import {
  fieldDrafts,
  type MemberRow,
  memberRows,
  ROLES,
  repoKey,
  type SettingsRead,
  settingsSave,
  THRESHOLDS,
  type ThresholdName,
  textDrafts,
  thresholdProblems,
} from '../lib/settings.ts'
import { justDeleted, me, online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Field } from '../ui/Field.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'
import { TextArea } from '../ui/TextArea.tsx'
import { brainResource, overviewResource } from './Brain.tsx'
import { curatorNames } from './journal/data.ts'

const S = T.settings

type Settings = SettingsRead
type Member = { accountId: string; kind: string; name: string; email: string | null; role: string }
type Repo = { repo: string; linkedAt: string }
type BrainInfo = { slug: string; name: string; role: string; status: string }
export type SettingsTab = 'members' | 'agents' | 'health' | 'import' | 'archive'

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

const blocked = () => writeBlocked({ online: online.value, pending: false })

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
      {/* data-start: on a move between tabs the screen's own focus goes to the first part's heading. */}
      <h2 id={`${id}-title`} class="part-heading" tabIndex={-1} data-start>
        {title}
      </h2>
      {lead ? <p class="muted">{lead}</p> : null}
      {children}
    </section>
  )
}

// What a part says once done; announced, in words. `focus` bumps to take the keyboard there once drawn
// (the control pressed may be gone or changed), so it never falls to the page.
function Said({ text, id, focus = 0 }: { text: string | null; id: string; focus?: number }) {
  useEffect(() => {
    if (focus) document.getElementById(id)?.focus()
  }, [focus])
  return (
    <p class="said ok" role="status" id={id} tabIndex={-1}>
      {text}
    </p>
  )
}

function useSaid(): { said: string | null; focus: number; say: (t: string | null, take?: boolean) => void } {
  const [said, setSaid] = useState<string | null>(null)
  const [focus, setFocus] = useState(0)
  return {
    said,
    focus,
    say: (t, take = false) => {
      setSaid(t)
      if (take && t) setFocus((n) => n + 1)
    },
  }
}

function MemberItem({
  m,
  brain,
  onSaved,
  onFailed,
  failed,
}: {
  m: MemberRow
  brain: BrainInfo
  onSaved: (text: string, you: boolean) => Promise<void>
  onFailed: (id: string, e: ApiError | null) => void
  failed: ApiError | null
}) {
  const [pick, setPick] = useState(m.role)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [selfDemote, setSelfDemote] = useState(false)
  const { route } = useLocation()
  useEffect(() => setPick(m.role), [m.role])
  useEffect(() => {
    if (asking) document.getElementById(`remove-yes-${m.accountId}`)?.focus()
  }, [asking])
  const reasonId = `only-curator-${m.accountId}`
  const save = async () => {
    setBusy(true)
    onFailed(m.accountId, null)
    try {
      await api.call('setMemberRole', {
        path: { slug: brain.slug, account: m.accountId },
        body: { role: pick },
      })
      await onSaved(S.nowRole(m.name, pick), m.you)
    } catch (e) {
      onFailed(m.accountId, e as ApiError)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    onFailed(m.accountId, null)
    try {
      await api.call('removeMember', { path: { slug: brain.slug, account: m.accountId } })
      setAsking(false)
      if (m.you) {
        invalidate('brains')
        route('/', true)
        return
      }
      await onSaved(S.removed(m.name, brain.name), false)
    } catch (e) {
      onFailed(m.accountId, e as ApiError)
    } finally {
      setBusy(false)
    }
  }
  const changed = pick !== m.role
  return (
    <li class="with-actions" data-member={m.accountId}>
      <div>
        <p class="list-title">
          {m.name}
          {m.you ? <span class="tag">{S.you}</span> : null}
          {m.kind === 'service' ? <span class="tag">{S.service}</span> : null}
          {m.lastCurator ? <span class="tag ok">{S.onlyCurator}</span> : null}
        </p>
        {m.email ? <p class="meta mono wrap">{m.email}</p> : null}
        {m.lastCurator ? (
          <p class="meta" id={reasonId}>
            {S.onlyCuratorWhy}
          </p>
        ) : null}
        {failed ? (
          <p class="problem" role="alert">
            {failed.message} {failed.howToProceed}
          </p>
        ) : null}
      </div>
      <div class="actions member-actions">
        <select
          id={`role-${m.accountId}`}
          aria-label={S.roleOf(m.name)}
          aria-describedby={m.lastCurator ? reasonId : undefined}
          value={pick}
          aria-disabled={m.lastCurator ? 'true' : undefined}
          onChange={(e) => {
            // Off but reachable (its reason is read with it): a change there goes back at once.
            if (m.lastCurator) {
              e.currentTarget.value = m.role
              return
            }
            setPick(e.currentTarget.value)
          }}
        >
          {m.roles.map((x) => (
            <option key={x} value={x}>
              {T.people.roles[x]}
            </option>
          ))}
        </select>
        {changed ? (
          <Button
            kind="primary"
            pending={busy}
            pendingLabel={S.saving}
            blocked={blocked()}
            aria-label={S.saveRoleOf(m.name)}
            onClick={() => {
              if (m.you && m.role === 'curator' && pick !== 'curator') setSelfDemote(true)
              else void save()
            }}
          >
            {S.saveRole}
          </Button>
        ) : null}
        {m.lastCurator || asking || changed ? null : (
          <Button
            blocked={blocked()}
            aria-label={m.you ? S.leave(brain.name) : S.remove(m.name)}
            onClick={() => setAsking(true)}
          >
            {m.you ? S.leaveShort : S.removeShort}
          </Button>
        )}
      </div>
      {asking ? (
        <div class="confirm">
          <p>{m.you ? S.removeSelfLead(brain.name) : S.removeLead(m.name, brain.name)}</p>
          <div class="actions">
            <Button
              id={`remove-yes-${m.accountId}`}
              kind="primary"
              pending={busy}
              pendingLabel={T.states.pending}
              blocked={blocked()}
              onClick={() => void remove()}
            >
              {m.you ? S.leaveNow(brain.name) : S.removeFrom(m.name, brain.name)}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setAsking(false)
                document.getElementById(`role-${m.accountId}`)?.focus()
              }}
            >
              {S.keep}
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog open={selfDemote} title={S.demoteSelfTitle} onClose={() => setSelfDemote(false)}>
        <p>{S.demoteSelfLead(brain.name, pick)}</p>
        <div class="actions">
          <Button
            kind="primary"
            onClick={() => {
              setSelfDemote(false)
              void save()
            }}
          >
            {S.demoteSelfConfirm}
          </Button>
          <Button kind="quiet" onClick={() => setSelfDemote(false)}>
            {S.keep}
          </Button>
        </div>
      </Dialog>
    </li>
  )
}

function Members({ brain, me: myId }: { brain: BrainInfo; me: string }) {
  const r = membersResource(brain.slug)
  const said = useSaid()
  const [failed, setFailed] = useState<{ id: string; error: ApiError } | null>(null)
  const [who, setWho] = useState('')
  const [role, setRole] = useState('contributor')
  const [problem, setProblem] = useState<string | null>(null)
  const [addError, setAddError] = useState<ApiError | null>(null)
  const [adding, setAdding] = useState(false)
  const rows = r.data.value ? memberRows(r.data.value.members, myId) : undefined

  // Someone already in the list: the form says so and the keyboard goes to their role.
  const already = (m: MemberRow) => {
    setAddError(null)
    setProblem(S.already(m.name, m.role))
    requestAnimationFrame(() => document.getElementById(`role-${m.accountId}`)?.focus())
  }
  const add = async (e: Event) => {
    e.preventDefault()
    if (adding || !online.value) return
    setAddError(null)
    said.say(null)
    const v = who.trim()
    if (!v) {
      setProblem(S.needWho)
      document.getElementById('member-who')?.focus()
      return
    }
    const known = rows?.find((m) => m.accountId === v || m.email?.toLowerCase() === v.toLowerCase())
    if (known) return already(known)
    setProblem(null)
    setAdding(true)
    try {
      const out = await api.call<{ member: { name: string; role: string } }>('addMember', {
        path: { slug: brain.slug },
        body: { account: v, role },
      })
      setWho('')
      await r.reload()
      said.say(S.added(out.member.name, out.member.role))
    } catch (err) {
      const a = err as ApiError
      if (a.code === 'already_member') {
        // Added meanwhile by someone else: the list is read again and the row named.
        await r.reload()
        const row = memberRows(r.data.value?.members ?? [], myId).find(
          (m) => m.accountId === v || m.email?.toLowerCase() === v.toLowerCase(),
        )
        if (row) already(row)
        else setProblem(a.message)
      } else setAddError(a)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Part id="members" title={S.members} lead={S.membersLead}>
      <Said text={said.said} id="members-said" focus={said.focus} />
      {!rows ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : (
        <ul class="list">
          {rows.map((m) => (
            <MemberItem
              key={m.accountId}
              m={m}
              brain={brain}
              failed={failed?.id === m.accountId ? failed.error : null}
              onFailed={(id, e) => setFailed(e ? { id, error: e } : null)}
              onSaved={async (text, you) => {
                await r.reload()
                said.say(text, true)
                if (you) {
                  // What I may do here changed: the brain is read again (a non-curator is shown why).
                  invalidate(`brain:${brain.slug}:basic`)
                  invalidate('brains')
                }
              }}
            />
          ))}
        </ul>
      )}
      <form class="settings-form add-form" aria-label={S.add} onSubmit={add} noValidate>
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
            <select
              id="member-role"
              value={role}
              aria-describedby={role === 'curator' ? 'member-role-hint' : undefined}
              onChange={(e) => setRole(e.currentTarget.value)}
            >
              {ROLES.map((x) => (
                <option key={x} value={x}>
                  {T.people.roles[x]}
                </option>
              ))}
            </select>
            {role === 'curator' ? (
              <span class="hint" id="member-role-hint">
                {S.curatorNotService}
              </span>
            ) : null}
          </div>
        </div>
        <div class="actions">
          <Button type="submit" pending={adding} pendingLabel={S.adding} blocked={blocked()}>
            {S.addButton}
          </Button>
        </div>
      </form>
    </Part>
  )
}

function Repositories({ brain, archived }: { brain: BrainInfo; archived: boolean }) {
  const r = reposResource(brain.slug)
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const said = useSaid()
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const key = repoKey(text)
  const t = text.trim()
  const verdict = !t ? null : key ? S.matches(key) : /^(\/|~|[a-z]:\\)/i.test(t) ? S.folder : S.notRepo
  const list = r.data.value?.repos
  useEffect(() => {
    if (asking) document.getElementById('unlink-yes')?.focus()
  }, [asking])

  const link = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value || archived) return
    setTried(true)
    setError(null)
    said.say(null)
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
      said.say(S.linked(out.repo))
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
      said.say(S.unlinked(repo), true)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Part id="repos" title={S.repos} lead={S.reposLead}>
      <Said text={said.said} id="repos-said" focus={said.focus} />
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
                      id="unlink-yes"
                      kind="primary"
                      pending={busy === x.repo}
                      pendingLabel={T.states.pending}
                      blocked={blocked()}
                      onClick={() => void unlink(x.repo)}
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
        {archived ? <p class="note">{S.archivedRepos}</p> : null}
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
          <Button
            type="submit"
            pending={pending}
            pendingLabel={S.linking}
            blocked={archived ? S.archivedRepos : blocked()}
          >
            {S.link}
          </Button>
        </div>
      </form>
    </Part>
  )
}

// A part of the settings: its own base (what its fields were when it read them), so a save sends only
// what it changed on top of what it saw, whatever other parts saved meanwhile. A conflict brings the
// current values, which become its base; what the person typed stays in the fields.
function usePart(slug: string) {
  const r = settingsResource(slug)
  const [base, setBase] = useState<Settings | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const said = useSaid()
  const [theirs, setTheirs] = useState<Settings | null>(null)
  // The base the fields were filled from: a field still showing it follows a new base (theirs after a
  // conflict, or what a save returned); a field the person changed keeps what they typed.
  const was = useRef<Settings | null>(null)
  // Read again when a tab opens (it may have changed meanwhile); the part starts from that fresh read.
  useFresh(r)
  useEffect(() => {
    if (r.data.value && !base && !r.loading.value) setBase(r.data.value)
  }, [r.data.value, r.loading.value])
  const save = async (edit: Parameters<typeof settingsSave>[1]): Promise<Settings | null> => {
    if (pending || !online.value || !base) return null
    // Always asked, even with nothing changed here: the server compares what this part shows.
    const body = settingsSave(base, edit)
    setError(null)
    setPending(true)
    said.say(null)
    try {
      const fresh = await api.call<Settings & { unchanged?: boolean }>('saveWikiSettings', {
        path: { slug },
        body,
      })
      r.data.value = fresh
      was.current = base
      setBase(fresh)
      setTheirs(null)
      said.say(fresh.unchanged ? S.nothing : S.saved)
      return fresh
    } catch (e) {
      const a = e as ApiError
      if (a.code === 'settings_changed' && a.current && typeof a.current === 'object') {
        const now = a.current as Settings
        r.data.value = now
        was.current = base
        setBase(now)
        setTheirs(now)
      } else setError(a)
      return null
    } finally {
      setPending(false)
    }
  }
  // Applied to the field's latest value, not the one of the last paint: what is typed meanwhile is kept.
  const follow = <K,>(field: (x: Settings) => K, set: (f: (prev: K) => K) => void) => {
    const before = was.current
    if (!before || !base || before === base) return
    const old = field(before)
    const now = field(base)
    set((prev) => (prev === old ? now : prev))
  }

  return { r, base, pending, error, said, theirs, save, follow }
}

function Conflict({ children }: { children?: ComponentChildren }) {
  return (
    <>
      <FormAlert error={{ message: S.changedTitle, howToProceed: S.changedHow }} />
      {children ? (
        <div class="theirs">
          <p class="meta">{S.theirs}</p>
          {children}
        </div>
      ) : null}
    </>
  )
}

// A part shows its fields only once its base is read: never an empty box to type in while the settings
// are on their way (the last known values come back with the read).
function PartBody({
  r,
  rows,
  ready,
  children,
}: {
  r: ReturnType<typeof settingsResource>
  rows: number
  ready: boolean
  children: ComponentChildren
}) {
  if (ready) return <>{children}</>
  if (r.data.value) return <Skeleton rows={rows} />
  return r.error.value ? (
    <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
  ) : (
    <Skeleton rows={rows} />
  )
}

// A text of the brain (the compile guide or the usage note): the default beside it, «reset to default»,
// one Save, a draft in this tab's memory per person and brain, and a conflict that keeps what was typed.
// The guide is long: it is folded until the person opens it.
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
  const { r, base, pending, error, said, theirs, save, follow } = usePart(slug)
  const [text, setText] = useState<string | null>(null)
  // The person set this text (typed it, or reset it to the default) even if it reads as the old base:
  // it is theirs, and a new base never replaces it.
  const chose = useRef(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [open, setOpen] = useState(!guide || textDrafts.get(account, slug, part) !== undefined)
  const max = guide ? 20_000 : 2000
  const current = base ? (guide ? base.guide : base.usageNote) : ''
  const fallback = base ? (guide ? base.guideDefault : base.usageNoteDefault) : ''
  // The field starts from the brain's text, or from what this person typed and did not save.
  useEffect(() => {
    if (base && text === null) setText(textDrafts.get(account, slug, part) ?? current)
    else if (!chose.current)
      follow(
        (x) => (guide ? x.guide : x.usageNote),
        (f) => setText((prev) => (prev === null ? prev : f(prev))),
      )
  }, [base])
  useEffect(() => {
    if (open && guide && text !== null) document.getElementById(`${part}-text`)?.focus()
  }, [open])
  const id = `${part}-text`
  const value = text ?? ''
  const isDefault = base ? (guide ? !base.customGuide : base.usageNote === base.usageNoteDefault) : true
  const label = guide ? S.guide : S.usage
  const submit = async (e: Event) => {
    e.preventDefault()
    if (value.trim().length > max) {
      setProblem(S.tooLong(max))
      document.getElementById(id)?.focus()
      return
    }
    const fresh = await save(guide ? { guide: value } : { usageNote: value })
    if (fresh) {
      chose.current = false
      textDrafts.clear(account, slug, part)
      setText(guide ? fresh.guide : fresh.usageNote)
    }
  }
  const hint =
    !value.trim() && guide
      ? S.emptyGuide
      : guide
        ? S.chars(value.length, max)
        : `${S.usageHint} ${S.chars(value.length, max)}`
  return (
    <Part id={part} title={label} lead={guide ? S.guideLead : S.usageLead}>
      <PartBody r={r} rows={guide ? 2 : 3} ready={base !== null}>
        <p class="meta">
          <span class={`tag ${isDefault ? '' : 'ok'}`}>{isDefault ? S.isDefault : S.isCustom}</span>
        </p>
        {!open ? (
          <>
            <pre class="command folded">
              <code>{current.split('\n').slice(0, 3).join('\n')}</code>
            </pre>
            <div class="actions">
              <Button onClick={() => setOpen(true)}>{S.editGuide}</Button>
            </div>
          </>
        ) : (
          <form class="settings-form" onSubmit={submit} noValidate>
            {archived ? <p class="note">{S.archivedNote}</p> : null}
            <FormAlert error={error} />
            {theirs ? (
              <Conflict>
                <pre class="command">
                  <code>{(guide ? theirs.guide : theirs.usageNote) || '—'}</code>
                </pre>
              </Conflict>
            ) : null}
            <TextArea
              id={id}
              label={label}
              hint={hint}
              rows={guide ? 12 : 4}
              value={value}
              problem={problem}
              onValue={(v) => {
                chose.current = true
                setText(v)
                said.say(null)
                setProblem(null)
                if (v === current) textDrafts.clear(account, slug, part)
                else textDrafts.set(account, slug, part, v)
              }}
            />
            <Said text={said.said} id={`${part}-said`} focus={said.focus} />
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
                  chose.current = true
                  setText(fallback)
                  if (fallback === current) textDrafts.clear(account, slug, part)
                  else textDrafts.set(account, slug, part, fallback)
                  said.say(S.resetNote)
                  document.getElementById(id)?.focus()
                }}
              >
                {S.resetDefault}
              </Button>
            </div>
            {guide && base ? (
              <details class="default-text">
                <summary class="default-summary">{S.showDefault}</summary>
                <pre class="command">
                  <code>{base.guideDefault}</code>
                </pre>
              </details>
            ) : null}
          </form>
        )}
      </PartBody>
    </Part>
  )
}

function Meaning({ slug, archived, account }: { slug: string; archived: boolean; account: string }) {
  const { r, base, pending, error, said, theirs, save, follow } = usePart(slug)
  const [out, setOut] = useState<boolean | null>(null)
  useEffect(() => {
    const kept = fieldDrafts.get(account, slug, 'meaningExcluded')
    if (base && out === null) setOut(kept === undefined ? base.meaningExcluded : kept === 'true')
    else
      follow(
        (x) => x.meaningExcluded,
        (f) => setOut((prev) => (prev === null ? prev : f(prev))),
      )
  }, [base])
  return (
    <Part id="meaning" title={S.meaning} lead={S.meaningLead}>
      <PartBody r={r} rows={1} ready={base !== null}>
        <form
          class="settings-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save({ meaningExcluded: out === true }).then((done) => {
              if (done) fieldDrafts.clear(account, slug, 'meaningExcluded')
            })
          }}
        >
          {archived ? <p class="note">{S.archivedNote}</p> : null}
          <FormAlert error={error} />
          {theirs ? (
            <Conflict>
              <p>{theirs.meaningExcluded ? S.theirsOut : S.theirsIn}</p>
            </Conflict>
          ) : null}
          <div class="pick">
            <input
              type="checkbox"
              id="meaning-out"
              checked={out === true}
              aria-describedby="meaning-out-hint"
              onChange={(e) => {
                const on = e.currentTarget.checked
                setOut(on)
                said.say(null)
                if (base && on === base.meaningExcluded) fieldDrafts.clear(account, slug, 'meaningExcluded')
                else fieldDrafts.set(account, slug, 'meaningExcluded', String(on))
              }}
            />
            <label for="meaning-out">{S.meaningOut}</label>
          </div>
          <p class="hint" id="meaning-out-hint">
            {S.meaningOutHint}
          </p>
          <Said text={said.said} id="meaning-said" focus={said.focus} />
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
      </PartBody>
    </Part>
  )
}

function Health({ slug, archived, account }: { slug: string; archived: boolean; account: string }) {
  const { r, base, pending, error, said, theirs, save, follow } = usePart(slug)
  const [v, setV] = useState<Record<ThresholdName, string> | null>(null)
  const [problems, setProblems] = useState<Partial<Record<ThresholdName, string>>>({})
  useEffect(() => {
    const kept = (k: ThresholdName) => fieldDrafts.get(account, slug, k)
    if (base && v === null)
      setV({
        staleDays: kept('staleDays') ?? String(base.staleDays),
        longChars: kept('longChars') ?? String(base.longChars),
        maintenanceEvery: kept('maintenanceEvery') ?? String(base.maintenanceEvery),
      })
    else
      for (const k of ['staleDays', 'longChars', 'maintenanceEvery'] as const)
        follow(
          (x) => String(x[k]),
          (f) => setV((prev) => (prev ? { ...prev, [k]: f(prev[k]) } : prev)),
        )
  }, [base])
  const fields: Array<{ k: ThresholdName; label: string; hint: string }> = [
    { k: 'staleDays', label: S.staleDays, hint: S.staleHint },
    { k: 'longChars', label: S.longChars, hint: S.longHint },
    { k: 'maintenanceEvery', label: S.every, hint: S.everyHint },
  ]
  return (
    <Part id="health" title={S.health} lead={S.healthLead}>
      <PartBody r={r} rows={2} ready={base !== null && v !== null}>
        {v ? (
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
                staleDays: Number(v.staleDays),
                longChars: Number(v.longChars),
                maintenanceEvery: Number(v.maintenanceEvery),
              }).then((done) => {
                if (done) for (const f of fields) fieldDrafts.clear(account, slug, f.k)
              })
            }}
          >
            {archived ? <p class="note">{S.archivedNote}</p> : null}
            <FormAlert error={error} />
            {theirs ? (
              <Conflict>
                <ul class="theirs-values">
                  {fields.map((f) => (
                    <li key={f.k}>
                      {f.label}: <strong>{theirs[f.k]}</strong>
                    </li>
                  ))}
                </ul>
              </Conflict>
            ) : null}
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
                    if (base && x === String(base[f.k])) fieldDrafts.clear(account, slug, f.k)
                    else fieldDrafts.set(account, slug, f.k, x)
                    said.say(null)
                    if (problems[f.k]) setProblems({ ...problems, [f.k]: undefined })
                  }}
                />
              ))}
            </div>
            <Said text={said.said} id="health-said" focus={said.focus} />
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
        ) : null}
      </PartBody>
    </Part>
  )
}

function Archive({ brain }: { brain: BrainInfo }) {
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const said = useSaid()
  const archived = brain.status === 'archived'
  const run = async (to: boolean) => {
    setPending(true)
    setError(null)
    try {
      await api.call(to ? 'archiveBrain' : 'unarchiveBrain', { path: { slug: brain.slug } })
      setAsking(false)
      await brainResource(brain.slug).reload()
      invalidate('brains')
      said.say(to ? S.archived(brain.name) : S.active(brain.name), true)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <Part id="archive" title={S.archive} lead={archived ? S.archivedLead : S.archiveLead}>
      <Said text={said.said} id="archive-said" focus={said.focus} />
      <FormAlert error={asking ? null : error} />
      <ul class="plain-list">
        <li>{S.archiveStops}</li>
        <li>{S.archiveKeeps}</li>
      </ul>
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

// Export (spec B7): the zip is made by the server as it is read; the screen says what has arrived until it is
// whole, then saves it under the server's name and says so. A refusal keeps the choices and says what to do.
function Export({ brain }: { brain: BrainInfo }) {
  const [format, setFormat] = useState<ExportFormat>('readable')
  const [forgotten, setForgotten] = useState(false)
  const [busy, setBusy] = useState(false)
  const [received, setReceived] = useState<number | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    setError(null)
    setSaved(null)
    setReceived(null)
    try {
      const got = await api.download('exportBrain', exportAsk(brain.slug, format, forgotten), setReceived)
      const href = URL.createObjectURL(got.blob)
      const a = document.createElement('a')
      a.href = href
      a.download = got.name
      document.body.append(a)
      a.click()
      a.remove()
      // The browser has taken the file once the click is handled; the address is let go a while later.
      setTimeout(() => URL.revokeObjectURL(href), 60_000)
      setSaved(S.exportSaved(got.name, sizeLabel(got.bytes)))
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setBusy(false)
    }
  }
  const choice = (value: ExportFormat, label: string, hint: string) => (
    <div class="pick">
      <input
        type="radio"
        name="export-format"
        id={`export-${value}`}
        checked={format === value}
        aria-describedby={`export-${value}-hint`}
        onChange={() => {
          setFormat(value)
          setSaved(null)
        }}
      />
      <label for={`export-${value}`}>{label}</label>
      <span class="reason" id={`export-${value}-hint`}>
        {hint}
      </span>
    </div>
  )
  return (
    <Part id="export" title={S.exportTitle} lead={S.exportLead}>
      <form
        class="export-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) void go()
        }}
      >
        <FormAlert error={error} />
        <fieldset class="choices">
          <legend>{S.exportFormat}</legend>
          {choice('readable', S.exportReadable, S.exportReadableHint)}
          {choice('faithful', S.exportFaithful, S.exportFaithfulHint)}
        </fieldset>
        <div class="pick">
          <input
            type="checkbox"
            id="export-forgotten"
            checked={forgotten}
            aria-describedby="export-forgotten-hint"
            onChange={(e) => {
              setForgotten(e.currentTarget.checked)
              setSaved(null)
            }}
          />
          <label for="export-forgotten">{S.exportForgotten}</label>
          <span class="reason" id="export-forgotten-hint">
            {S.exportForgottenHint}
          </span>
        </div>
        <div class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={busy}
            pendingLabel={S.exportPreparing}
            blocked={blocked()}
          >
            {S.exportButton}
          </Button>
        </div>
        <p class={busy ? 'said' : 'said ok'} role="status">
          {busy ? S.exportWorking(received === null ? null : sizeLabel(received)) : saved}
        </p>
      </form>
    </Part>
  )
}

// Import (spec B7 «Importar»): a .zip of a documentation folder or a faithful export goes up into this brain while
// it is empty. The file is checked before it goes (a .zip, not empty, at most 50 MB); while it goes the screen says
// how much has; then that the server is writing; then what came in and what did not, and where to look. A refusal
// keeps the file chosen and says what to do. A brain with content says so instead of offering the form.
function Import({ brain }: { brain: BrainInfo }) {
  const I = S.import
  const ov = overviewResource(brain.slug)
  const o = ov.data.value
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<[number, number] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState<{ report: ImportReport; file: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const saidRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (done) saidRef.current?.focus()
  }, [done])
  const full = o
    ? o.stats.pages + o.stats.entries + o.stats.pendingProposals > 0 || o.firstSteps.imported
    : false
  const go = async () => {
    if (!file) {
      setProblem(problem ?? I.choose)
      input.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    setSent([0, file.size])
    try {
      const got = await api.upload<{ report: ImportReport }>(
        'importBrain',
        importAsk(brain.slug, file.name),
        file,
        (s, t) => setSent([s, t]),
      )
      setDone({ report: got.report, file: file.name })
      invalidate(`brain:${brain.slug}`)
      invalidate('brains')
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setBusy(false)
      setSent(null)
    }
  }
  const status =
    busy && sent ? (sent[0] < sent[1] ? I.sending(sizeLabel(sent[0]), sizeLabel(sent[1])) : I.working) : null
  const href = (p: string) => `/b/${encodeURIComponent(brain.slug)}${p}`
  return (
    <Part id="import" title={I.title} lead={I.lead}>
      {done ? (
        <section class="import-report" aria-labelledby="import-report-title">
          <h3 id="import-report-title" tabIndex={-1} ref={saidRef}>
            {I.reportTitle}
          </h3>
          <p class="said ok" role="status">
            {importDone(done.report, done.file)}
          </p>
          {done.report.people ? (
            <p>{I.people(done.report.people.matched, done.report.people.authors)}</p>
          ) : null}
          <div class="actions">
            <a class="button primary" href={href('/wiki')}>
              {I.openWiki}
            </a>
            <a class="button secondary" href={href('/wiki/graph')}>
              {I.openGraph}
            </a>
          </div>
          {done.report.totals.ignored ? (
            <details>
              <summary class="import-count">{I.ignored(done.report.totals.ignored)}</summary>
              <ul class="plain-list">
                {done.report.ignored.map((i) => (
                  <li key={i.path}>
                    <code>{i.path}</code> — {whyText(i.why)}
                  </li>
                ))}
              </ul>
              {done.report.totals.ignored > done.report.ignored.length ? (
                <p class="muted">{I.more(done.report.totals.ignored - done.report.ignored.length)}</p>
              ) : null}
            </details>
          ) : null}
          {done.report.totals.unresolved ? (
            <details>
              <summary class="import-count">{I.unresolved(done.report.totals.unresolved)}</summary>
              <ul class="plain-list">
                {done.report.unresolved.map((u) => (
                  <li key={`${u.from} ${u.target}`}>
                    <code>{u.target}</code> {I.from(u.from)}
                  </li>
                ))}
              </ul>
              {done.report.totals.unresolved > done.report.unresolved.length ? (
                <p class="muted">{I.more(done.report.totals.unresolved - done.report.unresolved.length)}</p>
              ) : null}
            </details>
          ) : null}
          {done.report.totals.renamed ? (
            <details>
              <summary class="import-count">{I.renamed(done.report.totals.renamed)}</summary>
              <ul class="plain-list">
                {done.report.renamed.map((r) => (
                  <li key={r.path}>
                    <code>{r.path}</code> {I.becomes} <code>{r.address}</code>
                  </li>
                ))}
              </ul>
              {done.report.totals.renamed > done.report.renamed.length ? (
                <p class="muted">{I.more(done.report.totals.renamed - done.report.renamed.length)}</p>
              ) : null}
            </details>
          ) : null}
        </section>
      ) : brain.status === 'archived' ? (
        <p class="alert warn">{I.archived}</p>
      ) : full ? (
        <p class="alert warn">{I.already}</p>
      ) : (
        <form
          class="import-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) void go()
          }}
        >
          <ul class="plain-list">
            {I.what.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p>{I.emptyOnly}</p>
          <p class="muted">{I.peopleLead}</p>
          <FormAlert error={error} />
          <div class="field">
            <label for="import-file">{I.file}</label>
            <span class="hint" id="import-file-hint">
              {I.fileHint}
            </span>
            <input
              ref={input}
              id="import-file"
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              aria-describedby={`import-file-hint${problem ? ' import-file-problem' : ''}`}
              aria-invalid={problem ? 'true' : undefined}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0] ?? null
                setError(null)
                const p = f ? fileProblem(f) : null
                setProblem(p)
                setFile(f && !p ? f : null)
              }}
            />
            {problem ? (
              <span class="problem" id="import-file-problem">
                {problem}
              </span>
            ) : null}
          </div>
          <div class="actions">
            <Button type="submit" kind="primary" pending={busy} pendingLabel={I.pending} blocked={blocked()}>
              {I.button}
            </Button>
          </div>
          <p class="said" role="status">
            {status}
          </p>
        </form>
      )}
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

// Arriving on a tab (by a link or by changing tab), the keyboard goes to its first heading, never to the
// page; unless the person is already typing somewhere.
function TabFocus({ tab }: { tab: SettingsTab }) {
  useEffect(() => {
    focusOnArrival(document.querySelector<HTMLElement>('.settings-tab h2'))
  }, [tab])
  return null
}

const TABS: Array<{ tab: SettingsTab; path: string; label: string }> = [
  { tab: 'members', path: '', label: S.tabs.members },
  { tab: 'agents', path: '/agents', label: S.tabs.agents },
  { tab: 'health', path: '/health', label: S.tabs.health },
  { tab: 'import', path: '/import', label: S.tabs.import },
  { tab: 'archive', path: '/archive', label: S.tabs.archive },
]

export function BrainSettings({ slug, tab }: { slug: string; tab: SettingsTab }) {
  const who = me().data.value
  const b = brainResource(slug)
  const brain = b.data.value?.brain
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
          <p class="how">{S.cannotHow(brain.name, curatorNames(brain.slug))}</p>
        </div>
      </>
    )
  }
  const archived = brain.status === 'archived'
  const info: BrainInfo = { slug: brain.slug, name: brain.name, role: brain.role, status: brain.status }
  const base = `/b/${encodeURIComponent(brain.slug)}/settings`
  return (
    <div class="settings">
      <div class="title-row">
        <div class="title-group">
          <h1 class="title">{S.title}</h1>
          <span class="meta">{brain.name}</span>
        </div>
      </div>
      <p class="lead">{S.lead(brain.name)}</p>
      {archived ? <p class="alert warn">{S.archivedBanner}</p> : null}
      <nav class="tabs" aria-label={S.tabsLabel}>
        <ul class="tab-list">
          {TABS.map((t) => (
            <li key={t.tab}>
              <a href={`${base}${t.path}`} aria-current={t.tab === tab ? 'page' : undefined}>
                {t.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <TabFocus tab={tab} />
      <div class="settings-tab">
        {tab === 'members' ? <Members brain={info} me={who.account.id} /> : null}
        {tab === 'agents' ? (
          <>
            <Repositories brain={info} archived={archived} />
            <TextPart slug={brain.slug} archived={archived} account={who.account.id} part="usage" />
            <TextPart slug={brain.slug} archived={archived} account={who.account.id} part="guide" />
            <Meaning slug={brain.slug} archived={archived} account={who.account.id} />
          </>
        ) : null}
        {tab === 'health' ? <Health slug={brain.slug} archived={archived} account={who.account.id} /> : null}
        {tab === 'import' ? <Import brain={info} /> : null}
        {tab === 'archive' ? (
          <>
            <Export brain={info} />
            <Archive brain={info} />
            {who.account.isAdmin ? <Delete brain={info} /> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
