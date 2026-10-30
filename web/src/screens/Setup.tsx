// First run (spec B4 «Asistente de primera vez», B6 «First run»). Who: the person installing Brain, once.
// Job: name the installation, give its address, create the first administrator. Done when: signed in at
// home. Risk: a password over a connection that is not safe (B4 CA2) — then the form is not offered.
// The form is checked in the browser first; every problem sits next to its field (aria-invalid,
// aria-describedby) and the keyboard goes to the first one. A refusal of the server about one field is
// shown there too; only a refusal about no field is a banner.

import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { draft } from '../api/draft.ts'
import { api } from '../api/index.ts'
import { resetResources } from '../api/resource.ts'
import { branding, justSetUp, online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { PasswordField } from '../ui/PasswordField.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'

type FieldName = 'name' | 'publicUrl' | 'adminName' | 'adminEmail' | 'password'
type Problems = Partial<Record<FieldName, string>>
const ORDER: FieldName[] = ['name', 'publicUrl', 'adminName', 'adminEmail', 'password']

// What to fix before sending, in the order of the form. The server checks the same and more.
export function setupProblems(v: Record<FieldName, string>): Problems {
  const n = T.setup.need
  const p: Problems = {}
  const name = v.name.trim()
  if (!name) p.name = n.name
  else if (name.length > 80) p.name = n.nameLong
  const url = v.publicUrl.trim()
  if (!url) p.publicUrl = n.publicUrl
  else if (!/^https?:\/\/[^\s/?#]+/i.test(url)) p.publicUrl = n.publicUrlBad
  const admin = v.adminName.trim()
  if (!admin) p.adminName = n.adminName
  else if (admin.length > 80) p.adminName = n.adminNameLong
  const email = v.adminEmail.trim()
  if (!email) p.adminEmail = n.adminEmail
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) p.adminEmail = n.adminEmailBad
  if (!v.password) p.password = n.password
  else if (v.password.length < 12) p.password = n.passwordShort
  else if (v.password.length > 200) p.password = n.passwordLong
  return p
}

// Which field a refusal of the server is about, from its words.
function fieldOfRefusal(message: string): FieldName | null {
  if (/password/i.test(message)) return 'password'
  if (/publicUrl|address/i.test(message)) return 'publicUrl'
  if (/installation needs a name/i.test(message)) return 'name'
  if (/account name/i.test(message)) return 'adminName'
  if (/email/i.test(message)) return 'adminEmail'
  return null
}

function focusField(name: FieldName): void {
  const el = document.querySelector<HTMLInputElement>(`form input[name="${name}"]`)
  el?.focus()
  el?.select()
}

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
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [problems, setProblems] = useState<Problems>({})
  const [pending, setPending] = useState(false)
  // A field fixed is no longer marked; the others keep their problem until the next try.
  const fix = (f: FieldName, set: (v: string) => void) => (v: string) => {
    set(v)
    if (problems[f]) setProblems({ ...problems, [f]: undefined })
  }

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
    setError(null)
    const found = setupProblems({ name, publicUrl, adminName, adminEmail, password })
    setProblems(found)
    const first = ORDER.find((f) => found[f])
    if (first) {
      focusField(first)
      return
    }
    setPending(true)
    try {
      await api.call('setup', {
        body: {
          name: name.trim(),
          publicUrl: publicUrl.trim(),
          admin: { name: adminName.trim(), email: adminEmail.trim(), password },
        },
      })
      for (const c of [clearName, clearUrl, clearAdmin, clearEmail]) c()
      resetResources()
      justSetUp.value = true
      route('/', true)
    } catch (err) {
      const a = err as ApiError
      const f = a.status === 400 ? fieldOfRefusal(a.message) : null
      if (f) {
        setProblems({ [f]: `${a.message} ${a.howToProceed}` })
        focusField(f)
      } else {
        setError(a)
      }
    } finally {
      setPending(false)
    }
  }

  const done = loadError?.code === 'setup_done' || b.data.value?.setupRequired === false
  if (done) {
    return (
      <Door brand={false}>
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
      <Door brand={false}>
        <ErrorState error={loadError} onRetry={() => void look(publicUrl)} />
      </Door>
    )
  }
  if (!state) {
    return (
      <Door wide brand={false}>
        <Skeleton rows={4} />
      </Door>
    )
  }
  if (!state.connection.encrypted && !state.connection.local) {
    return (
      <Door wide brand={false}>
        <h1 class="title">{T.setup.title}</h1>
        <div class="alert warn" role="alert" data-state="insecure">
          <span class="kind">{T.kind.notSafe}</span>
          <strong>{T.setup.insecureTitle}</strong>
          <span>{T.setup.insecureLead}</span>
          <span class="muted">{T.setup.insecureHow}</span>
        </div>
      </Door>
    )
  }
  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <Door wide brand={false}>
      <div>
        <h1 class="title">{T.setup.title}</h1>
        <p class="lead">{T.setup.lead}</p>
      </div>
      <form class="form" onSubmit={submit} noValidate>
        <FormAlert error={error} />
        <fieldset>
          <legend>
            <span class="step">1</span> {T.setup.stepInstallation}
          </legend>
          <Field
            label={T.setup.name}
            hint={T.setup.nameHint}
            name="name"
            required
            value={name}
            onValue={fix('name', setName)}
            problem={problems.name}
            autoFocus
          />
          <Field
            label={T.setup.publicUrl}
            hint={T.setup.publicUrlHint}
            type="url"
            name="publicUrl"
            required
            value={publicUrl}
            onValue={fix('publicUrl', setPublicUrl)}
            onBlur={() => void look(publicUrl)}
            problem={problems.publicUrl}
            note={warning}
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
            value={adminName}
            onValue={fix('adminName', setAdminName)}
            problem={problems.adminName}
          />
          <Field
            label={T.setup.adminEmail}
            type="email"
            name="adminEmail"
            autocomplete="email"
            required
            value={adminEmail}
            onValue={fix('adminEmail', setAdminEmail)}
            problem={problems.adminEmail}
          />
          <PasswordField
            label={T.setup.password}
            hint={T.setup.passwordHint}
            name="password"
            autocomplete="new-password"
            required
            value={password}
            onValue={fix('password', setPassword)}
            problem={problems.password}
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
