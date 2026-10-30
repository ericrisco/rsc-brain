// Home, the first version (spec B6 «Home: mis cerebros»; the cards with their numbers arrive with G7 in
// PR18): the brains of the person, their role, and what each is for. Empty, it is never a dead end: an
// administrator gets the next step (create a brain, invite people) with what works today; anyone else
// learns who adds people to brains, with their email to give and a way to sign out. The command to connect
// an agent comes from the server's connection kit (GET /v1/connect), built from the public address of
// the installation, never from the address the browser happens to be on.
import { Fragment } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { justJoined, justSetUp, type Me, me, online } from '../session.ts'
import { useSignOut } from '../shell/signOut.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
import { viewState } from '../ui/state.ts'
import { ErrorState, Skeleton } from '../ui/states.tsx'

export type BrainRow = { slug: string; name: string; purpose: string; status: string; role: string }

export const brainsResource = () =>
  resource<{ brains: BrainRow[] }>('brains', () => api.call<{ brains: BrainRow[] }>('brains'))

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
        <CopyButton text={command} label={T.home.copyCommand} />
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

function NextSteps() {
  return (
    <section class="state next" data-state="empty" aria-labelledby="next-title">
      <h2 id="next-title">{T.home.nextTitle}</h2>
      <p>{T.home.nextLead}</p>
      <ol class="steps">
        <li>
          <p>{T.home.nextConnect}</p>
          <ConnectCommand />
        </li>
        <li>
          <p>{T.home.nextCreate}</p>
        </li>
        <li>
          <p>{T.home.nextInvite}</p>
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

export function Home() {
  const r = brainsResource()
  const who = me().data.value
  const data = r.data.value
  // "Brain is set up." is said once, on the first home after the setup.
  const [setUp] = useState(() => justSetUp.value)
  // "Welcome — you joined …" is said once, on the first home after accepting an invitation.
  const [joined] = useState(() => justJoined.value)
  useEffect(() => {
    justSetUp.value = false
    justJoined.value = null
  }, [])
  const state = viewState({
    loading: r.loading.value,
    data,
    error: r.error.value,
    online: online.value,
    isEmpty: (d) => d.brains.length === 0,
  })
  return (
    <>
      <div class="title-row">
        <h1 class="title">{T.home.title}</h1>
        {data?.brains.length ? <span class="meta">{T.home.count(data.brains.length)}</span> : null}
      </div>
      {setUp ? (
        <p class="alert ok" role="status">
          <span class="kind">{T.kind.done}</span>
          <span>{T.home.setUp}</span>
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
      {state === 'empty' && who ? who.account.isAdmin ? <NextSteps /> : <NotInAny who={who} /> : null}
      {state === 'ready' && data ? (
        <section aria-label={T.home.title}>
          <div class="rows-head" aria-hidden="true">
            <span>Brain</span>
            <span>{T.brain.purpose}</span>
            <span>{T.home.role}</span>
          </div>
          <ul class="rows">
            {data.brains.map((b) => (
              <li key={b.slug}>
                <a class="name" href={`/b/${encodeURIComponent(b.slug)}`}>
                  {b.name}
                </a>
                <span class="purpose">{b.purpose || <span class="muted">{T.brain.noPurpose}</span>}</span>
                <span class="role">
                  {b.role}
                  {b.status === 'archived' ? ` · ${T.home.archived}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
