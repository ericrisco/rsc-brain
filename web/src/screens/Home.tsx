// Home (spec B6 «Home: mis cerebros», T014). Who: anyone signed in. Job: see my brains at a glance and
// open one; for whoever may, create one; for anyone, connect an agent. Done when: the brain is open, or
// the next step is clear. A card per brain says what it is for, my role, its size, what waits for
// review and when it last moved (G7). Empty, it is never a dead end: whoever may create brains gets the
// first three steps with real actions; anyone else learns who adds people to brains. An administrator
// still alone in the installation is offered to invite people until someone joins.
import { Fragment } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useFresh } from '../api/fresh.ts'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { ago } from '../lib/brains.ts'
import { firstPersonAlone } from '../lib/people.ts'
import { branding, justDeleted, justJoined, justSetUp, type Me, me, online } from '../session.ts'
import { connectHref, createOpen } from '../shell/dialogs.ts'
import { useSignOut } from '../shell/signOut.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
import { viewState } from '../ui/state.ts'
import { ErrorState, Skeleton } from '../ui/states.tsx'

export type Stats = {
  pages: number
  entries: number
  uncompiled: number
  conflicts: number
  pendingProposals: number
  lastActivityAt: string | null
}
export type BrainRow = {
  slug: string
  name: string
  purpose: string
  status: string
  role: string
  stats: Stats
  notifyProposals: boolean
}

export const brainsResource = () =>
  resource<{ brains: BrainRow[] }>('brains', () => api.call<{ brains: BrainRow[] }>('brains'))

type Account = { id: string; kind: string; status: string }
// Who else is in the installation (administration only): Home offers to invite until someone joins.
export const accountsResource = () =>
  resource<{ accounts: Account[] }>('admin:accounts', () => api.call<{ accounts: Account[] }>('accounts'))

type Kit = {
  agents: Array<{ id: string; signIn: { note: string; blocks: Array<{ text: string }> } | null }>
}
const kitResource = () =>
  resource<Kit>('connect:claude-code', () => api.call<Kit>('connect', { query: { agent: 'claude-code' } }))

function ConnectCommand() {
  const r = kitResource()
  const signIn = r.data.value?.agents.find((a) => a.id === 'claude-code')?.signIn
  const command = signIn?.blocks[0]?.text
  if (command && signIn) {
    return (
      <>
        <pre class="command">
          <code>
            {command.split(' ').map((w, i) => (
              <Fragment key={i}>
                {i ? ' ' : ''}
                <span class="word">{w}</span>
              </Fragment>
            ))}
          </code>
        </pre>
        <div class="actions">
          <CopyButton text={command} label={T.home.copyCommand} />
          <a class="button quiet" href={connectHref(null)}>
            {T.home.otherAgents}
          </a>
        </div>
        <p class="how">{signIn.note}</p>
      </>
    )
  }
  if (r.error.value) {
    return (
      <p class="how" role="alert">
        {r.error.value.message} {r.error.value.howToProceed}
      </p>
    )
  }
  return <Skeleton rows={1} />
}

function GetStarted({ who }: { who: Me }) {
  return (
    <section class="state next" data-state="empty" aria-labelledby="start-title">
      <h2 id="start-title">{T.home.startTitle}</h2>
      <p>{T.home.startLead}</p>
      <ol class="steps">
        <li>
          <p>{T.home.startCreate}</p>
          <Button kind="primary" onClick={() => (createOpen.value = true)}>
            {T.create.open}
          </Button>
        </li>
        {who.account.canInvite ? (
          <li>
            <p>{T.home.startInvite(branding().data.value?.canSendMail !== false)}</p>
            <a class="button" href="/people">
              {T.home.invite}
            </a>
          </li>
        ) : null}
        <li>
          <p>{T.home.startConnect}</p>
          <ConnectCommand />
        </li>
      </ol>
      <a href={T.home.readmeUrl} target="_blank" rel="noopener noreferrer">
        {T.home.readme}
      </a>
    </section>
  )
}

function NotInAny({ who }: { who: Me }) {
  const { signOut, leaving, failed } = useSignOut()
  const email = who.account.email
  return (
    <section class="state" data-state="empty" aria-labelledby="empty-title">
      <h2 id="empty-title">{T.home.emptyTitle}</h2>
      <p>{T.home.emptyLead}</p>
      {email ? (
        <>
          <p class="how">{T.home.emptyAsk}</p>
          <p>
            <strong>{email}</strong>
          </p>
          <CopyButton text={email} label={T.home.copyEmail} />
        </>
      ) : null}
      <p class="how">{T.home.wrongAccount}</p>
      <Button onClick={() => void signOut()} pending={leaving} pendingLabel={T.shell.signingOut}>
        {T.shell.signOut}
      </Button>
      {failed ? <p role="alert">{T.shell.signOutFailed}</p> : null}
    </section>
  )
}

// Shown to an administrator while nobody else is in the installation.
function InvitePanel() {
  const r = accountsResource()
  // Someone may have joined since this list was loaded.
  useFresh(r)
  const accounts = r.data.value?.accounts
  if (!accounts || !firstPersonAlone(accounts)) return null
  return (
    <section class="callout" aria-label={T.home.inviteTitle}>
      <div>
        <h2>{T.home.inviteTitle}</h2>
        <p class="muted">{T.home.inviteLead(branding().data.value?.canSendMail !== false)}</p>
      </div>
      <a class="button" href="/people">
        {T.home.invite}
      </a>
    </section>
  )
}

function Card({ b }: { b: BrainRow }) {
  const waiting = b.stats.pendingProposals
  const when = ago(b.stats.lastActivityAt)
  return (
    <li class={b.status === 'archived' ? 'archived' : undefined}>
      <div class="card-head">
        <a class="name" href={`/b/${encodeURIComponent(b.slug)}`}>
          {b.name}
        </a>
        <span class="tag">{b.role}</span>
        {b.status === 'archived' ? <span class="tag">{T.home.archived}</span> : null}
      </div>
      <p class="purpose">{b.purpose || <span class="muted">{T.brain.noPurpose}</span>}</p>
      <p class="meta">{T.home.size(b.stats.pages, b.stats.entries)}</p>
      <p class={waiting && b.role === 'curator' ? 'review' : 'meta'}>
        {!waiting
          ? T.home.nothingToReview
          : b.role === 'curator'
            ? T.home.toReview(waiting)
            : T.home.waiting(waiting)}
      </p>
      <p class="meta">{when ? T.home.lastActivity(when) : T.home.noActivity}</p>
    </li>
  )
}

export function Home() {
  const r = brainsResource()
  const who = me().data.value
  const data = r.data.value
  // "rsc-brain is set up." is said once, on the first home after the setup.
  const [setUp] = useState(() => justSetUp.value)
  // "Welcome — you joined …" is said once, on the first home after accepting an invitation.
  const [joined] = useState(() => justJoined.value)
  // "Growth was deleted." is said once, on the home the settings lead to after deleting it.
  const [deleted] = useState(() => justDeleted.value)
  useEffect(() => {
    justSetUp.value = false
    justJoined.value = null
    justDeleted.value = null
  }, [])
  const state = viewState({
    loading: r.loading.value,
    data,
    error: r.error.value,
    online: online.value,
    isEmpty: (d) => d.brains.length === 0,
  })
  const canCreate = who?.account.canCreateBrains === true
  return (
    <>
      <div class="title-row">
        <div class="title-group">
          <h1 class="title">{T.home.title}</h1>
          {data?.brains.length ? <span class="meta">{T.home.count(data.brains.length)}</span> : null}
        </div>
        <div class="actions">
          <a class="button secondary" href={connectHref(null)}>
            {T.connect.open}
          </a>
          {canCreate && state === 'ready' ? (
            <Button kind="primary" onClick={() => (createOpen.value = true)}>
              {T.create.open}
            </Button>
          ) : null}
        </div>
      </div>
      {setUp ? (
        <p class="alert ok" role="status">
          <span class="kind">{T.kind.done}</span>
          <span>{T.home.setUp}</span>
        </p>
      ) : null}
      {deleted ? (
        <p class="alert ok" role="status">
          <span class="kind">{T.kind.done}</span>
          <span>{T.settings.deleted(deleted)}</span>
        </p>
      ) : null}
      {joined ? (
        <p class="alert ok" role="status">
          <span class="kind">{T.kind.done}</span>
          <span>{T.home.welcome(joined)}</span>
        </p>
      ) : null}
      {state === 'loading' ? <Skeleton rows={3} /> : null}
      {state === 'error' || state === 'offline' || state === 'forbidden' ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : null
      ) : null}
      {state === 'empty' && who ? canCreate ? <GetStarted who={who} /> : <NotInAny who={who} /> : null}
      {state === 'ready' && data ? (
        <>
          {who?.account.isAdmin ? <InvitePanel /> : null}
          <section aria-label={T.home.title}>
            <ul class="cards">
              {data.brains.map((b) => (
                <Card key={b.slug} b={b} />
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </>
  )
}
