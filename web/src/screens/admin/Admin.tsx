// The administration (spec B6 «Admin», plan T047; PR25a: People, Invitations, Service accounts). Who:
// the administrators of the installation. Jobs: see everyone with their role in each brain, when they were
// last seen and whether they are active; give and take administration and «can create brains»;
// deactivate and reactivate; help someone who cannot sign in; follow invitations; run the service
// accounts programs use, with their main keys (shown once, rotated, revoked) and the short keys they mint.
// Done when: each change says so, in words. Risks: an installation left without an administrator
// (refused by the server, and said on the row before anyone tries); a main key that leaks (it lives only
// in this screen's memory, is shown once, and is gone when hidden or when the page is put away). Who may
// do what is the server's (B4); this screen only offers it to whoever may.

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'
import { ago } from '../../lib/brains.ts'
import { leftAdmin, rightsChanged, takeLeftAdmin } from '../../lib/flags.ts'
import {
  type AdminAccount,
  type PersonRow,
  peopleRows,
  refsLabel,
  rolesLabel,
  serviceRows,
} from '../../lib/settings.ts'
import { type Me, me, online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { CopyButton } from '../../ui/CopyButton.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Field } from '../../ui/Field.tsx'
import { writeBlocked } from '../../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { allBrainsResource, InvitePeople, LinksOf, resetLinkOf, useLinks } from '../People.tsx'

const A = T.admin
const blocked = () => writeBlocked({ online: online.value, pending: false })

type Key = {
  id: string
  kind: string
  name: string
  last4: string
  createdAt: string
  lastUsedAt: string | null
  status: string
  liveShortKeys?: number
  liveShortRefs?: string[]
}
const keysResource = (id: string) =>
  resource<{ keys: Key[] }>(`admin:keys:${id}`, () =>
    api.call<{ keys: Key[] }>('accountKeys', { path: { id } }),
  )
// The same list as People's (one key, one request), read with the fields the administration uses.
const adminAccounts = () =>
  resource<{ accounts: AdminAccount[] }>('admin:accounts', () =>
    api.call<{ accounts: AdminAccount[] }>('accounts'),
  )

const TABS = [
  { href: '/admin/people', label: A.people },
  { href: '/admin/invitations', label: A.invitations },
  { href: '/admin/services', label: A.services },
  { href: '/admin/email', label: A.email },
  { href: '/admin/meaning', label: A.meaning },
  { href: '/admin/limits', label: A.limits },
  { href: '/admin/audit', label: A.audit },
  { href: '/admin/system', label: A.system },
  { href: '/admin/branding', label: A.branding },
]

// The frame of every page of the administration: its title, its sections, and the way out for whoever
// is not an administrator (spec B6 «Sin permiso»: why, and whom to ask).
export function AdminFrame({ children }: { children: (who: Me) => ComponentChildren }) {
  const { path } = useLocation()
  const who = me().data.value
  // «You removed your own administrator rights» is said once, then the flag is gone.
  const [left, setLeft] = useState(false)
  const out = who !== undefined && !who.account.isAdmin
  useEffect(() => {
    if (out && takeLeftAdmin()) setLeft(true)
  }, [out])
  if (!who) return <Skeleton rows={3} />
  return (
    <div class="admin">
      <div class="title-row">
        <h1 class="title">{A.title}</h1>
      </div>
      {who.account.isAdmin ? (
        <>
          <nav class="tabs" aria-label={A.nav}>
            <ul class="tab-list">
              {TABS.map((t) => (
                <li key={t.href}>
                  <a href={t.href} aria-current={path === t.href ? 'page' : undefined}>
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {children(who)}
        </>
      ) : (
        <div class="state forbidden" role="alert" data-state="forbidden">
          <span class="kind">{T.kind.noAccess}</span>
          <h2>{T.states.forbiddenTitle}</h2>
          <p>{left || leftAdmin.value ? A.leftAdmin : A.cannot}</p>
          <p class="how">
            {left || leftAdmin.value
              ? A.leftAdminHow
              : A.cannotHow(me().data.value?.installation.admins ?? [])}
          </p>
        </div>
      )}
    </div>
  )
}

// What a change says, announced; `focus` bumps to take the keyboard there once drawn (the control pressed
// may be gone or changed), so it never falls to the page.
export function Said({ text, focus = 0 }: { text: string | null; focus?: number }) {
  useEffect(() => {
    if (focus) document.getElementById('admin-said')?.focus()
  }, [focus])
  return (
    <p class="said ok" role="status" tabIndex={-1} id="admin-said">
      {text}
    </p>
  )
}

export function useSaid() {
  const [said, setSaid] = useState<string | null>(null)
  const [focus, setFocus] = useState(0)
  return {
    said,
    focus,
    say: (t: string | null, take = false) => {
      setSaid(t)
      if (take && t) setFocus((n) => n + 1)
    },
  }
}

// Deactivating says what ends now and what stays, and asks first.
function DeactivateDialog({
  a,
  onClose,
  onDone,
}: {
  a: { id: string; name: string; kind?: string } | null
  onClose: () => void
  onDone: (out: { brainsWithoutCurator: string[] }) => void
}) {
  const service = a?.kind === 'service'
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => setError(null), [a?.id])
  return (
    <Dialog open={a !== null} title={a ? A.deactivateTitle(a.name) : ''} onClose={onClose}>
      {a ? (
        <>
          <p>{service ? A.deactivateServiceLead(a.name) : A.deactivateLead(a.name)}</p>
          <p>{service ? A.deactivateServiceKeeps(a.name) : A.deactivateKeeps(a.name)}</p>
          <FormAlert error={error} />
          <div class="actions">
            <Button
              kind="primary"
              pending={pending}
              pendingLabel={T.states.pending}
              blocked={blocked()}
              onClick={async () => {
                setPending(true)
                setError(null)
                try {
                  onDone(
                    await api.call<{ brainsWithoutCurator: string[] }>('removeAccount', {
                      path: { id: a.id },
                    }),
                  )
                } catch (e) {
                  setError(e as ApiError)
                } finally {
                  setPending(false)
                }
              }}
            >
              {A.deactivate(a.name)}
            </Button>
            <Button kind="quiet" onClick={onClose}>
              {T.settings.cancel}
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  )
}

const PAGE = 20

function PeopleList({ who }: { who: Me }) {
  const r = adminAccounts()
  useFresh(r)
  const { links, newest, announce } = useLinks()
  const said = useSaid()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ id: string; error: ApiError } | null>(null)
  const [asking, setAsking] = useState<PersonRow | null>(null)
  const [rights, setRights] = useState<{ a: PersonRow; to: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'removed'>('all')
  const [shown, setShown] = useState(PAGE)
  const all = r.data.value ? peopleRows(r.data.value.accounts) : undefined
  const q = query.trim().toLowerCase()
  const rows = all?.filter(
    (a) =>
      (status === 'all' || a.status === status) &&
      (!q || a.name.toLowerCase().includes(q) || (a.email ?? '').toLowerCase().includes(q)),
  )
  const filtered = Boolean(q) || status !== 'all'

  const act = async (a: PersonRow, run: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(a.id)
    setFailed(null)
    said.say(null)
    try {
      await run()
      await r.reload()
      said.say(done, true)
      return true
    } catch (e) {
      setFailed({ id: a.id, error: e as ApiError })
      await r.reload()
      return false
    } finally {
      setBusy(null)
    }
  }
  const patch = async (a: PersonRow, body: Record<string, boolean>, done: string) => {
    const ok = await act(a, () => api.call('updateAccount', { path: { id: a.id }, body }), done)
    // My own rights changed: who I am is read again, and the screens follow (out of here, if not admin).
    const self = a.id === who.account.id
    rightsChanged({ ok, self, body })
    if (ok && self) {
      await me().reload()
    }
  }
  // After «Show more», the keyboard goes to the first person just shown (the button may be gone).
  const [moreAt, setMoreAt] = useState(0)
  useEffect(() => {
    if (moreAt) document.querySelectorAll<HTMLElement>('li[data-person]')[moreAt]?.focus()
  }, [moreAt])

  return (
    <section aria-labelledby="accounts-title">
      <h2 id="accounts-title" class="section-title flush" tabIndex={-1} data-start>
        {T.people.peopleTitle}
      </h2>
      <p class="muted">
        {A.peopleLead} <a href="/admin/invitations">{A.inviteLink}</a>
      </p>
      <p class="sr-only" role="status">
        {announce}
      </p>
      <Said text={said.said} focus={said.focus} />
      {all && all.length > 1 ? (
        <div class="filters admin-filters">
          <Field
            id="people-find"
            label={A.find}
            type="search"
            value={query}
            onValue={(v) => {
              setQuery(v)
              setShown(PAGE)
            }}
          />
          <div class="field">
            <label for="people-status">{A.status}</label>
            <select
              id="people-status"
              value={status}
              onChange={(e) => {
                setStatus(e.currentTarget.value as typeof status)
                setShown(PAGE)
              }}
            >
              <option value="all">{A.showAll}</option>
              <option value="active">{A.active}</option>
              <option value="removed">{A.deactivated}</option>
            </select>
          </div>
        </div>
      ) : null}
      {!rows ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : rows.length === 0 && filtered ? (
        <div class="quiet-empty" data-state="filtered-empty">
          <p>{T.states.filteredEmpty}</p>
          <Button
            onClick={() => {
              setQuery('')
              setStatus('all')
              document.getElementById('people-find')?.focus()
            }}
          >
            {T.states.clearFilters}
          </Button>
        </div>
      ) : (
        <>
          <ul class="list admin-list">
            {rows.slice(0, shown).map((a) => {
              const you = a.id === who.account.id
              const active = a.status === 'active'
              return (
                <li key={a.id} class="with-actions" data-person={a.id} tabIndex={-1}>
                  <div>
                    <p class="list-title">
                      {a.name}
                      {you ? <span class="tag">{T.people.you}</span> : null}
                      <span class={`tag ${active ? 'ok' : 'warn'}`}>{active ? A.active : A.deactivated}</span>
                      {a.isAdmin ? <span class="tag">{A.admin}</span> : null}
                      {!a.isAdmin && a.canCreateBrains ? <span class="tag">{A.creates}</span> : null}
                      {a.lastAdmin ? <span class="tag ok">{A.onlyAdmin}</span> : null}
                    </p>
                    <p class="meta">
                      {a.email ? <span class="mono wrap">{a.email}</span> : null}
                      {a.email ? ' · ' : ''}
                      {T.people.seen(ago(a.lastSeenAt))}
                    </p>
                    <p class="meta">{rolesLabel(a.roles)}</p>
                    {failed?.id === a.id ? (
                      <p class="problem" role="alert">
                        {failed.error.message} {failed.error.howToProceed}
                      </p>
                    ) : null}
                  </div>
                  <div class="actions admin-actions">
                    {active ? (
                      <Button
                        kind="quiet"
                        pending={busy === a.id}
                        pendingLabel={T.states.pending}
                        blocked={a.isAdmin && a.lastAdmin ? A.onlyAdminWhy : blocked()}
                        aria-label={a.isAdmin ? A.unAdmin(a.name) : A.makeAdmin(a.name)}
                        onClick={() => setRights({ a, to: !a.isAdmin })}
                      >
                        {a.isAdmin ? A.unAdminShort : A.makeAdminShort}
                      </Button>
                    ) : null}
                    {active && !a.isAdmin ? (
                      <Button
                        kind="quiet"
                        blocked={blocked()}
                        aria-label={a.canCreateBrains ? A.stopCreate(a.name) : A.allowCreate(a.name)}
                        onClick={() =>
                          void patch(
                            a,
                            { canCreateBrains: !a.canCreateBrains },
                            a.canCreateBrains ? A.cannotCreateNow(a.name) : A.canCreateNow(a.name),
                          )
                        }
                      >
                        {a.canCreateBrains ? A.stopCreateShort : A.allowCreateShort}
                      </Button>
                    ) : null}
                    {active && !you ? (
                      <Button
                        kind="quiet"
                        blocked={blocked()}
                        aria-label={T.people.resetOf(a.name)}
                        onClick={async () => {
                          setFailed(null)
                          try {
                            const out = await api.call<{ link: string }>('resetLink', { path: { id: a.id } })
                            links.add([resetLinkOf(a, out, a.id)])
                          } catch (e) {
                            setFailed({ id: a.id, error: e as ApiError })
                          }
                        }}
                      >
                        {T.people.reset}
                      </Button>
                    ) : null}
                    {you ? null : active ? (
                      <Button
                        kind="quiet"
                        blocked={a.lastAdmin ? A.onlyAdminWhy : blocked()}
                        aria-label={A.deactivate(a.name)}
                        onClick={() => setAsking(a)}
                      >
                        {A.deactivateShort}
                      </Button>
                    ) : (
                      <Button
                        kind="quiet"
                        pending={busy === a.id}
                        pendingLabel={T.states.pending}
                        blocked={blocked()}
                        aria-label={A.reactivate(a.name)}
                        onClick={() =>
                          void act(
                            a,
                            () => api.call('restoreAccount', { path: { id: a.id } }),
                            A.reactivated(a.name),
                          )
                        }
                      >
                        {A.reactivateShort}
                      </Button>
                    )}
                  </div>
                  <LinksOf links={links} of={a.id} newest={newest} />
                </li>
              )
            })}
          </ul>
          {rows.length > shown ? (
            <div class="actions">
              <Button
                onClick={() => {
                  setMoreAt(shown)
                  setShown(shown + PAGE)
                }}
              >
                {A.showMore(rows.length - shown)}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={rights !== null}
        title={
          rights
            ? rights.to
              ? A.makeAdminTitle(rights.a.name)
              : rights.a.id === who.account.id
                ? A.unAdminSelfTitle
                : A.unAdminTitle(rights.a.name)
            : ''
        }
        onClose={() => setRights(null)}
      >
        {rights ? (
          <>
            <p>
              {rights.to
                ? A.makeAdminLead(rights.a.name)
                : rights.a.id === who.account.id
                  ? A.unAdminSelfLead
                  : A.unAdminLead(rights.a.name)}
            </p>
            <div class="actions">
              <Button
                kind="primary"
                blocked={blocked()}
                onClick={() => {
                  const { a, to } = rights
                  setRights(null)
                  void patch(a, { isAdmin: to }, to ? A.nowAdmin(a.name) : A.noLongerAdmin(a.name))
                }}
              >
                {rights.to
                  ? A.makeAdmin(rights.a.name)
                  : rights.a.id === who.account.id
                    ? A.unAdminSelf
                    : A.unAdmin(rights.a.name)}
              </Button>
              <Button kind="quiet" onClick={() => setRights(null)}>
                {T.settings.cancel}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
      <DeactivateDialog
        a={asking}
        onClose={() => setAsking(null)}
        onDone={async (out) => {
          const name = asking?.name ?? ''
          setAsking(null)
          links.drop({ of: asking?.id ?? '' })
          await r.reload()
          invalidate('admin:brains')
          said.say(
            out.brainsWithoutCurator.length
              ? `${A.deactivated_(name)} ${A.orphans(out.brainsWithoutCurator)}`
              : A.deactivated_(name),
            true,
          )
        }}
      />
    </section>
  )
}

export function AdminPeople() {
  return <AdminFrame>{(who) => <PeopleList who={who} />}</AdminFrame>
}

export function AdminInvitations() {
  return (
    <AdminFrame>
      {(who) => (
        <>
          <p class="lead">{T.people.lead}</p>
          <InvitePeople who={who} filter />
        </>
      )}
    </AdminFrame>
  )
}

// A main key, shown once, next to what made it.
type Shown = { of: string; name: string; secret: string; rotate: boolean }

function OnceKey({ k, onDone }: { k: Shown; onDone: () => void }) {
  useEffect(() => {
    const b = document.getElementById('copy-main-key')
    b?.focus({ preventScroll: true })
    b?.scrollIntoView({ block: 'center' })
  }, [k.secret])
  return (
    <section class="once" aria-label={A.keyOf(k.name)}>
      <p class="list-title">{A.keyOf(k.name)}</p>
      <p>{A.keyOnce}</p>
      <pre class="command">
        <code>{k.secret}</code>
      </pre>
      {k.rotate ? <p class="meta">{A.rotateNote}</p> : null}
      <div class="actions">
        <CopyButton text={k.secret} label={A.copyKey} id="copy-main-key" />
        <Button kind="primary" onClick={onDone}>
          {A.hideKey}
        </Button>
      </div>
    </section>
  )
}

function Keys({ id, active, onSaid }: { id: string; active: boolean; onSaid: (s: string) => void }) {
  const r = keysResource(id)
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const keys = r.data.value?.keys.filter((k) => k.kind === 'main')
  if (!keys)
    return r.error.value ? (
      <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
    ) : (
      <p class="meta">{A.loadingKeys}</p>
    )
  const live = keys.filter((k) => k.status === 'active').length
  if (!keys.length) return active ? <p class="meta">{A.noKeys}</p> : null
  return (
    <div class="main-keys">
      <p class="part-title">{A.mainKeys}</p>
      {active && !live ? <p class="meta">{A.noKeys}</p> : null}
      <FormAlert error={error} />
      <ul class="list compact">
        {keys.map((k) => (
          <li key={k.id} class="with-actions">
            <div>
              <p class="list-title">
                <span class="mono">…{k.last4}</span>{' '}
                {k.status !== 'active' ? <span class="tag warn">{A.keyRevoked}</span> : null}
              </p>
              <p class="meta">{A.keyLine(T.date(k.createdAt), ago(k.lastUsedAt))}</p>
              {k.status === 'active' ? (
                <p class="meta wrap">{refsLabel(k.liveShortKeys ?? 0, k.liveShortRefs ?? [])}</p>
              ) : null}
            </div>
            {k.status !== 'active' ? null : asking === k.id ? (
              <div class="confirm">
                <p>{A.revokeLead}</p>
                <div class="actions">
                  <Button
                    kind="primary"
                    pending={busy === k.id}
                    pendingLabel={T.states.pending}
                    blocked={blocked()}
                    autoFocus
                    onClick={async () => {
                      setBusy(k.id)
                      setError(null)
                      try {
                        await api.call('revokeKey', { path: { id: k.id } })
                        setAsking(null)
                        await r.reload()
                        onSaid(A.revoked(k.last4))
                      } catch (e) {
                        setError(e as ApiError)
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    {A.revokeConfirm(k.last4)}
                  </Button>
                  <Button kind="quiet" onClick={() => setAsking(null)}>
                    {T.settings.keep}
                  </Button>
                </div>
              </div>
            ) : (
              <div class="actions">
                <Button blocked={blocked()} aria-label={A.revoke(k.last4)} onClick={() => setAsking(k.id)}>
                  {A.revokeShort}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function NewService({ onMade }: { onMade: (s: Shown) => void }) {
  const brains = allBrainsResource().data.value?.brains.filter((b) => b.status !== 'archived')
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <form
      class="form invite-form"
      aria-label={A.newService}
      noValidate
      onSubmit={async (e) => {
        e.preventDefault()
        if (pending || !online.value) return
        const n = name.trim()
        if (!n || n.length > 80) {
          setProblem(A.needName)
          document.getElementById('service-name')?.focus()
          return
        }
        setProblem(null)
        setError(null)
        setPending(true)
        try {
          const out = await api.call<{ account: { id: string }; key: { secret: string } }>('createService', {
            body: { name: n, brains: Object.entries(chosen).map(([slug, role]) => ({ slug, role })) },
          })
          setName('')
          setChosen({})
          invalidate('admin:')
          onMade({ of: out.account.id, name: n, secret: out.key.secret, rotate: false })
        } catch (err) {
          setError(err as ApiError)
        } finally {
          setPending(false)
        }
      }}
    >
      <h2 tabIndex={-1} data-start>
        {A.newService}
      </h2>
      <FormAlert error={error} />
      <Field
        id="service-name"
        label={A.name}
        hint={A.nameHint}
        value={name}
        problem={problem}
        autocomplete="off"
        onValue={(v) => {
          setName(v)
          setProblem(null)
        }}
      />
      <fieldset class="brains-pick">
        <legend>{A.serviceBrains}</legend>
        <span class="hint">{A.serviceBrainsHint}</span>
        {!brains ? <Skeleton rows={1} /> : null}
        {brains?.map((b) => {
          const on = b.slug in chosen
          const id = `svc-pick-${b.slug}`
          return (
            <div class="pick" key={b.slug}>
              <input
                type="checkbox"
                id={id}
                checked={on}
                onChange={(e) => {
                  const next = { ...chosen }
                  if (e.currentTarget.checked) next[b.slug] = 'contributor'
                  else delete next[b.slug]
                  setChosen(next)
                }}
              />
              <label for={id}>{b.name}</label>
              <select
                aria-label={A.serviceRole(b.name)}
                value={chosen[b.slug] ?? 'contributor'}
                disabled={!on}
                onChange={(e) => setChosen({ ...chosen, [b.slug]: e.currentTarget.value })}
              >
                {(['contributor', 'reader'] as const).map((x) => (
                  <option key={x} value={x}>
                    {T.people.roles[x]}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
      </fieldset>
      <div class="actions">
        <Button type="submit" kind="primary" pending={pending} pendingLabel={A.creating} blocked={blocked()}>
          {A.create}
        </Button>
      </div>
    </form>
  )
}

function Services() {
  const r = adminAccounts()
  useFresh(r)
  const [shown, setShown] = useState<Shown | null>(null)
  const { said, focus, say } = useSaid()
  const setSaid = (t: string | null) => say(t, true)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ id: string; error: ApiError } | null>(null)
  const [asking, setAsking] = useState<AdminAccount | null>(null)
  const hidden = useRef('')

  // Put in the back/forward cache, the key shown is forgotten.
  useEffect(() => {
    const away = () => setShown(null)
    window.addEventListener('pagehide', away)
    return () => window.removeEventListener('pagehide', away)
  }, [])
  const rows = r.data.value ? serviceRows(r.data.value.accounts) : undefined
  const hide = () => {
    hidden.current = shown?.name ?? ''
    setShown(null)
    setSaid(A.hidden(hidden.current))
  }
  const live = (id: string) =>
    keysResource(id).data.value?.keys.filter((k) => k.kind === 'main' && k.status === 'active').length ?? 0
  return (
    <div class="people">
      <div class="people-main">
        <NewService
          onMade={(s) => {
            say(null)
            setShown(s)
          }}
        />
        {shown && !rows?.some((x) => x.id === shown.of) ? <OnceKey k={shown} onDone={hide} /> : null}
      </div>
      <div class="people-side">
        <section aria-labelledby="services-title">
          <h2 id="services-title" class="section-title flush">
            {A.services}
          </h2>
          <p class="muted">{A.servicesLead}</p>
          <Said text={said} focus={focus} />
          {!rows ? (
            r.error.value ? (
              <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
            ) : (
              <Skeleton rows={2} />
            )
          ) : rows.length === 0 ? (
            <div class="quiet-empty" data-state="empty">
              <p class="list-title">{A.noServices}</p>
              <p class="muted">{A.noServicesLead}</p>
            </div>
          ) : (
            <ul class="list admin-list">
              {rows.map((v) => {
                const active = v.status === 'active'
                return (
                  <li key={v.id} class="with-actions service">
                    <div>
                      <p class="list-title">
                        {v.name}
                        <span class={`tag ${active ? 'ok' : 'warn'}`}>
                          {active ? A.active : A.deactivated}
                        </span>
                        {v.canCreateBrains ? <span class="tag">{A.creates}</span> : null}
                      </p>
                      <p class="meta">
                        {rolesLabel(v.roles)} · {A.used(ago(v.lastSeenAt))}
                      </p>
                      {failed?.id === v.id ? (
                        <p class="problem" role="alert">
                          {failed.error.message} {failed.error.howToProceed}
                        </p>
                      ) : null}
                    </div>
                    <div class="actions admin-actions">
                      {active ? (
                        <>
                          <Button
                            pending={busy === v.id}
                            pendingLabel={T.states.pending}
                            blocked={live(v.id) >= 2 ? A.twoKeys : blocked()}
                            aria-label={A.newKey(v.name)}
                            onClick={async () => {
                              setBusy(v.id)
                              setFailed(null)
                              say(null)
                              try {
                                const out = await api.call<{ key: { secret: string } }>('newMainKey', {
                                  path: { id: v.id },
                                  body: { name: 'main' },
                                })
                                await keysResource(v.id).reload()
                                setShown({ of: v.id, name: v.name, secret: out.key.secret, rotate: true })
                              } catch (e) {
                                setFailed({ id: v.id, error: e as ApiError })
                              } finally {
                                setBusy(null)
                              }
                            }}
                          >
                            {A.newKeyShort}
                          </Button>
                          <Button
                            kind="quiet"
                            blocked={blocked()}
                            aria-label={A.deactivate(v.name)}
                            onClick={() => setAsking(v)}
                          >
                            {A.deactivateShort}
                          </Button>
                        </>
                      ) : (
                        <Button
                          pending={busy === v.id}
                          pendingLabel={T.states.pending}
                          blocked={blocked()}
                          aria-label={A.reactivate(v.name)}
                          onClick={async () => {
                            setBusy(v.id)
                            setFailed(null)
                            try {
                              await api.call('restoreAccount', { path: { id: v.id } })
                              await r.reload()
                              setSaid(A.reactivated(v.name))
                            } catch (e) {
                              setFailed({ id: v.id, error: e as ApiError })
                            } finally {
                              setBusy(null)
                            }
                          }}
                        >
                          {A.reactivateShort}
                        </Button>
                      )}
                    </div>
                    {shown?.of === v.id ? <OnceKey k={shown} onDone={hide} /> : null}
                    <Keys id={v.id} active={active} onSaid={setSaid} />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
      <DeactivateDialog
        a={asking}
        onClose={() => setAsking(null)}
        onDone={async () => {
          const v = asking
          setAsking(null)
          if (!v) return
          if (shown?.of === v.id) setShown(null)
          await r.reload()
          await keysResource(v.id).reload()
          setSaid(A.deactivated_(v.name))
        }}
      />
    </div>
  )
}

export function AdminServices() {
  return <AdminFrame>{() => <Services />}</AdminFrame>
}
