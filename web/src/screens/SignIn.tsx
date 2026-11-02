// Sign in (spec B4 «Entrar», B6 «Sign in»): email and password, then the authenticator code when the
// account has one. On success, back to where the person was going (only inside the web).
// Who: anyone with an account. Done when: they see the screen they were going to. Risk: a brake after
// repeated failures; a connection that is not safe for a password.

import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { api, sessionEnded } from '../api/index.ts'
import { resetResources } from '../api/resource.ts'
import { safeNext } from '../lib/nav.ts'
import { branding, installationName, justRestored, justSignedOut, me, online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { PasswordField } from '../ui/PasswordField.tsx'
import { writeBlocked } from '../ui/state.ts'
import { FormAlert } from '../ui/states.tsx'

export function SignIn() {
  const { query, route } = useLocation()
  const next = safeNext(query.next)
  const who = me()
  const name = installationName(branding().data.value)
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)
  // "Signed out." right after signing out; gone once the person does anything here.
  const [signedOut] = useState(() => justSignedOut.value)
  // «Restored. Everyone signs in again» once, after a restore from the administration (its session ended with it).
  const [restored] = useState(() => justRestored.value)
  // "Your session ended." when a session ended while the web was open; never on a plain visit.
  const [ended] = useState(() => sessionEnded.value && !justSignedOut.value)
  useEffect(() => {
    justSignedOut.value = false
    justRestored.value = false
    sessionEnded.value = false
  }, [])

  // Already signed in: straight on.
  useEffect(() => {
    if (who.data.value) route(next, true)
  }, [who.data.value])
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
  }, [step])

  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      await api.call('login', { body: { email, password, ...(step === 'code' ? { code } : {}) } })
      resetResources()
      route(next, true)
    } catch (err) {
      const a = err as ApiError
      if (a.code === 'code_required') {
        setStep('code')
      } else {
        setError(a)
        // The keyboard goes where the fix is: the code, or the password (cleared to retype).
        if (step === 'code') {
          setCode('')
          codeRef.current?.focus()
        } else if (a.code === 'bad_credentials') {
          setPassword('')
          document.querySelector<HTMLInputElement>('input[name="password"]')?.focus()
        }
      }
    } finally {
      setPending(false)
    }
  }

  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <Door>
      {step === 'password' ? (
        <>
          <div>
            <h1 class="title">{T.signIn.title}</h1>
            <p class="lead">{T.signIn.lead(name)}</p>
          </div>
          <form class="form" onSubmit={submit} noValidate>
            {signedOut && !error ? (
              <p class="alert ok" role="status">
                <span class="kind">{T.kind.done}</span>
                <span>{T.signIn.signedOut}</span>
              </p>
            ) : null}
            {restored && !error ? (
              <p class="alert ok" role="status" data-state="restored">
                <span class="kind">{T.kind.done}</span>
                <span>{T.signIn.restored}</span>
              </p>
            ) : null}
            {ended && !restored && !error ? (
              <p class="alert warn" role="status">
                <span class="kind">{T.kind.signedOut}</span>
                <span>{T.signIn.sessionEnded}</span>
              </p>
            ) : null}
            <FormAlert error={error} focus={error?.code !== 'bad_credentials'} />
            <Field
              label={T.signIn.email}
              type="email"
              name="email"
              autocomplete="username"
              required
              value={email}
              onValue={setEmail}
              autoFocus
              data-start
            />
            <PasswordField
              label={T.signIn.password}
              name="password"
              autocomplete="current-password"
              required
              value={password}
              onValue={setPassword}
            />
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={T.signIn.submitting}
                blocked={blocked}
              >
                {T.signIn.submit}
              </Button>
              <a href="/reset">{T.signIn.forgot}</a>
            </div>
          </form>
          <p class="meta">{T.signIn.noAccount}</p>
        </>
      ) : (
        <>
          <div>
            <h1 class="title">{T.signIn.codeTitle}</h1>
            <p class="lead">{T.signIn.codeLead}</p>
          </div>
          <form class="form" onSubmit={submit} noValidate>
            <FormAlert error={error} focus={false} />
            <Field label={T.signIn.email} type="email" value={email} onValue={() => {}} readOnly />
            <div class="field">
              <label for="signin-code">{T.signIn.code}</label>
              <span id="signin-code-hint" class="hint">
                {T.signIn.codeHint}
              </span>
              <input
                ref={codeRef}
                id="signin-code"
                class="code"
                type="text"
                inputMode="numeric"
                autocomplete="one-time-code"
                required
                aria-describedby="signin-code-hint"
                value={code}
                // A pasted "123 456" or "123-456" is the code: everything but digits goes, then six stay.
                onInput={(e) => {
                  const el = e.currentTarget as HTMLInputElement
                  const digits = el.value.replace(/\D/g, '').slice(0, 6)
                  el.value = digits
                  setCode(digits)
                }}
              />
            </div>
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={T.signIn.submitting}
                blocked={blocked}
              >
                {T.signIn.codeSubmit}
              </Button>
              <button
                type="button"
                class="linkish"
                onClick={() => {
                  setStep('password')
                  setCode('')
                  setPassword('')
                  setError(null)
                }}
              >
                {T.signIn.useAnother}
              </button>
            </div>
          </form>
        </>
      )}
    </Door>
  )
}
