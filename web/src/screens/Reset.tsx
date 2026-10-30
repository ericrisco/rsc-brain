// Reset a password (spec B4 «Recuperar contraseña»): ask for a link by email, then choose a new password
// with the link's token ("#token=", taken out of the address at once). The answer to "send me a link" is
// the same whether the email has an account or not. An installation that cannot send email says so at
// once (ask an administrator for a link), which tells nothing about any account.
import { useEffect, useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { useLinkToken } from '../lib/linkToken.ts'
import { branding, online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { LinkProblem } from '../shell/LinkProblem.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { focusFieldOf } from '../ui/fieldOf.ts'
import { StepTitle } from '../ui/Heading.tsx'
import { PasswordField } from '../ui/PasswordField.tsx'
import { writeBlocked } from '../ui/state.ts'
import { FormAlert } from '../ui/states.tsx'

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

function NoMail() {
  return (
    <>
      <div>
        <h1 class="title">{T.reset.requestTitle}</h1>
      </div>
      <div class="alert warn" data-state="no-mail">
        <span class="kind">{T.kind.warning}</span>
        <span>{T.reset.noMail}</span>
        <span class="muted">{T.reset.noMailHow}</span>
      </div>
      <div class="actions">
        <a class="button" href="/sign-in">
          {T.reset.backToSignIn}
        </a>
      </div>
    </>
  )
}

function Confirm({ token, spent, askNew }: { token: string; spent: () => void; askNew: () => void }) {
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [onField, setOnField] = useState(false)
  const [pending, setPending] = useState(false)
  // A link pasted into a tab already open mounts this form after the page loaded, when the browser no
  // longer honours autofocus: the keyboard is put on the new password by hand, unless it is elsewhere.
  useEffect(() => {
    const a = document.activeElement
    if (!a || a === document.body)
      document.querySelector<HTMLInputElement>('form input[name="password"]')?.focus()
  }, [])
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      await api.call('resetConfirm', { body: { token, password } })
      spent()
      setDone(true)
    } catch (err) {
      setError(err as ApiError)
      setOnField(focusFieldOf((err as ApiError).message))
    } finally {
      setPending(false)
    }
  }
  if (error?.code === 'link_invalid') {
    return (
      <LinkProblem title={T.reset.invalidTitle} message={error.message}>
        <a
          class="button primary"
          href="/reset"
          onClick={(e) => {
            e.preventDefault()
            askNew()
          }}
        >
          {T.reset.askNew}
        </a>
        <a href="/sign-in">{T.reset.backToSignIn}</a>
      </LinkProblem>
    )
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
        <PasswordField
          label={T.reset.password}
          hint={T.setup.passwordHint}
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
  const link = useLinkToken('reset')
  const canSendMail = branding().data.value?.canSendMail
  const body = link.token ? (
    <Confirm key={link.visit} token={link.token} spent={link.spend} askNew={() => link.forget()} />
  ) : canSendMail === false ? (
    <NoMail />
  ) : (
    <Request key={link.visit} />
  )
  return <Door>{body}</Door>
}
