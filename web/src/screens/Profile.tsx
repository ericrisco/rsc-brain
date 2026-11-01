// Profile (spec B6 «Profile», B4 «Tokens personales», plan T042). Who: anyone signed in. Jobs: make a
// token for an agent or a script and copy it once; see and revoke tokens and connected apps; choose email
// notices by brain; change the password; turn the second factor on or off; sign out everywhere. Done
// when: each says it is done, in words. Risks: a token or a second-factor key that leaks — each lives
// only in this screen's memory, is shown once, and is gone when the person says it is copied (CA13).
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { useFresh } from '../api/fresh.ts'
import { api, forgetSession } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import { ago } from '../lib/brains.ts'
import {
  brainsLabel,
  groupKey,
  lastUseLabel,
  notifyRows,
  permLabel,
  TOKEN_DAYS,
  type TokenForm,
  tokenRequest,
} from '../lib/profile.ts'
import { branding, justSignedOut, type Me, me, online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Field } from '../ui/Field.tsx'
import { PasswordField } from '../ui/PasswordField.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'
import { brainsResource } from './Home.tsx'

type Token = {
  id: string
  name: string
  last4: string
  perm: string
  allBrains: boolean
  brains: string[] | null
  createdAt: string
  expiresAt: string
  expiresSoon: boolean
  lastUsedAt: string | null
  lastClient: string | null
}
type App = {
  id: string
  name: string
  nameNote: string
  brains: string[]
  perm: string
  lastUsedAt: string
  endsAt: string
}
type Made = { token: { id: string; secret: string; expiresAt: string }; note?: string }

const PAGE = 20
const P = T.profile

export const tokensResource = () =>
  resource<{ tokens: Token[] }>('profile:tokens', () => api.call<{ tokens: Token[] }>('tokens'))
const appsResource = () => resource<{ apps: App[] }>('profile:apps', () => api.call<{ apps: App[] }>('apps'))

const blocked = () => writeBlocked({ online: online.value, pending: false })

// A list that shows 20 at first and the rest on request (spec B6 «Mucho dato»).
function useShowAll<X>(items: X[]): { shown: X[]; more: number; showAll: () => void } {
  const [all, setAll] = useState(false)
  return {
    shown: all ? items : items.slice(0, PAGE),
    more: all ? 0 : Math.max(0, items.length - PAGE),
    showAll: () => setAll(true),
  }
}

// A row that can be revoked, after a second press that names what goes.
function Revocable({
  id,
  name,
  children,
  onRevoke,
}: {
  id: string
  name: string
  children: ComponentChildren
  onRevoke: () => Promise<void>
}) {
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const back = useRef(false)
  const revokeId = `revoke-${id}`
  useEffect(() => {
    if (asking) document.getElementById(`${revokeId}-yes`)?.focus()
    else if (back.current) document.getElementById(revokeId)?.focus()
    back.current = false
  }, [asking])
  return (
    <li class="with-actions">
      <div>{children}</div>
      {asking ? (
        <div class="confirm">
          <p>{P.revokeLead}</p>
          <FormAlert error={error} />
          <div class="actions">
            <Button
              id={`${revokeId}-yes`}
              kind="primary"
              pending={pending}
              pendingLabel={T.states.pending}
              blocked={blocked()}
              onClick={async () => {
                setPending(true)
                setError(null)
                try {
                  await onRevoke()
                } catch (e) {
                  setError(e as ApiError)
                  setPending(false)
                }
              }}
            >
              {P.revokeNamed(name)}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                back.current = true
                setAsking(false)
              }}
            >
              {P.keep}
            </Button>
          </div>
        </div>
      ) : (
        <div class="actions">
          <Button id={revokeId} onClick={() => setAsking(true)}>
            {P.revoke}
          </Button>
        </div>
      )}
    </li>
  )
}

function NewTokenForm({
  onMade,
  onCancel,
}: {
  onMade: (m: Made, name: string) => void
  onCancel: () => void
}) {
  const brains = brainsResource().data.value?.brains ?? []
  const [f, setF] = useState<TokenForm>({ name: '', perm: 'write', days: 90, scope: 'all', brains: [] })
  const [problems, setProblems] = useState<{ name?: string; brains?: string }>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const nameRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    nameRef.current?.querySelector('input')?.focus()
  }, [])
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    const req = tokenRequest(f)
    setProblems(req.problems)
    if (!req.body) {
      const first = req.problems.name ? '#token-name' : '#token-brains input'
      document.querySelector<HTMLElement>(first)?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      onMade(await api.call<Made>('createToken', { body: req.body }), req.body.name)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  const toggle = (slug: string, on: boolean) =>
    setF({ ...f, brains: on ? [...f.brains, slug] : f.brains.filter((x) => x !== slug) })
  return (
    <form class="form token-form" aria-labelledby="new-token-title" onSubmit={submit} noValidate>
      <h3 id="new-token-title" class="part-title">
        {P.newToken}
      </h3>
      <FormAlert error={error} />
      <div ref={nameRef}>
        <Field
          id="token-name"
          label={P.name}
          hint={P.nameHint}
          problem={problems.name}
          maxLength={120}
          value={f.name}
          onValue={(v) => setF({ ...f, name: v })}
          autocomplete="off"
        />
      </div>
      <fieldset
        class="choice"
        id="token-brains"
        aria-describedby={problems.brains ? 'token-brains-problem' : undefined}
      >
        <legend>{P.brains}</legend>
        <label class="radio">
          <input
            type="radio"
            name="token-scope"
            checked={f.scope === 'all'}
            onChange={() => setF({ ...f, scope: 'all' })}
          />
          {P.allBrains}
        </label>
        <label class="radio">
          <input
            type="radio"
            name="token-scope"
            checked={f.scope === 'some'}
            onChange={() => setF({ ...f, scope: 'some' })}
          />
          {P.someBrains}
        </label>
        {f.scope === 'some' ? (
          brains.length ? (
            <ul class="token-brains">
              {brains.map((b) => (
                <li key={b.slug} class="pick">
                  <input
                    type="checkbox"
                    id={`tb-${b.slug}`}
                    checked={f.brains.includes(b.slug)}
                    onChange={(e) => toggle(b.slug, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  <label for={`tb-${b.slug}`}>{b.name}</label>
                </li>
              ))}
            </ul>
          ) : (
            <p class="meta">{P.noBrainsYet}</p>
          )
        ) : null}
        {problems.brains ? (
          <span id="token-brains-problem" class="problem">
            {problems.brains}
          </span>
        ) : null}
      </fieldset>
      <fieldset class="choice">
        <legend>{P.perm}</legend>
        <label class="radio">
          <input
            type="radio"
            name="token-perm"
            checked={f.perm === 'read'}
            onChange={() => setF({ ...f, perm: 'read' })}
          />
          {P.read}
        </label>
        <label class="radio">
          <input
            type="radio"
            name="token-perm"
            checked={f.perm === 'write'}
            onChange={() => setF({ ...f, perm: 'write' })}
          />
          {P.write}
        </label>
      </fieldset>
      <div class="field">
        <label for="token-days">{P.expires}</label>
        <select
          id="token-days"
          value={String(f.days)}
          onChange={(e) => setF({ ...f, days: Number((e.currentTarget as HTMLSelectElement).value) })}
        >
          {TOKEN_DAYS.map((d) => (
            <option key={d} value={String(d)}>
              {P.days(d)}
            </option>
          ))}
        </select>
      </div>
      <div class="actions">
        <Button type="submit" kind="primary" pending={pending} pendingLabel={P.creating} blocked={blocked()}>
          {P.create}
        </Button>
        <Button kind="quiet" onClick={onCancel}>
          {P.cancel}
        </Button>
      </div>
    </form>
  )
}

function OnceToken({ made, onDone }: { made: Made; onDone: () => void }) {
  useEffect(() => {
    const b = document.getElementById('copy-new-token')
    b?.focus({ preventScroll: true })
    b?.scrollIntoView({ block: 'center' })
  }, [])
  return (
    <section class="once" aria-labelledby="once-title">
      <h3 id="once-title" class="part-title">
        {P.yourToken}
      </h3>
      <p>{P.tokenOnce}</p>
      <pre class="command">
        <code>{made.token.secret}</code>
      </pre>
      <p class="meta">{T.connect.tokenUntil(T.date(made.token.expiresAt))}</p>
      {made.note ? <p class="meta">{made.note}</p> : null}
      <div class="actions">
        <CopyButton text={made.token.secret} label={P.copyToken} id="copy-new-token" />
        <Button kind="primary" onClick={onDone}>
          {P.done}
        </Button>
      </div>
    </section>
  )
}

function Tokens({ start }: { start: boolean }) {
  const r = tokensResource()
  useFresh(r)
  const [form, setForm] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const createRef = useRef<HTMLDivElement>(null)
  const items = r.data.value?.tokens ?? []
  const { shown, more, showAll } = useShowAll(items)
  useEffect(() => {
    if (start) heading.current?.scrollIntoView({ block: 'start' })
  }, [])
  const madeName = useRef('')
  // Set when the token is hidden: once what it says is drawn, the keyboard goes there.
  const [toSaid, setToSaid] = useState(0)
  useEffect(() => {
    if (toSaid) document.getElementById('tokens-said')?.focus()
  }, [toSaid])
  return (
    <section class="profile-part" id="tokens" aria-labelledby="tokens-title">
      <h2
        id="tokens-title"
        class="section-title flush"
        tabIndex={-1}
        ref={heading}
        data-start={start ? '' : undefined}
      >
        {P.tokens}
      </h2>
      <p class="muted">{P.tokensLead}</p>
      <p role="status" class="said" tabIndex={-1} id="tokens-said">
        {said}
      </p>
      {made ? (
        <OnceToken
          made={made}
          onDone={() => {
            setSaid(P.hidden(madeName.current))
            setMade(null)
            setToSaid((n) => n + 1)
          }}
        />
      ) : form ? (
        <NewTokenForm
          onMade={(m, name) => {
            madeName.current = name
            setForm(false)
            setSaid(null)
            setMade(m)
            invalidate('profile:tokens')
          }}
          onCancel={() => {
            setForm(false)
            createRef.current?.querySelector('button')?.focus()
          }}
        />
      ) : (
        <div class="actions" ref={createRef}>
          <Button
            kind="primary"
            blocked={blocked()}
            onClick={() => {
              setSaid(null)
              setForm(true)
            }}
          >
            {P.createToken}
          </Button>
        </div>
      )}
      {r.data.value === undefined ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : items.length === 0 ? (
        <div class="quiet-empty" data-state="empty">
          <p class="list-title">{P.noTokens}</p>
          <p class="muted">{P.noTokensLead}</p>
        </div>
      ) : (
        <>
          <ul class="list" aria-label={P.list}>
            {shown.map((t) => (
              <Revocable
                key={t.id}
                id={t.id}
                name={t.name}
                onRevoke={async () => {
                  await api.call('revokeToken', { path: { id: t.id } })
                  setSaid(P.revoked(t.name))
                  await r.reload()
                  heading.current?.focus()
                }}
              >
                <p class="list-title">
                  {t.name} <span class="tag mono">…{t.last4}</span>
                  {t.expiresSoon ? <span class="tag warn">{P.endsSoon}</span> : null}
                </p>
                <p class="meta">
                  {permLabel(t.perm)} · {brainsLabel(t)}
                </p>
                <p class="meta">
                  {lastUseLabel(t)} · {P.endsOn(T.date(t.expiresAt))}
                </p>
              </Revocable>
            ))}
          </ul>
          {more ? (
            <div class="actions">
              <Button onClick={showAll}>{P.showAll(items.length)}</Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function Apps() {
  const r = appsResource()
  useFresh(r)
  const [said, setSaid] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const items = r.data.value?.apps ?? []
  const { shown, more, showAll } = useShowAll(items)
  return (
    <section class="profile-part" aria-labelledby="apps-title">
      <h2 id="apps-title" class="section-title flush" tabIndex={-1} ref={heading}>
        {P.apps}
      </h2>
      <p class="muted">{P.appsLead}</p>
      <p role="status" class="said">
        {said}
      </p>
      {r.data.value === undefined ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={1} />
        )
      ) : items.length === 0 ? (
        <div class="quiet-empty" data-state="empty">
          <p class="list-title">{P.noApps}</p>
          <p class="muted">
            {P.noAppsLead} <a href="/connect">{T.connect.open}</a>.
          </p>
        </div>
      ) : (
        <>
          <ul class="list" aria-label={P.apps}>
            {shown.map((a) => (
              <Revocable
                key={a.id}
                id={a.id}
                name={a.name}
                onRevoke={async () => {
                  await api.call('revokeApp', { path: { id: a.id } })
                  setSaid(P.revoked(a.name))
                  await r.reload()
                  heading.current?.focus()
                }}
              >
                <p class="list-title">{a.name}</p>
                <p class="meta">
                  {permLabel(a.perm)} · {a.brains.join(', ')}
                </p>
                <p class="meta">
                  {P.lastUsed(ago(a.lastUsedAt) ?? '')} · {P.appEnds(T.date(a.endsAt))}
                </p>
                <p class="meta">{a.nameNote}</p>
              </Revocable>
            ))}
          </ul>
          {more ? (
            <div class="actions">
              <Button onClick={showAll}>{P.showAll(items.length)}</Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function Notices() {
  const r = brainsResource()
  const [pending, setPending] = useState<string | null>(null)
  const [told, setTold] = useState<Record<string, boolean>>({})
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const mail = branding().data.value?.canSendMail !== false
  const rows = notifyRows(r.data.value?.brains ?? [])
  const set = async (slug: string, name: string, on: boolean) => {
    if (pending || !online.value) return
    const before = told
    setPending(slug)
    setError(null)
    // The box moves at once; a refusal puts it back and says why.
    setTold({ ...told, [slug]: on })
    try {
      await api.call('notify', { path: { slug }, body: { notifyProposals: on } })
      setSaid(on ? P.noticesOn(name) : P.noticesOff(name))
      invalidate('brains')
    } catch (e) {
      setTold(before)
      setError(e as ApiError)
    } finally {
      setPending(null)
    }
  }
  return (
    <section class="profile-part" aria-labelledby="notices-title">
      <h2 id="notices-title" class="section-title flush">
        {P.notices}
      </h2>
      <p class="muted">{P.noticesLead}</p>
      {mail ? null : <p class="meta">{P.noMail}</p>}
      <p role="status" class="said">
        {said}
      </p>
      <FormAlert error={error} />
      {r.data.value === undefined ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={1} />
        )
      ) : rows.length === 0 ? (
        <p class="quiet-empty" data-state="empty">
          {P.noBrains}
        </p>
      ) : (
        <ul class="list compact">
          {rows.map((b) => {
            const on = told[b.slug] ?? b.on
            return (
              <li key={b.slug}>
                {b.can ? (
                  <span class="pick">
                    <input
                      type="checkbox"
                      id={`notify-${b.slug}`}
                      checked={on}
                      aria-disabled={pending === b.slug || !online.value ? 'true' : undefined}
                      onChange={(e) => {
                        const want = (e.currentTarget as HTMLInputElement).checked
                        // Not sent: the box shows what is set.
                        if (pending || !online.value) {
                          ;(e.currentTarget as HTMLInputElement).checked = on
                          return
                        }
                        void set(b.slug, b.name, want)
                      }}
                    />
                    <label for={`notify-${b.slug}`}>{b.name}</label>
                  </span>
                ) : (
                  <span>
                    {b.name} <span class="meta">· {P.onlyCurators}</span>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Password({ who }: { who: Me }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    setDone(false)
    try {
      await api.call('changePassword', { body: { current, next } })
      setCurrent('')
      setNext('')
      setDone(true)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <form class="form profile-sub" aria-label={P.passwordForm} onSubmit={submit} noValidate>
      <h3 class="part-title">{P.password}</h3>
      <p role="status" class="said">
        {done ? P.changed : null}
      </p>
      <FormAlert error={error} />
      <input
        type="email"
        name="email"
        autocomplete="username"
        value={who.account.email ?? ''}
        hidden
        readOnly
      />
      <PasswordField
        label={P.current}
        name="current-password"
        autocomplete="current-password"
        maxLength={200}
        value={current}
        onValue={setCurrent}
      />
      <PasswordField
        label={P.next}
        hint={P.nextHint}
        name="new-password"
        autocomplete="new-password"
        minLength={12}
        maxLength={200}
        value={next}
        onValue={setNext}
      />
      <div class="actions">
        <Button type="submit" pending={pending} pendingLabel={P.changing} blocked={blocked()}>
          {P.change}
        </Button>
      </div>
    </form>
  )
}

type Enrol = { secret: string; otpauthUrl: string }

function SecondFactor({ who }: { who: Me }) {
  const on = who.account.totp === true
  // off: nothing open; enrol: the key and the code; disable: the code to turn it off.
  const [step, setStep] = useState<'idle' | 'enrol' | 'disable'>('idle')
  const [enrol, setEnrol] = useState<Enrol | null>(null)
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ message: string; howToProceed?: string } | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const reset = () => {
    setStep('idle')
    setEnrol(null)
    setCode('')
    setError(null)
  }
  const start = async () => {
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    setSaid(null)
    try {
      setEnrol(await api.call<Enrol>('totpStart', { body: {} }))
      setStep('enrol')
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  const finish = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    if (!/^\d{6}$/.test(code.trim())) {
      setError({ message: P.codeNeeded })
      return
    }
    setPending(true)
    setError(null)
    try {
      if (step === 'enrol') await api.call('totpConfirm', { body: { code: code.trim() } })
      else await api.call('totpDisable', { body: { code: code.trim() } })
      const turnedOn = step === 'enrol'
      reset()
      setSaid(turnedOn ? P.totpIsOn : P.totpIsOff)
      await me().reload()
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <section class="profile-sub" aria-labelledby="totp-title">
      <h3 id="totp-title" class="part-title">
        {P.totp}
      </h3>
      <p class="muted">{P.totpLead}</p>
      <p>
        <span class={`tag${on ? ' ok' : ''}`}>{on ? P.totpOn : P.totpOff}</span>
      </p>
      <p role="status" class="said">
        {said}
      </p>
      {step === 'idle' ? (
        <>
          <FormAlert error={error} />
          <div class="actions">
            {on ? (
              <Button blocked={blocked()} onClick={() => setStep('disable')}>
                {P.turnOff}
              </Button>
            ) : (
              <Button
                pending={pending}
                pendingLabel={T.states.pending}
                blocked={blocked()}
                onClick={() => void start()}
              >
                {P.turnOn}
              </Button>
            )}
          </div>
        </>
      ) : (
        <form class="form" onSubmit={finish} noValidate>
          {step === 'enrol' && enrol ? (
            <div class="totp-key">
              <p>{P.keyStep}</p>
              <p class="key">
                <span class="sr-only">{P.keyLabel}: </span>
                <code>{groupKey(enrol.secret)}</code>
              </p>
              <div class="actions">
                <CopyButton text={enrol.secret} label={P.copyKey} />
                <a class="button quiet" href={enrol.otpauthUrl}>
                  {P.openApp}
                </a>
              </div>
              <p>{P.codeStep}</p>
            </div>
          ) : (
            <p>{P.offLead}</p>
          )}
          <FormAlert error={error} />
          <Field
            label={P.code}
            hint={P.codeHint}
            name="one-time-code"
            autocomplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onValue={setCode}
            autoFocus
          />
          <div class="actions">
            <Button
              type="submit"
              kind="primary"
              pending={pending}
              pendingLabel={T.states.pending}
              blocked={blocked()}
            >
              {step === 'enrol' ? P.turnOn : P.turnOffConfirm}
            </Button>
            <Button kind="quiet" onClick={reset}>
              {P.cancel}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

function Everywhere() {
  const { route } = useLocation()
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const yes = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (asking) yes.current?.querySelector('button')?.focus()
  }, [asking])
  const go = async () => {
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      await api.call('logoutEverywhere', { body: {} })
    } catch (e) {
      // A session the server no longer knows is signed out already.
      if ((e as ApiError).status !== 401) {
        setError(e as ApiError)
        setPending(false)
        return
      }
    }
    forgetSession()
    justSignedOut.value = true
    route('/sign-in', true)
  }
  return (
    <section class="profile-sub" aria-labelledby="everywhere-title">
      <h3 id="everywhere-title" class="part-title">
        {P.everywhere}
      </h3>
      <p class="muted">{P.everywhereLead}</p>
      <FormAlert error={error} />
      {asking ? (
        <div class="confirm">
          <p>{P.everywhereConfirm}</p>
          <div class="actions" ref={yes}>
            <Button
              kind="primary"
              pending={pending}
              pendingLabel={P.leaving}
              blocked={blocked()}
              onClick={() => void go()}
            >
              {P.everywhereYes}
            </Button>
            <Button kind="quiet" onClick={() => setAsking(false)}>
              {P.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div class="actions">
          <Button blocked={blocked()} onClick={() => setAsking(true)}>
            {P.everywhere}
          </Button>
        </div>
      )}
    </section>
  )
}

export function Profile() {
  const { path } = useLocation()
  const who = me().data.value
  if (!who) return <Skeleton rows={3} />
  return (
    <div class="profile">
      <div class="title-row">
        <div class="title-group">
          <h1 class="title">{P.title}</h1>
          <span class="meta">
            {who.account.name}
            {who.account.email ? ` · ${who.account.email}` : ''}
          </span>
        </div>
      </div>
      <div class="profile-grid">
        <div class="profile-main">
          <Tokens start={path === '/profile/tokens'} />
          <Apps />
        </div>
        <div class="profile-side">
          <Notices />
          <section class="profile-part" aria-labelledby="security-title">
            <h2 id="security-title" class="section-title flush">
              {P.security}
            </h2>
            <Password who={who} />
            <SecondFactor who={who} />
            <Everywhere />
          </section>
        </div>
      </div>
    </div>
  )
}
