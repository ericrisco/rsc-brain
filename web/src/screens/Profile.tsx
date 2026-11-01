// Profile (spec B6 «Profile», B4 «Tokens personales», plan T042). Who: anyone signed in. Jobs: make a
// token for an agent or a script and copy it once; see and revoke tokens and connected apps; choose email
// notices by brain; change the password; turn the second factor on or off; sign out everywhere. Done
// when: each says it is done, in words. Risks: a token or a second-factor key that leaks — each lives
// only in this screen's memory, is shown once, and is gone when the person says it is copied (CA13).
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import qrcode from 'qrcode-generator'
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
  passwordChanged,
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
  expired: boolean
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
  ended: boolean
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

function Tokens({ start, forget }: { start: boolean; forget: number }) {
  const r = tokensResource()
  useFresh(r)
  const [form, setForm] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const createRef = useRef<HTMLDivElement>(null)
  const all = r.data.value?.tokens ?? []
  const items = all.filter((t) => !t.expired)
  const expired = all.filter((t) => t.expired)
  const { shown, more, showAll } = useShowAll(items)
  useEffect(() => {
    if (start) heading.current?.scrollIntoView({ block: 'start' })
  }, [])
  // Put in the back/forward cache, the token shown is forgotten.
  useEffect(() => {
    if (forget) setMade(null)
  }, [forget])
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
      ) : all.length === 0 ? (
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
          {expired.length ? (
            <>
              <h3 class="part-title" id="expired-title">
                {P.expired}
              </h3>
              <ul class="list" aria-labelledby="expired-title">
                {expired.map((t) => (
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
                    </p>
                    <p class="meta">
                      {permLabel(t.perm)} · {brainsLabel(t)}
                    </p>
                    <p class="meta">
                      {lastUseLabel(t)} · {P.endedOn(T.date(t.expiresAt))}
                    </p>
                  </Revocable>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  )
}

function Apps() {
  const r = appsResource()
  // Brains by their names, as people know them (the API gives their addresses).
  const names = new Map((brainsResource().data.value?.brains ?? []).map((b) => [b.slug, b.name]))
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
                  {permLabel(a.perm)} · {a.brains.map((x) => names.get(x) ?? x).join(', ')}
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

// Which field a refusal is about, so it is marked and the keyboard goes there.
function passwordFieldOf(e: ApiError): 'current' | 'next' | 'code' | null {
  if (e.code === 'wrong_password') return 'current'
  if (/code/i.test(e.message)) return 'code'
  if (/password has/i.test(e.message)) return 'next'
  return null
}

function Password({ who }: { who: Me }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const totp = who.account.totp === true
  const bad = error ? passwordFieldOf(error) : null
  useEffect(() => {
    if (bad) form.current?.querySelector<HTMLInputElement>(`#pw-${bad}`)?.focus()
  }, [error])
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    setDone(null)
    try {
      await api.call('changePassword', { body: { current, next, ...(totp ? { code: code.trim() } : {}) } })
      setCurrent('')
      setNext('')
      setCode('')
      // What still works after a new password: the tokens and apps the person may want to revoke too.
      // A list that cannot be read again (a reload keeps the old data and sets its error) leaves the count
      // out: an old count could be wrong. The password is changed all the same.
      const t = tokensResource()
      const a = appsResource()
      await Promise.all([t.reload(), a.reload()])
      const read = !t.error.value && !a.error.value
      setDone(passwordChanged(read ? t.data.value?.tokens : undefined, read ? a.data.value?.apps : undefined))
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <form class="form profile-sub" aria-label={P.passwordForm} onSubmit={submit} noValidate ref={form}>
      <h3 class="part-title">{P.password}</h3>
      <p role="status" class="said">
        {done}
      </p>
      <FormAlert error={error} focus={!bad} />
      <input
        type="email"
        name="email"
        autocomplete="username"
        value={who.account.email ?? ''}
        hidden
        readOnly
      />
      <PasswordField
        id="pw-current"
        label={P.current}
        name="current-password"
        autocomplete="current-password"
        maxLength={200}
        value={current}
        onValue={setCurrent}
        problem={bad === 'current' ? error?.message : null}
      />
      <PasswordField
        id="pw-next"
        label={P.next}
        hint={P.nextHint}
        name="new-password"
        autocomplete="new-password"
        minLength={12}
        maxLength={200}
        value={next}
        onValue={setNext}
        problem={bad === 'next' ? error?.message : null}
      />
      {totp ? (
        <Field
          id="pw-code"
          label={P.codeField}
          hint={P.codeHint}
          name="one-time-code"
          autocomplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onValue={setCode}
          problem={bad === 'code' ? error?.message : null}
        />
      ) : null}
      <div class="actions">
        <Button type="submit" pending={pending} pendingLabel={P.changing} blocked={blocked()}>
          {P.change}
        </Button>
      </div>
    </form>
  )
}

function RevokeAll() {
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const yes = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (asking) yes.current?.querySelector('button')?.focus()
  }, [asking])
  useEffect(() => {
    if (said) status.current?.focus()
  }, [said])
  const go = async () => {
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ tokens: number; apps: number }>('revokeAll', { body: {} })
      setAsking(false)
      setSaid(P.revokedAll(r.tokens, r.apps))
      invalidate('profile:')
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <section class="profile-sub" aria-labelledby="keys-title">
      <h3 id="keys-title" class="part-title">
        {P.keys}
      </h3>
      <p class="muted">{P.keysLead}</p>
      <p role="status" class="said" tabIndex={-1} ref={status}>
        {said}
      </p>
      <FormAlert error={error} />
      {asking ? (
        <div class="confirm">
          <p>{P.revokeAllLead}</p>
          <div class="actions" ref={yes}>
            <Button
              kind="primary"
              pending={pending}
              pendingLabel={T.states.pending}
              blocked={blocked()}
              onClick={() => void go()}
            >
              {P.revokeAllYes}
            </Button>
            <Button kind="quiet" onClick={() => setAsking(false)}>
              {P.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div class="actions">
          <Button
            blocked={blocked()}
            onClick={() => {
              setSaid(null)
              setAsking(true)
            }}
          >
            {P.revokeAll}
          </Button>
        </div>
      )}
    </section>
  )
}

type Enrol = { secret: string; otpauthUrl: string }

// The key as a QR code, drawn as SVG (no script, no inline style: the page's CSP allows it).
function Qr({ text }: { text: string }) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
  return (
    <svg
      class="qr"
      viewBox={`0 0 ${n + 8} ${n + 8}`}
      role="img"
      aria-label={P.qr}
      shape-rendering="crispEdges"
    >
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

function SecondFactor({ who, forget }: { who: Me; forget: number }) {
  const on = who.account.totp === true
  // idle: nothing open; enrol: the key and the code; disable: the code to turn it off.
  const [step, setStep] = useState<'idle' | 'enrol' | 'disable'>('idle')
  const [enrol, setEnrol] = useState<Enrol | null>(null)
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ message: string; howToProceed?: string } | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  // Where the keyboard goes next: the code (opened), the status (done) or the button (cancelled).
  const [land, setLand] = useState<'code' | 'status' | 'button' | null>(null)
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!land) return
    const at =
      land === 'code'
        ? box.current?.querySelector<HTMLElement>('#totp-code')
        : land === 'status'
          ? box.current?.querySelector<HTMLElement>('#totp-said')
          : box.current?.querySelector<HTMLElement>('#totp-open')
    at?.focus()
    setLand(null)
  }, [land, step, said, on])
  const reset = () => {
    setStep('idle')
    setEnrol(null)
    setCode('')
    setError(null)
  }
  // Put in the back/forward cache, the key is forgotten.
  useEffect(() => {
    if (forget) reset()
  }, [forget])
  const start = async () => {
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    setSaid(null)
    try {
      setEnrol(await api.call<Enrol>('totpStart', { body: {} }))
      setStep('enrol')
      setLand('code')
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
      setLand('status')
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <section class="profile-sub" aria-labelledby="totp-title" ref={box}>
      <h3 id="totp-title" class="part-title">
        {P.totp}
      </h3>
      <p class="muted">{P.totpLead}</p>
      <p>
        <span class={`tag${on ? ' ok' : ''}`}>{on ? P.totpOn : P.totpOff}</span>
      </p>
      <p role="status" class="said" id="totp-said" tabIndex={-1}>
        {said}
      </p>
      {step === 'idle' ? (
        <>
          <FormAlert error={error} />
          <div class="actions">
            {on ? (
              <Button
                id="totp-open"
                blocked={blocked()}
                onClick={() => {
                  setSaid(null)
                  setStep('disable')
                  setLand('code')
                }}
              >
                {P.turnOff}
              </Button>
            ) : (
              <Button
                id="totp-open"
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
              <p>{P.qrLead}</p>
              <Qr text={enrol.otpauthUrl} />
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
          <FormAlert error={error} focus={false} />
          <Field
            id="totp-code"
            label={P.code}
            hint={P.codeHint}
            name="one-time-code"
            autocomplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onValue={setCode}
            problem={error ? error.message : null}
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
            <Button
              kind="quiet"
              onClick={() => {
                reset()
                setLand('button')
              }}
            >
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
  // Each time the page goes to the back/forward cache, what it shows once is forgotten.
  const [forget, setForget] = useState(0)
  useEffect(() => {
    const away = () => setForget((n) => n + 1)
    window.addEventListener('pagehide', away)
    return () => window.removeEventListener('pagehide', away)
  }, [])
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
          <Tokens start={path === '/profile/tokens'} forget={forget} />
          <Apps />
        </div>
        <div class="profile-side">
          <Notices />
          <section class="profile-part" aria-labelledby="security-title">
            <h2 id="security-title" class="section-title flush">
              {P.security}
            </h2>
            <Password who={who} />
            <RevokeAll />
            <SecondFactor who={who} forget={forget} />
            <Everywhere />
          </section>
        </div>
      </div>
    </div>
  )
}
