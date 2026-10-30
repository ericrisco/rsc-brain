// Accept an invitation (spec B4 «Invitaciones», B6 «Accept invitation»). Who: a person invited by email,
// first time here. Job: create their account and get in. Done when: signed in at home. Risk: a link that
// expired or was used; the token leaking (it is taken out of the address at once and kept in memory).

import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { draft } from '../api/draft.ts'
import { api } from '../api/index.ts'
import { resetResources } from '../api/resource.ts'
import { useLinkToken } from '../lib/linkToken.ts'
import { online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { LinkProblem } from '../shell/LinkProblem.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { focusFieldOf } from '../ui/fieldOf.ts'
import { PasswordField } from '../ui/PasswordField.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'

type Invitation = {
  email: string
  installation: string
  brains: Array<{ slug: string; name: string; role: string }>
  isAdmin: boolean
  expiresAt: string
}

export function Invite() {
  const link = useLinkToken('invite')
  return <InvitationPage key={link.visit} token={link.token} spent={link.spend} />
}

function InvitationPage({ token, spent }: { token: string | null; spent: () => void }) {
  const { route } = useLocation()
  const [inv, setInv] = useState<Invitation | null>(null)
  const [lookError, setLookError] = useState<ApiError | null>(null)
  const nameDraft = draft('invite.name', sessionStorage)
  const [name, setName] = useState(nameDraft.get())
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [onField, setOnField] = useState(false)
  const [pending, setPending] = useState(false)

  const look = async () => {
    if (!token) return
    setLookError(null)
    try {
      const r = await api.call<{ invitation: Invitation }>('inviteLook', { body: { token } })
      setInv(r.invitation)
    } catch (e) {
      setLookError(e as ApiError)
    }
  }
  useEffect(() => {
    void look()
  }, [])

  const forward = (
    <>
      <span class="meta">{T.invite.haveAccount}</span>
      <a class="button" href="/sign-in">
        {T.invite.signIn}
      </a>
    </>
  )
  if (!token) {
    return (
      <Door>
        <LinkProblem title={T.invite.invalidTitle} message={T.invite.noToken} how={T.invite.reload}>
          {forward}
        </LinkProblem>
      </Door>
    )
  }
  if (lookError) {
    return (
      <Door>
        {lookError.code === 'invitation_invalid' ? (
          <LinkProblem title={T.invite.invalidTitle} message={lookError.message} how={lookError.howToProceed}>
            {forward}
          </LinkProblem>
        ) : (
          <ErrorState error={lookError} onRetry={() => void look()} />
        )}
      </Door>
    )
  }
  if (!inv) {
    return (
      <Door>
        <Skeleton rows={3} />
      </Door>
    )
  }

  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      await api.call('inviteAccept', { body: { token, name, password } })
      nameDraft.clear()
      spent()
      resetResources()
      route('/', true)
    } catch (err) {
      setError(err as ApiError)
      setOnField(focusFieldOf((err as ApiError).message))
    } finally {
      setPending(false)
    }
  }
  return (
    <Door>
      <div>
        <h1 class="title">{T.invite.title}</h1>
        <p class="lead">{T.invite.lead(inv.installation || T.brandFallback)}</p>
      </div>
      <div class="invited">
        <p>
          <span class="meta">{T.invite.for} </span>
          <strong>{inv.email}</strong>
        </p>
        {inv.brains.length ? (
          <div>
            <p class="meta">{T.invite.brains}</p>
            <ul>
              {inv.brains.map((b) => (
                <li key={b.slug}>
                  <span class="brainname">{b.name}</span>
                  <span class="tag">{T.invite.role[b.role] ?? b.role}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p class="meta">{T.invite.noBrains}</p>
        )}
        {inv.isAdmin ? <p>{T.invite.admin}</p> : null}
        <p class="meta">{T.invite.expires(T.dateTime(inv.expiresAt))}</p>
      </div>
      <form class="form" onSubmit={submit} noValidate>
        <FormAlert error={error} focus={!onField} />
        <Field
          label={T.invite.name}
          hint={T.invite.nameHint}
          name="name"
          autocomplete="name"
          required
          maxLength={80}
          value={name}
          onValue={(v) => {
            setName(v)
            nameDraft.set(v)
          }}
          autoFocus
        />
        <PasswordField
          label={T.invite.password}
          hint={T.setup.passwordHint}
          name="password"
          autocomplete="new-password"
          required
          minLength={12}
          maxLength={200}
          value={password}
          onValue={setPassword}
        />
        <input type="email" name="email" autocomplete="username" value={inv.email} hidden readOnly />
        <div class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={T.invite.submitting}
            blocked={writeBlocked({ online: online.value, pending: false })}
          >
            {T.invite.submit}
          </Button>
        </div>
      </form>
    </Door>
  )
}
