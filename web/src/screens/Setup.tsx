// First run (spec B4 «Asistente de primera vez», B6 «First run»). Who: the person installing Brain, once.
// Job: name the installation, give its address, create the first administrator. Done when: signed in at
// home. Risk: a password over a connection that is not safe (B4 CA2) — then the form is not offered.

import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { draft } from '../api/draft.ts'
import { api } from '../api/index.ts'
import { resetResources } from '../api/resource.ts'
import { branding, online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { focusFieldOf } from '../ui/fieldOf.ts'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'

type SetupState = {
  done: boolean
  connection: { encrypted: boolean; local: boolean }
  warning: string | null
}

function useDraft(key: string, initial = ''): [string, (v: string) => void, () => void] {
  const d = draft(key, sessionStorage)
  const [v, setV] = useState(() => d.get() || initial)
  return [
    v,
    (x: string) => {
      setV(x)
      d.set(x)
    },
    () => d.clear(),
  ]
}

export function Setup() {
  const { route } = useLocation()
  const b = branding()
  const [state, setState] = useState<SetupState | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [name, setName, clearName] = useDraft('setup.name')
  const [publicUrl, setPublicUrl, clearUrl] = useDraft('setup.publicUrl', location.origin)
  const [adminName, setAdminName, clearAdmin] = useDraft('setup.adminName')
  const [adminEmail, setAdminEmail, clearEmail] = useDraft('setup.adminEmail')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [onField, setOnField] = useState(false)
  const [pending, setPending] = useState(false)

  const look = async (url: string) => {
    try {
      const s = await api.call<SetupState>('setupState', { query: { publicUrl: url } })
      setState(s)
      setWarning(s.warning)
      setLoadError(null)
    } catch (e) {
      setLoadError(e as ApiError)
    }
  }
  useEffect(() => {
    void look(publicUrl)
  }, [])

  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      await api.call('setup', {
        body: { name, publicUrl, admin: { name: adminName, email: adminEmail, password } },
      })
      for (const c of [clearName, clearUrl, clearAdmin, clearEmail]) c()
      resetResources()
      route('/', true)
    } catch (err) {
      setError(err as ApiError)
      setOnField(focusFieldOf((err as ApiError).message))
    } finally {
      setPending(false)
    }
  }

  const done = loadError?.code === 'setup_done' || b.data.value?.setupRequired === false
  if (done) {
    return (
      <Door>
        <h1 class="title">{T.setup.doneTitle}</h1>
        <p class="lead">{T.setup.doneLead}</p>
        <div class="actions">
          <a class="button primary" href="/sign-in">
            {T.setup.goSignIn}
          </a>
        </div>
      </Door>
    )
  }
  if (loadError) {
    return (
      <Door>
        <ErrorState error={loadError} onRetry={() => void look(publicUrl)} />
      </Door>
    )
  }
  if (!state) {
    return (
      <Door wide>
        <Skeleton rows={4} />
      </Door>
    )
  }
  if (!state.connection.encrypted && !state.connection.local) {
    return (
      <Door wide>
        <h1 class="title">{T.setup.title}</h1>
        <div class="alert warn" role="alert" data-state="insecure">
          <span class="kind">not safe</span>
          <strong>{T.setup.insecureTitle}</strong>
          <span>{T.setup.insecureLead}</span>
          <span class="muted">{T.setup.insecureHow}</span>
        </div>
      </Door>
    )
  }
  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <Door wide>
      <div>
        <h1 class="title">{T.setup.title}</h1>
        <p class="lead">{T.setup.lead}</p>
      </div>
      <form class="form" onSubmit={submit} noValidate>
        <FormAlert error={error} focus={!onField} />
        <fieldset>
          <legend>
            <span class="step">1</span> {T.setup.stepInstallation}
          </legend>
          <Field
            label={T.setup.name}
            hint={T.setup.nameHint}
            name="name"
            required
            maxLength={80}
            value={name}
            onValue={setName}
            autoFocus
          />
          <Field
            label={T.setup.publicUrl}
            hint={T.setup.publicUrlHint}
            type="url"
            name="publicUrl"
            required
            value={publicUrl}
            onValue={setPublicUrl}
            onBlur={() => void look(publicUrl)}
            problem={warning}
          />
        </fieldset>
        <hr />
        <fieldset>
          <legend>
            <span class="step">2</span> {T.setup.stepAccount}
          </legend>
          <Field
            label={T.setup.adminName}
            name="adminName"
            autocomplete="name"
            required
            maxLength={80}
            value={adminName}
            onValue={setAdminName}
          />
          <Field
            label={T.setup.adminEmail}
            type="email"
            name="adminEmail"
            autocomplete="email"
            required
            value={adminEmail}
            onValue={setAdminEmail}
          />
          <Field
            label={T.setup.password}
            hint={T.setup.passwordHint}
            type={show ? 'text' : 'password'}
            name="password"
            autocomplete="new-password"
            required
            minLength={12}
            maxLength={200}
            value={password}
            onValue={setPassword}
            after={
              <button
                type="button"
                class="button quiet"
                aria-pressed={show ? 'true' : 'false'}
                onClick={() => setShow(!show)}
              >
                {show ? T.setup.hide : T.setup.show}
              </button>
            }
          />
        </fieldset>
        <div class="actions">
          <Button
            type="submit"
            kind="primary"
            pending={pending}
            pendingLabel={T.setup.submitting}
            blocked={blocked}
          >
            {T.setup.submit}
          </Button>
        </div>
      </form>
    </Door>
  )
}
