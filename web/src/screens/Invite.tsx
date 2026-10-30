// Accept an invitation (spec B4 «Invitaciones», B6 «Accept invitation»). Who: a person invited by email,
// first time here. Job: create their account and get in. Done when: signed in at home. Risk: a link that
// expired or was used; the token leaking (it is taken out of the address at once and kept in memory).

import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { draft } from '../api/draft.ts'
import { api } from '../api/index.ts'
import { resetResources } from '../api/resource.ts'
import { tokenFromHash } from '../lib/nav.ts'
import { online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { focusFieldOf } from '../ui/fieldOf.ts'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'

type Invitation = {
  email: string
  installation: string
  brains: Array<{ slug: string; name: string; role: string }>
  isAdmin: boolean
  expiresAt: string
}

// The token of this visit: read once from "#token=", never written back to the address.
let held: string | null = null
function takeToken(): string | null {
  const t = tokenFromHash(location.hash)
  if (t) {
    held = t
    history.replaceState(history.state, '', location.pathname)
  }
  return held
}

export function Invite() {
  const { route } = useLocation()
  const [token] = useState(takeToken)
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

  if (!token) {
    return (
      <Door>
        <div class="state forbidden" role="alert" data-state="forbidden">
          <span class="kind">no invitation</span>
          <h2>{T.invite.invalidTitle}</h2>
          <p>{T.invite.noToken}</p>
          <p class="how">{T.invite.reload}</p>
        </div>
      </Door>
    )
  }
  if (lookError) {
    return (
      <Door>
        {lookError.code === 'invitation_invalid' ? (
          <div class="state forbidden" role="alert" data-state="forbidden">
            <span class="kind">no invitation</span>
            <h2>{T.invite.invalidTitle}</h2>
            <p>{lookError.message}</p>
            <p class="how">{lookError.howToProceed}</p>
          </div>
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
      held = null
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
        <Field
          label={T.invite.password}
          hint={T.setup.passwordHint}
          type="password"
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
