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
import { keyFile, keyFileName } from '../lib/backups.ts'
import { branding, justSetUp, online } from '../session.ts'
import { Door } from '../shell/Door.tsx'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
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
  // After the setup: the step «Installation key».
  const [stage, setStage] = useState<'form' | 'key'>('form')
  const [keyName, setKeyName] = useState('')
  // A field fixed is no longer marked; the others keep their problem until the next try.
  const fix = (f: FieldName, set: (v: string) => void) => (v: string) => {
    set(v)
    if (problems[f]) setProblems({ ...problems, [f]: undefined })
  }

  // Installed with rsc-factory: asking again whether it set rsc-brain up, and what the last ask found.
  const [checking, setChecking] = useState(false)
  const [stillWaiting, setStillWaiting] = useState(false)
  const look = async (url: string): Promise<ApiError | null> => {
    try {
      const s = await api.call<SetupState>('setupState', { query: { publicUrl: url } })
      setState(s)
      setWarning(s.warning)
      setLoadError(null)
      return null
    } catch (e) {
      setLoadError(e as ApiError)
      return e as ApiError
    }
  }
  const checkAgain = async () => {
    if (checking) return
    setChecking(true)
    setStillWaiting(false)
    resetResources()
    const e = await look(publicUrl)
    setChecking(false)
    setStillWaiting(e?.code === 'companion_pending')
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
      setKeyName(name.trim())
      resetResources()
      setPassword('')
      // The last step: the installation key, shown once (B7 PR30).
      setStage('key')
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

  if (stage === 'key')
    return (
      <KeyStep
        name={keyName}
        onDone={() => {
          justSetUp.value = true
          route('/', true)
        }}
      />
    )
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
  if (loadError?.code === 'companion_pending') {
    // Installed with rsc-factory (F1-PR11): nothing to fill in here; its own setup makes the administration.
    return (
      <Door brand={false}>
        <h1 class="title">{T.setup.companionTitle}</h1>
        <p class="lead">{T.setup.companionLead}</p>
        {loadError.factoryUrl ? null : <p>{T.setup.companionNoLink}</p>}
        <div class="actions">
          {loadError.factoryUrl ? (
            <a class="button primary" href={loadError.factoryUrl} rel="noopener noreferrer">
              {T.setup.companionOpen}
            </a>
          ) : null}
          <Button
            kind={loadError.factoryUrl ? 'quiet' : 'primary'}
            pending={checking}
            pendingLabel={T.setup.companionChecking}
            onClick={() => void checkAgain()}
          >
            {T.setup.companionCheck}
          </Button>
        </div>
        <p class="meta" role="status" aria-live="polite">
          {stillWaiting ? T.setup.companionStill : ''}
        </p>
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

// The last step of the setup (spec B7 «Copias y restauración»): the installation key, shown once, to copy or
// download, and a tick that it was saved before going on. Held in this screen's memory only, and forgotten when
// the page is put away. When it was already shown, it says where to download it again.
function KeyStep({ name, onDone }: { name: string; onDone: () => void }) {
  const K = T.setup
  const [k, setK] = useState<{ key: string; keyId: string } | null>(null)
  // Already shown (404), or forgotten when the page was put away: either way, where to get it again.
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)
  const [href, setHref] = useState<string | null>(null)
  const load = async () => {
    setError(null)
    try {
      setK(await api.call<{ key: string; keyId: string }>('setupKey', { body: {}, quiet: true }))
    } catch (e) {
      const a = e as ApiError
      if (a.status === 404) setGone(true)
      else setError(a)
    }
  }
  useEffect(() => {
    void load()
    const away = () => {
      setK(null)
      setGone(true)
    }
    window.addEventListener('pagehide', away)
    return () => window.removeEventListener('pagehide', away)
  }, [])
  useEffect(() => {
    if (!k) return setHref(null)
    const url = URL.createObjectURL(new Blob([keyFile(k.key)], { type: 'text/plain' }))
    setHref(url)
    return () => URL.revokeObjectURL(url)
  }, [k])
  useEffect(() => {
    document.querySelector<HTMLElement>('.key-step h1')?.focus()
  }, [k !== null, gone])
  const finish = () => {
    setK(null)
    onDone()
  }
  return (
    <Door wide brand={false}>
      <div class="key-step">
        <p class="meta">
          <span class="step">3</span> {K.keyStep}
        </p>
        <h1 class="title" tabIndex={-1}>
          {gone ? K.keyGoneTitle : K.keyTitle}
        </h1>
        {gone ? (
          <>
            <p class="lead">{K.keyGone}</p>
            <div class="actions">
              <Button kind="primary" onClick={finish}>
                {K.keyContinue}
              </Button>
            </div>
          </>
        ) : error ? (
          <>
            <ErrorState error={error} onRetry={() => void load()} />
            <p>{K.keyFailedLater}</p>
            <div class="actions">
              <Button kind="quiet" onClick={finish}>
                {K.keyContinue}
              </Button>
            </div>
          </>
        ) : !k ? (
          <Skeleton rows={2} label={K.keyLoading} />
        ) : (
          <>
            <p class="lead">{K.keyLead}</p>
            <pre class="command">
              <code>{k.key}</code>
            </pre>
            <p class="meta mono">{K.keyIdIs(k.keyId)}</p>
            <p>{K.keyWhere}</p>
            <div class="actions">
              <CopyButton text={k.key} label={K.copyKey} id="copy-setup-key" />
              {href ? (
                <a class="button" href={href} download={keyFileName(name, k.keyId)}>
                  {K.downloadKey}
                </a>
              ) : null}
            </div>
            <div class="pick">
              <input
                type="checkbox"
                id="key-saved"
                checked={saved}
                onChange={(e) => setSaved((e.currentTarget as HTMLInputElement).checked)}
              />
              <label for="key-saved">{K.keySaved}</label>
            </div>
            <p class="meta">{K.keyLater}</p>
            <div class="actions">
              <Button
                kind="primary"
                blocked={saved ? null : K.keyNeedsSaved}
                data-needs="key-saved"
                onClick={finish}
              >
                {K.keyContinue}
              </Button>
            </div>
          </>
        )}
      </div>
    </Door>
  )
}
