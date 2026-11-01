// People (spec B4 «Invitar», «Recuperar la contraseña»; B6 «Admin › people · invitations»; moved to PR18).
// Who: the administration, and a curator when the installation lets curators invite. Job: bring the
// people who work with you in — emails, brains and a role — and help one who cannot sign in. Done when:
// the invitation went by email, or its link is copied. Risk: a single-use link that grants access; it
// is shown only once, lives only in this screen's memory, and is gone when the person says it is copied.
// Who may do what is the server's (B4): this screen only offers it to whoever may.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { useFresh } from '../api/fresh.ts'
import { api } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import { emailsOf } from '../lib/people.ts'
import { branding, type Me, me, online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'
import { TextArea } from '../ui/TextArea.tsx'
import { brainsResource } from './Home.tsx'

type Invited = {
  id: string
  email: string
  link: string
  expiresAt: string
  mailed: boolean
  mailError: string | null
}
type Invitation = {
  id: string
  email: string
  status: 'pending' | 'expired' | 'used' | 'revoked'
  brains: Array<{ slug: string; role: string }>
  isAdmin: boolean
  invitedBy: string
  expiresAt: string
}
type AdminBrain = { slug: string; name: string; status: string }
// A link to give by hand, shown once, next to what made it: under the form, or in the row of its
// invitation or person. `key` is unique per link (a new link of the same invitation is another link).
export type Shown = {
  key: string
  title: string
  // Who it is for, for the status that announces it.
  who: string
  link: string
  note: string
  problem?: string
  place: 'form' | 'invitation' | 'account'
  // The invitation or account it belongs to.
  of: string
}
export type Links = {
  shown: Shown[]
  // Adds links (and drops every earlier link of the same invitation or person: it no longer works).
  add(more: Shown[]): void
  // Drops the links of an invitation or person (withdrawn), or one link (copied).
  drop(o: { of?: string; key?: string }): void
}

let made = 0
export const nextKey = (kind: string) => `${kind}:${++made}`

const ROLES = ['reader', 'contributor', 'curator'] as const

const invitationsResource = () =>
  resource<{ invitations: Invitation[] }>('people:invitations', () =>
    api.call<{ invitations: Invitation[] }>('invitations'),
  )
export const allBrainsResource = () =>
  resource<{ brains: AdminBrain[] }>('admin:brains', () => api.call<{ brains: AdminBrain[] }>('allBrains'))

// The brains this person may invite to: every brain for the administration; the ones they curate for a
// curator (B4: a curator invites only to brains they curate).
function useInvitable(who: Me): {
  brains: Array<{ slug: string; name: string }> | undefined
  error?: ApiError
} {
  const admin = who.account.isAdmin
  const r = admin ? allBrainsResource() : brainsResource()
  const d = r.data.value as
    | { brains: Array<{ slug: string; name: string; role?: string; status: string }> }
    | undefined
  return {
    brains: d?.brains.filter((b) => b.status !== 'archived' && (admin || b.role === 'curator')),
    ...(r.error.value ? { error: r.error.value } : {}),
  }
}

// One link to give by hand. The newest one takes the keyboard to its «Copy link» and comes into view,
// wherever on the page it was made.
function LinkCard({ x, focus, onDone }: { x: Shown; focus: boolean; onDone: (key: string) => void }) {
  const copyId = `copy-${x.key.replace(/\W/g, '-')}`
  useEffect(() => {
    if (!focus) return
    const b = document.getElementById(copyId)
    b?.focus({ preventScroll: true })
    b?.scrollIntoView({ block: 'center' })
  }, [focus])
  return (
    <section class="link-card" aria-label={x.title}>
      <p class="list-title">{x.title}</p>
      {x.problem ? <p class="problem">{x.problem}</p> : null}
      <pre class="command">
        <code>{x.link}</code>
      </pre>
      <p class="meta">
        {T.people.shownOnce} {x.note}
      </p>
      <div class="actions">
        <CopyButton text={x.link} label={T.people.copyLink} id={copyId} />
        <Button kind="quiet" onClick={() => onDone(x.key)}>
          {T.people.copied}
        </Button>
      </div>
    </section>
  )
}

export function LinksOf({ links, of, newest }: { links: Links; of: string; newest: string | null }) {
  const mine = links.shown.filter((x) => x.place !== 'form' && x.of === of)
  return (
    <>
      {mine.map((x) => (
        <LinkCard key={x.key} x={x} focus={x.key === newest} onDone={(k) => links.drop({ key: k })} />
      ))}
    </>
  )
}

function LinksToSend({ links, newest }: { links: Links; newest: string | null }) {
  const mine = links.shown.filter((x) => x.place === 'form')
  if (!mine.length) return null
  return (
    <section class="links-shown" aria-labelledby="links-title">
      <h2 id="links-title">{T.people.linksTitle}</h2>
      <p class="muted">{T.people.linksLead}</p>
      <ul>
        {mine.map((x) => (
          <li key={x.key}>
            <LinkCard x={x} focus={x.key === newest} onDone={(k) => links.drop({ key: k })} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function InviteForm({ who, links }: { who: Me; links: Links }) {
  const admin = who.account.isAdmin
  const mail = branding().data.value?.canSendMail !== false
  const { brains, error: brainsError } = useInvitable(who)
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [isAdmin, setIsAdmin] = useState(false)
  const [canCreate, setCanCreate] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [brainProblem, setBrainProblem] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const count = emailsOf(text).emails.length

  const focusEmails = () => document.querySelector<HTMLTextAreaElement>('textarea[name="emails"]')?.focus()

  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setError(null)
    setSent(null)
    const { emails, bad } = emailsOf(text)
    const n = T.people.need
    const p = bad[0] ? n.bad(bad[0]) : emails.length === 0 ? n.none : emails.length > 50 ? n.many : null
    setProblem(p)
    if (p) return focusEmails()
    const grants = Object.entries(chosen).map(([slug, role]) => ({ slug, role }))
    if (!admin && grants.length === 0) {
      setBrainProblem(T.people.brainsCurator)
      return
    }
    setBrainProblem(null)
    setPending(true)
    try {
      const out = await api.call<{ invitations: Invited[] }>('invite', {
        body: {
          emails,
          brains: grants,
          ...(admin ? { isAdmin, canCreateBrains: canCreate } : {}),
        },
      })
      const mailed = out.invitations.filter((i) => i.mailed).map((i) => i.email)
      if (mailed.length) setSent(T.people.sent(mailed))
      links.add(
        out.invitations
          .filter((i) => !i.mailed)
          .map((i) => ({
            key: nextKey('inv'),
            place: 'form' as const,
            of: i.id,
            who: i.email,
            title: T.people.inviteFor(i.email),
            link: i.link,
            note: T.people.until(T.dateTime(i.expiresAt)),
            ...(i.mailError && mail ? { problem: T.people.mailFailed(i.mailError) } : {}),
          })),
      )
      setText('')
      invalidate('people:')
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }

  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <form class="form invite-form" aria-label={T.people.formTitle} onSubmit={submit} noValidate>
      <h2>{T.people.formTitle}</h2>
      {!mail ? (
        <p class="alert warn">
          <span class="kind">{T.kind.warning}</span>
          <span>{T.people.noMail}</span>
        </p>
      ) : null}
      <FormAlert error={error} />
      {sent ? (
        <p class="alert ok" role="status">
          <span class="kind">{T.kind.done}</span>
          <span>{sent}</span>
        </p>
      ) : null}
      <TextArea
        label={T.people.emails}
        hint={T.people.emailsHint}
        name="emails"
        rows={2}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        value={text}
        problem={problem}
        onValue={(v) => {
          setText(v)
          if (problem) setProblem(null)
        }}
      />
      <fieldset class="brains-pick" aria-describedby={brainProblem ? 'brains-problem' : undefined}>
        <legend>{T.people.brains}</legend>
        <span class="hint">{admin ? T.people.brainsHint : T.people.brainsCurator}</span>
        {brainsError ? <ErrorState error={brainsError} /> : null}
        {!brains && !brainsError ? <Skeleton rows={1} /> : null}
        {brains && brains.length === 0 ? <p class="muted">{T.people.noBrains}</p> : null}
        {brains?.map((b) => {
          const on = b.slug in chosen
          const id = `pick-${b.slug}`
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
                  setBrainProblem(null)
                }}
              />
              <label for={id}>{b.name}</label>
              <select
                aria-label={T.people.roleIn(b.name)}
                value={chosen[b.slug] ?? 'contributor'}
                disabled={!on}
                onChange={(e) => setChosen({ ...chosen, [b.slug]: e.currentTarget.value })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {T.people.roles[r]}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
        {brainProblem ? (
          <span id="brains-problem" class="problem">
            {brainProblem}
          </span>
        ) : null}
      </fieldset>
      {admin ? (
        <fieldset>
          <legend>{T.people.rights}</legend>
          <div class="pick">
            <input
              type="checkbox"
              id="pick-admin"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.currentTarget.checked)}
            />
            <label for="pick-admin">{T.people.isAdmin}</label>
          </div>
          <div class="pick">
            <input
              type="checkbox"
              id="pick-create"
              checked={canCreate}
              onChange={(e) => setCanCreate(e.currentTarget.checked)}
            />
            <label for="pick-create">{T.people.canCreate}</label>
          </div>
        </fieldset>
      ) : null}
      <div class="actions">
        <Button
          type="submit"
          kind="primary"
          pending={pending}
          pendingLabel={T.people.sending}
          blocked={blocked}
        >
          {mail ? T.people.send : T.people.create(count)}
        </Button>
      </div>
    </form>
  )
}

const SHOW = ['all', 'pending', 'expired', 'used', 'revoked'] as const

function Invitations({
  links,
  newest,
  names,
  filter = false,
}: {
  links: Links
  newest: string | null
  names: Map<string, string>
  // The administration's list: shown by status (pending, expired, accepted, withdrawn).
  filter?: boolean
}) {
  const r = invitationsResource()
  const [show, setShow] = useState<(typeof SHOW)[number]>('all')
  // Invitations may have been accepted since this list was loaded.
  useFresh(r)
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<{ id: string; text: string; error?: boolean } | null>(null)
  const [asking, setAsking] = useState<Invitation | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const all = r.data.value?.invitations
  const list = all && show !== 'all' ? all.filter((i) => i.status === show) : all
  const p = T.people

  const resend = async (inv: Invitation) => {
    setBusy(inv.id)
    setSaid(null)
    try {
      const out = await api.call<{ invitation: Invited }>('inviteResend', { path: { id: inv.id } })
      const i = out.invitation
      // The link before this one no longer works: it goes, wherever it was shown.
      links.drop({ of: inv.id })
      if (i.mailed) setSaid({ id: inv.id, text: p.sentOne(i.email) })
      // The link to copy, also when it went by email (to send it another way): shown once, here.
      links.add([
        {
          key: nextKey('inv'),
          place: 'invitation',
          of: inv.id,
          who: i.email,
          title: p.inviteFor(i.email),
          link: i.link,
          note: `${p.until(T.dateTime(i.expiresAt))}${i.mailed ? ` ${p.alsoMailed}` : ''}`,
          ...(i.mailError && branding().data.value?.canSendMail
            ? { problem: p.mailFailed(i.mailError) }
            : {}),
        },
      ])
      await r.reload()
    } catch (e) {
      const a = e as ApiError
      setSaid({ id: inv.id, text: `${a.message} ${a.howToProceed}`, error: true })
    } finally {
      setBusy(null)
    }
  }
  const withdraw = async (inv: Invitation) => {
    setAsking(null)
    setBusy(inv.id)
    setSaid(null)
    try {
      await api.call('inviteWithdraw', { path: { id: inv.id } })
      links.drop({ of: inv.id })
      await r.reload()
      setSaid({ id: inv.id, text: p.withdrawn })
      // The row loses its buttons: the keyboard goes to the list, not to the top of the page.
      heading.current?.focus()
    } catch (e) {
      const a = e as ApiError
      setSaid({ id: inv.id, text: `${a.message} ${a.howToProceed}`, error: true })
    } finally {
      setBusy(null)
    }
  }

  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <section aria-labelledby="invitations-title">
      <h2 id="invitations-title" class="section-title" tabIndex={-1} ref={heading}>
        {p.listTitle}
      </h2>
      {filter && all?.length ? (
        <div class="field inline-field">
          <label for="invitations-show">{T.admin.show}</label>
          <select
            id="invitations-show"
            value={show}
            onChange={(e) => setShow(e.currentTarget.value as (typeof SHOW)[number])}
          >
            {SHOW.map((x) => (
              <option key={x} value={x}>
                {x === 'all' ? T.admin.showAll : p.status[x]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {!list ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : list.length === 0 ? (
        show === 'all' ? (
          <p class="quiet-empty" data-state="empty">
            {p.noInvitations}
          </p>
        ) : (
          <div class="quiet-empty" data-state="filtered-empty">
            <p>{T.states.filteredEmpty}</p>
            <Button
              onClick={() => {
                setShow('all')
                document.getElementById('invitations-show')?.focus()
              }}
            >
              {T.admin.showEvery}
            </Button>
          </div>
        )
      ) : (
        <ul class="list">
          {list.map((inv) => {
            const open = inv.status === 'pending' || inv.status === 'expired'
            return (
              <li key={inv.id} class="with-actions">
                <div>
                  <p class="list-title">
                    <span class="mono">{inv.email}</span>{' '}
                    <span class={`tag ${inv.status === 'pending' ? 'live' : ''}`}>
                      {p.status[inv.status]}
                    </span>
                    {inv.isAdmin ? <span class="tag">{p.admin}</span> : null}
                  </p>
                  <p class="meta">
                    {inv.brains.length
                      ? inv.brains.map((b) => p.asRole(names.get(b.slug) ?? b.slug, b.role)).join(', ')
                      : p.noBrain}
                  </p>
                  <p class="meta">
                    {inv.status === 'pending'
                      ? p.invitedUntil(inv.invitedBy, T.date(inv.expiresAt))
                      : inv.status === 'expired'
                        ? p.invitedExpired(inv.invitedBy, T.date(inv.expiresAt))
                        : p.invitedBy(inv.invitedBy)}
                  </p>
                  {said?.id === inv.id ? (
                    <p class={said.error ? 'problem' : 'meta'} role={said.error ? 'alert' : 'status'}>
                      {said.text}
                    </p>
                  ) : null}
                </div>
                {open ? (
                  <div class="actions">
                    <Button
                      pending={busy === inv.id}
                      blocked={blocked}
                      aria-label={p.resendFor(inv.email)}
                      onClick={() => void resend(inv)}
                    >
                      {p.resend}
                    </Button>
                    <Button
                      kind="quiet"
                      blocked={blocked}
                      aria-label={p.withdrawFor(inv.email)}
                      onClick={() => setAsking(inv)}
                    >
                      {p.withdraw}
                    </Button>
                  </div>
                ) : null}
                <LinksOf links={links} of={inv.id} newest={newest} />
              </li>
            )
          })}
        </ul>
      )}
      <Dialog open={asking !== null} title={p.withdrawTitle} onClose={() => setAsking(null)}>
        {asking ? (
          <>
            <p>{p.withdrawLead(asking.email)}</p>
            <div class="actions">
              <Button kind="primary" onClick={() => void withdraw(asking)}>
                {p.withdrawConfirm}
              </Button>
              <Button kind="quiet" onClick={() => setAsking(null)}>
                {p.cancel}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
    </section>
  )
}

// Kept for the admin screen's reset links (screens/admin/Admin.tsx builds the people list).
export function resetLinkOf(
  a: { name: string; email: string | null },
  out: { link: string },
  id: string,
): Shown {
  return {
    key: nextKey('reset'),
    place: 'account',
    of: id,
    who: a.name,
    title: T.people.resetFor(a.name, a.email),
    link: out.link,
    note: T.people.resetUntil,
  }
}

// The links shown once on a screen, the newest one taking the keyboard, and what the status says.
export function useLinks(): { links: Links; newest: string | null; announce: string } {
  const [shown, setShown] = useState<Shown[]>([])
  const [newest, setNewest] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  // Put in the back/forward cache, the links shown are forgotten (they work once, like a token).
  useEffect(() => {
    const away = () => {
      setShown([])
      setAnnounce('')
    }
    window.addEventListener('pagehide', away)
    return () => window.removeEventListener('pagehide', away)
  }, [])
  const links: Links = {
    shown,
    add: (more) => {
      if (!more.length) return
      const ofs = new Set(more.map((x) => x.of))
      setShown((now) => [...more, ...now.filter((x) => !ofs.has(x.of))])
      setNewest(more[0]?.key ?? null)
      setAnnounce(T.people.linkReady(more.map((x) => x.who)))
    },
    drop: ({ of, key }) => {
      setShown((now) => now.filter((x) => x.of !== of && x.key !== key))
      // The link it announced is gone: so is the announcement.
      setAnnounce('')
    },
  }
  return { links, newest, announce }
}

// Inviting: the form, the links to send and the invitations (People, and the administration's
// Invitations, which also shows them by status).
export function InvitePeople({ who, filter = false }: { who: Me; filter?: boolean }) {
  const { links, newest, announce } = useLinks()
  const admin = who.account.isAdmin
  const names = new Map<string, string>()
  const b = admin ? allBrainsResource().data.value?.brains : brainsResource().data.value?.brains
  for (const x of b ?? []) names.set(x.slug, x.name)
  return (
    <>
      <p class="sr-only" role="status">
        {announce}
      </p>
      <div class="people">
        <div class="people-main">
          <InviteForm who={who} links={links} />
          <LinksToSend links={links} newest={newest} />
        </div>
        <div class="people-side">
          <Invitations links={links} newest={newest} names={names} filter={filter} />
          {admin && !filter ? (
            <section aria-labelledby="accounts-title">
              <h2 id="accounts-title" class="section-title">
                {T.people.peopleTitle}
              </h2>
              <p class="muted small">
                {T.people.managed} <a href="/admin/people">{T.people.managedLink}</a>
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </>
  )
}

export function People() {
  const who = me().data.value
  if (!who) return <Skeleton rows={3} />
  if (!who.account.canInvite) {
    return (
      <>
        <div class="title-row">
          <h1 class="title">{T.people.title}</h1>
        </div>
        <div class="state forbidden" role="alert" data-state="forbidden">
          <span class="kind">{T.kind.noAccess}</span>
          <h2>{T.states.forbiddenTitle}</h2>
          <p>{T.people.cannot}</p>
          <p class="how">{T.people.cannotHow}</p>
        </div>
      </>
    )
  }
  return (
    <>
      <div class="title-row">
        <h1 class="title">{T.people.title}</h1>
      </div>
      <p class="lead">{T.people.lead}</p>
      <InvitePeople who={who} />
    </>
  )
}
