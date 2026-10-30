// People (spec B4 «Invitar», «Recuperar la contraseña»; B6 «Admin › people · invitations»; moved to PR18).
// Who: the administration, and a curator when the installation lets curators invite. Job: bring the
// people who work with you in — emails, brains and a role — and help one who cannot sign in. Done when:
// the invitation went by email, or its link is copied. Risk: a single-use link that grants access; it
// is shown only once, lives only in this screen's memory, and is gone when the person says it is copied.
// Who may do what is the server's (B4): this screen only offers it to whoever may.
import { useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import { ago } from '../lib/brains.ts'
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
type Account = {
  id: string
  kind: string
  name: string
  email: string | null
  isAdmin: boolean
  status: string
  brains: number
  lastSeenAt: string | null
}
type AdminBrain = { slug: string; name: string; status: string }
// A link to give by hand, shown once.
type Shown = { key: string; title: string; link: string; note: string; problem?: string }

const ROLES = ['reader', 'contributor', 'curator'] as const

const invitationsResource = () =>
  resource<{ invitations: Invitation[] }>('people:invitations', () =>
    api.call<{ invitations: Invitation[] }>('invitations'),
  )
const accountsResource = () =>
  resource<{ accounts: Account[] }>('admin:accounts', () => api.call<{ accounts: Account[] }>('accounts'))
const allBrainsResource = () =>
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

function LinksToSend({ shown, onDone }: { shown: Shown[]; onDone: (key: string) => void }) {
  if (!shown.length) return null
  return (
    <section class="links-shown" aria-labelledby="links-title">
      <h2 id="links-title">{T.people.linksTitle}</h2>
      <p class="muted">{T.people.linksLead}</p>
      <ul>
        {shown.map((x) => (
          <li key={x.key}>
            <p class="list-title">{x.title}</p>
            {x.problem ? <p class="problem">{x.problem}</p> : null}
            <pre class="command">
              <code>{x.link}</code>
            </pre>
            <p class="meta">
              {T.people.shownOnce} {x.note}
            </p>
            <div class="actions">
              <CopyButton text={x.link} label={T.people.copyLink} />
              <Button kind="quiet" onClick={() => onDone(x.key)}>
                {T.people.copied}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function InviteForm({ who, onLinks }: { who: Me; onLinks: (s: Shown[]) => void }) {
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
      onLinks(
        out.invitations
          .filter((i) => !i.mailed)
          .map((i) => ({
            key: `inv:${i.id}`,
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

function Invitations({ onLinks, names }: { onLinks: (s: Shown[]) => void; names: Map<string, string> }) {
  const r = invitationsResource()
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<{ id: string; text: string; error?: boolean } | null>(null)
  const [asking, setAsking] = useState<Invitation | null>(null)
  const list = r.data.value?.invitations
  const p = T.people

  const resend = async (inv: Invitation) => {
    setBusy(inv.id)
    setSaid(null)
    try {
      const out = await api.call<{ invitation: Invited }>('inviteResend', { path: { id: inv.id } })
      const i = out.invitation
      if (i.mailed) setSaid({ id: inv.id, text: p.sentOne(i.email) })
      else
        onLinks([
          {
            key: `inv:${i.id}:${Date.now()}`,
            title: p.inviteFor(i.email),
            link: i.link,
            note: p.until(T.dateTime(i.expiresAt)),
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
      await r.reload()
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
      <h2 id="invitations-title" class="section-title">
        {p.listTitle}
      </h2>
      {!list ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : list.length === 0 ? (
        <p class="quiet-empty">{p.noInvitations}</p>
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
                  <p class="meta">{p.invitedBy(inv.invitedBy, T.date(inv.expiresAt))}</p>
                  {said?.id === inv.id ? (
                    <p class={said.error ? 'problem' : 'meta'} role={said.error ? 'alert' : 'status'}>
                      {said.text}
                    </p>
                  ) : null}
                </div>
                {open ? (
                  <div class="actions">
                    <Button pending={busy === inv.id} blocked={blocked} onClick={() => void resend(inv)}>
                      {p.resend}
                    </Button>
                    <Button kind="quiet" blocked={blocked} onClick={() => setAsking(inv)}>
                      {p.withdraw}
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <Dialog
        open={asking !== null}
        title={p.withdrawTitle}
        onClose={() => setAsking(null)}
        closeLabel={p.cancel}
      >
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

function Accounts({ who, onLinks }: { who: Me; onLinks: (s: Shown[]) => void }) {
  const r = accountsResource()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null)
  const p = T.people
  const people = r.data.value?.accounts.filter((a) => a.kind === 'person')
  const make = async (a: Account) => {
    setBusy(a.id)
    setFailed(null)
    try {
      const out = await api.call<{ link: string; expiresAt: string }>('resetLink', { path: { id: a.id } })
      onLinks([
        {
          key: `reset:${a.id}:${Date.now()}`,
          title: p.resetFor(a.name, a.email),
          link: out.link,
          note: p.resetUntil,
        },
      ])
    } catch (e) {
      const x = e as ApiError
      setFailed({ id: a.id, text: `${x.message} ${x.howToProceed}` })
    } finally {
      setBusy(null)
    }
  }
  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <section aria-labelledby="accounts-title">
      <h2 id="accounts-title" class="section-title">
        {p.peopleTitle}
      </h2>
      <p class="muted small">{p.resetHow}</p>
      {!people ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : (
        <ul class="list">
          {people.map((a) => (
            <li key={a.id} class="with-actions">
              <div>
                <p class="list-title">
                  {a.name} {a.id === who.account.id ? <span class="tag">{p.you}</span> : null}
                  {a.isAdmin ? <span class="tag">{p.admin}</span> : null}
                  {a.status !== 'active' ? <span class="tag">{p.removed}</span> : null}
                </p>
                <p class="meta">
                  {a.email ? <span class="mono">{a.email}</span> : null}
                  {a.email ? ' · ' : ''}
                  {p.inBrains(a.brains)} · {p.seen(ago(a.lastSeenAt))}
                </p>
                {failed?.id === a.id ? (
                  <p class="problem" role="alert">
                    {failed.text}
                  </p>
                ) : null}
              </div>
              {a.status === 'active' && a.id !== who.account.id ? (
                <div class="actions">
                  <Button pending={busy === a.id} blocked={blocked} onClick={() => void make(a)}>
                    {p.reset}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function People() {
  const who = me().data.value
  const [shown, setShown] = useState<Shown[]>([])
  const admin = who?.account.isAdmin === true
  const names = new Map<string, string>()
  const b = admin ? allBrainsResource().data.value?.brains : brainsResource().data.value?.brains
  for (const x of b ?? []) names.set(x.slug, x.name)
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
  const add = (more: Shown[]) => setShown((now) => [...more, ...now])
  return (
    <>
      <div class="title-row">
        <h1 class="title">{T.people.title}</h1>
      </div>
      <p class="lead">{T.people.lead}</p>
      <div class="people">
        <div class="people-main">
          <InviteForm who={who} onLinks={add} />
          <LinksToSend shown={shown} onDone={(k) => setShown((now) => now.filter((x) => x.key !== k))} />
        </div>
        <div class="people-side">
          <Invitations onLinks={add} names={names} />
          {admin ? <Accounts who={who} onLinks={add} /> : null}
        </div>
      </div>
    </>
  )
}
