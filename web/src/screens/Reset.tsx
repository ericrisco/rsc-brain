// Reset a password (spec B4 «Recuperar contraseña»): ask for a link by email, then choose a new password
// with the link's token ("#token=", taken out of the address at once). The answer to "send me a link" is
// the same whether the email has an account or not.
import { useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { tokenFromHash } from '../lib/nav.ts'
import { online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { focusFieldOf } from '../ui/fieldOf.ts'
import { StepTitle } from '../ui/Heading.tsx'
import { writeBlocked } from '../ui/state.ts'
import { FormAlert } from '../ui/states.tsx'

let held: string | null = null
function takeToken(): string | null {
  const t = tokenFromHash(location.hash)
  if (t) {
    held = t
    history.replaceState(history.state, '', location.pathname)
  }
  return held
}

function Request() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ message: string }>('resetRequest', { body: { email } })
      setSent(r.message)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  if (sent) {
    return (
      <>
        <StepTitle>{T.reset.sentTitle}</StepTitle>
        <FormAlert tone="ok" focus={false} error={{ message: sent }} />
        <div class="actions">
          <a class="button" href="/sign-in">
            {T.reset.backToSignIn}
          </a>
        </div>
      </>
    )
  }
  return (
    <>
      <div>
        <h1 class="title">{T.reset.requestTitle}</h1>
        <p class="lead">{T.reset.requestLead}</p>
      </div>
      <form class="form" onSubmit={submit} noValidate>
        <FormAlert error={error} />
        <Field
          label={T.reset.email}
          type="email"
          name="email"
          autocomplete="username"
          required
          value={email}
          onValue={setEmail}
          autoFocus
        />
        <div class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={T.reset.requesting}
            blocked={writeBlocked({ online: online.value, pending: false })}
          >
            {T.reset.requestSubmit}
          </Button>
          <a href="/sign-in">{T.reset.backToSignIn}</a>
        </div>
      </form>
    </>
  )
}

function Confirm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [onField, setOnField] = useState(false)
  const [pending, setPending] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      await api.call('resetConfirm', { body: { token, password } })
      held = null
      setDone(true)
    } catch (err) {
      setError(err as ApiError)
      setOnField(focusFieldOf((err as ApiError).message))
    } finally {
      setPending(false)
    }
  }
  if (done) {
    return (
      <>
        <StepTitle>{T.reset.doneTitle}</StepTitle>
        <p class="lead">{T.reset.doneLead}</p>
        <div class="actions">
          <a class="button primary" href="/sign-in">
            {T.reset.goSignIn}
          </a>
        </div>
      </>
    )
  }
  return (
    <>
      <div>
        <h1 class="title">{T.reset.confirmTitle}</h1>
        <p class="lead">{T.reset.confirmLead}</p>
      </div>
      <form class="form" onSubmit={submit} noValidate>
        <FormAlert error={error} focus={!onField} />
        <Field
          label={T.reset.password}
          hint={T.setup.passwordHint}
          type="password"
          name="password"
          autocomplete="new-password"
          required
          minLength={12}
          maxLength={200}
          value={password}
          onValue={setPassword}
          autoFocus
        />
        <div class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={T.reset.confirming}
            blocked={writeBlocked({ online: online.value, pending: false })}
          >
            {T.reset.confirmSubmit}
          </Button>
        </div>
      </form>
    </>
  )
}

export function Reset() {
  const [token] = useState(takeToken)
  return <Door>{token ? <Confirm token={token} /> : <Request />}</Door>
}
