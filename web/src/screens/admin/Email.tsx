// Mail (spec B6 «Admin › Email»; spec B4 «Avisos por email»; PR25b). Who: the administration. Jobs: set the
// mail server rsc-brain sends from; check it with a test email; see what did not go, and why. Done when: a
// save says so, a test says where it went or why not, and failures are listed with their reason. Risks: the
// password leaking (never sent back: the screen shows only whether it is set and its last 4; it is typed
// only when choosing a new one, in a password box, and never kept as a draft); two administrators saving at
// once (each save is compared with what this screen read; theirs shows, what was typed stays).
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'
import {
  type MailBase,
  type MailForm,
  mailProblems,
  mailSave,
  type PasswordChoice,
  passwordAgain,
  secretLabel,
} from '../../lib/admin.ts'
import { ago } from '../../lib/brains.ts'
import { type Me, online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Field } from '../../ui/Field.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { AdminFrame } from './Admin.tsx'
import { adminDrafts, blocked, Conflict, keepDraft, Part, PartBody, Said, useSaid } from './parts.tsx'

const A = T.admin

type Line = { at: string; to: string; kind: string; status: string; error: string | null }
type Mail = {
  configured: boolean
  settings: {
    host: string
    port: number
    secure: boolean
    user: string | null
    hasPassword: boolean
    passwordLast4: string | null
    from: { name: string; address: string }
  } | null
  base: MailBase
  recent: Line[]
  failures: Line[]
}
const mailResource = () => resource<Mail>('admin:mail', () => api.call<Mail>('mail'))

const formOf = (m: Mail): MailForm => ({
  host: m.settings?.host ?? '',
  port: String(m.settings?.port ?? 587),
  secure: m.settings?.secure ?? false,
  user: m.settings?.user ?? '',
  fromName: m.settings?.from.name ?? '',
  fromAddress: m.settings?.from.address ?? '',
})
const TEXT_FIELDS = ['host', 'port', 'user', 'fromName', 'fromAddress'] as const

function Server({ account }: { account: string }) {
  const r = mailResource()
  useFresh(r)
  const [read, setRead] = useState<Mail | null>(null)
  const was = useRef<Mail | null>(null)
  const [f, setF] = useState<MailForm | null>(null)
  const [pw, setPw] = useState<PasswordChoice>({ mode: 'keep', value: '' })
  const [problems, setProblems] = useState<Partial<Record<string, string>>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [theirs, setTheirs] = useState<Mail | null>(null)
  const [asking, setAsking] = useState(false)
  const [removeError, setRemoveError] = useState<ApiError | null>(null)
  const said = useSaid()
  useEffect(() => {
    if (r.data.value && !read && !r.loading.value) setRead(r.data.value)
  }, [r.data.value, r.loading.value])
  useEffect(() => {
    if (!read) return
    const now = formOf(read)
    if (f === null) {
      const kept = (k: (typeof TEXT_FIELDS)[number]) => adminDrafts.get(account, `mail.${k}`)
      setF({
        ...now,
        host: kept('host') ?? now.host,
        port: kept('port') ?? now.port,
        user: kept('user') ?? now.user,
        fromName: kept('fromName') ?? now.fromName,
        fromAddress: kept('fromAddress') ?? now.fromAddress,
        secure:
          adminDrafts.get(account, 'mail.secure') === undefined
            ? now.secure
            : adminDrafts.get(account, 'mail.secure') === 'true',
      })
      return
    }
    // A field still showing what was read before follows what is there now; what was typed stays.
    const before = was.current
    if (!before || before === read) return
    const old = formOf(before)
    setF((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      for (const k of TEXT_FIELDS) if (prev[k] === old[k]) next[k] = now[k]
      if (prev.secure === old.secure) next.secure = now.secure
      return next
    })
  }, [read])
  const set = (k: keyof MailForm, v: string | boolean) => {
    if (!f || !read) return
    setF({ ...f, [k]: v })
    keepDraft(account, `mail.${k}`, String(v), String(formOf(read)[k]))
    said.say(null)
    if (problems[k]) setProblems({ ...problems, [k]: undefined })
  }
  const adopt = (m: Mail) => {
    r.data.value = m
    was.current = read
    setRead(m)
  }
  const pwSet = read?.base.hasPassword ?? false
  return (
    <Part id="mail" title={A.mailServer} lead={A.mailLead} start>
      <PartBody r={r} rows={4} ready={read !== null && f !== null}>
        {read && f ? (
          <form
            class="settings-form"
            noValidate
            onSubmit={async (e) => {
              e.preventDefault()
              if (pending || !online.value) return
              const p = mailProblems(f)
              if (pw.mode === 'replace' && !pw.value) p.password = A.newPasswordHint
              if (passwordAgain(read.base, f, pw)) p.passwordAgain = A.passwordAgain
              setProblems(p)
              const first = ['host', 'port', 'fromAddress', 'password', 'passwordAgain'].find((k) => p[k])
              if (first) {
                const to =
                  first === 'password'
                    ? 'mail-new-password'
                    : first === 'passwordAgain'
                      ? 'mail-pw-new'
                      : `mail-${first}`
                document.getElementById(to)?.focus()
                return
              }
              setPending(true)
              setError(null)
              said.say(null)
              try {
                const fresh = await api.call<Mail & { unchanged?: boolean }>('saveMail', {
                  body: mailSave(read.base, f, pw),
                })
                adopt(fresh)
                setTheirs(null)
                setPw({ mode: 'keep', value: '' })
                for (const k of [...TEXT_FIELDS, 'secure']) adminDrafts.clear(account, `mail.${k}`)
                invalidate('branding')
                said.say(fresh.unchanged ? A.nothing : A.mailSaved, true)
              } catch (x) {
                const a = x as ApiError
                if (a.code === 'settings_changed' && a.current && typeof a.current === 'object') {
                  adopt(a.current as Mail)
                  setTheirs(a.current as Mail)
                } else setError(a)
              } finally {
                setPending(false)
              }
            }}
          >
            {!read.configured ? <p class="note">{A.mailOff}</p> : null}
            <FormAlert error={error} />
            {theirs ? (
              <Conflict>
                <ul class="theirs-values">
                  <li>
                    {A.host}: <strong>{theirs.settings?.host ?? '—'}</strong>
                  </li>
                  <li>
                    {A.port}: <strong>{theirs.settings?.port ?? '—'}</strong>
                  </li>
                  <li>
                    {A.password}: <strong>{secretLabel(theirs.base.hasPassword)}</strong>
                  </li>
                  <li>
                    {A.fromAddress}: <strong>{theirs.settings?.from.address ?? '—'}</strong>
                  </li>
                </ul>
              </Conflict>
            ) : null}
            <Field
              id="mail-host"
              label={A.host}
              hint={A.hostHint}
              autoComplete="off"
              spellcheck={false}
              value={f.host}
              problem={problems.host ?? null}
              onValue={(v) => set('host', v)}
            />
            <Field
              id="mail-port"
              label={A.port}
              hint={A.portHint}
              inputMode="numeric"
              value={f.port}
              problem={problems.port ?? null}
              onValue={(v) => set('port', v)}
            />
            <div class="pick">
              <input
                type="checkbox"
                id="mail-secure"
                checked={f.secure}
                onChange={(e) => set('secure', e.currentTarget.checked)}
              />
              <label for="mail-secure">{A.secure}</label>
            </div>
            <Field
              id="mail-user"
              label={A.user}
              hint={A.userHint}
              autoComplete="off"
              spellcheck={false}
              value={f.user}
              onValue={(v) => set('user', v)}
            />
            <fieldset class="choices">
              <legend>{A.password}</legend>
              {problems.passwordAgain ? (
                <p class="problem" id="mail-pw-again" role="alert">
                  {problems.passwordAgain}
                </p>
              ) : null}
              <div class="pick">
                <input
                  type="radio"
                  name="mail-pw"
                  id="mail-pw-keep"
                  checked={pw.mode === 'keep'}
                  onChange={() => setPw({ mode: 'keep', value: '' })}
                />
                <label for="mail-pw-keep">{pwSet ? A.keepPassword : A.noPassword}</label>
              </div>
              <div class="pick">
                <input
                  type="radio"
                  name="mail-pw"
                  id="mail-pw-new"
                  checked={pw.mode === 'replace'}
                  onChange={() => {
                    setPw({ mode: 'replace', value: '' })
                    setProblems({ ...problems, passwordAgain: undefined })
                  }}
                />
                <label for="mail-pw-new">{A.newPassword}</label>
              </div>
              {pwSet ? (
                <div class="pick">
                  <input
                    type="radio"
                    name="mail-pw"
                    id="mail-pw-remove"
                    checked={pw.mode === 'remove'}
                    onChange={() => {
                      setPw({ mode: 'remove', value: '' })
                      setProblems({ ...problems, passwordAgain: undefined })
                    }}
                  />
                  <label for="mail-pw-remove">{A.removePassword}</label>
                </div>
              ) : null}
              {pw.mode === 'replace' ? (
                <Field
                  id="mail-new-password"
                  label={A.newPasswordLabel}
                  hint={A.newPasswordHint}
                  type="password"
                  autoComplete="new-password"
                  value={pw.value}
                  problem={problems.password ?? null}
                  onValue={(v) => {
                    setPw({ mode: 'replace', value: v })
                    if (problems.password) setProblems({ ...problems, password: undefined })
                  }}
                />
              ) : null}
            </fieldset>
            <Field
              id="mail-fromName"
              label={A.fromName}
              hint={A.fromNameHint}
              value={f.fromName}
              onValue={(v) => set('fromName', v)}
            />
            <Field
              id="mail-fromAddress"
              label={A.fromAddress}
              type="email"
              autoComplete="off"
              value={f.fromAddress}
              problem={problems.fromAddress ?? null}
              onValue={(v) => set('fromAddress', v)}
            />
            <Said text={said.said} id="mail-said" focus={said.focus} />
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={A.saving}
                blocked={blocked()}
              >
                {A.saveMail}
              </Button>
              {read.configured ? (
                <Button kind="quiet" blocked={blocked()} onClick={() => setAsking(true)}>
                  {A.removeMail}
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </PartBody>
      <Dialog open={asking} title={A.removeMailTitle} onClose={() => setAsking(false)}>
        <p>{A.removeMailLead}</p>
        <FormAlert error={removeError} />
        <div class="actions">
          <Button
            kind="primary"
            pending={pending}
            pendingLabel={T.states.pending}
            blocked={blocked()}
            onClick={async () => {
              setPending(true)
              setRemoveError(null)
              try {
                const now = await api.call<Mail>('removeMail')
                setAsking(false)
                adopt(now)
                setF(formOf(now))
                setPw({ mode: 'keep', value: '' })
                for (const k of [...TEXT_FIELDS, 'secure']) adminDrafts.clear(account, `mail.${k}`)
                invalidate('branding')
                said.say(A.mailRemoved, true)
              } catch (x) {
                setRemoveError(x as ApiError)
              } finally {
                setPending(false)
              }
            }}
          >
            {A.removeMail}
          </Button>
          <Button kind="quiet" onClick={() => setAsking(false)}>
            {A.keepMail}
          </Button>
        </div>
      </Dialog>
    </Part>
  )
}

function TestMail({ who }: { who: Me }) {
  const r = mailResource()
  const [to, setTo] = useState(who.account.email ?? '')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ message: string; howToProceed: string } | null>(null)
  const said = useSaid()
  const configured = r.data.value?.configured ?? false
  return (
    <Part id="test" title={A.testTitle}>
      {/* Failed to load: the settings above say so and offer to try again; nothing waits here forever. */}
      {!r.data.value ? (
        r.error.value ? null : (
          <Skeleton rows={1} />
        )
      ) : (
        <form
          class="settings-form"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault()
            if (pending || !configured || !online.value) return
            setPending(true)
            setFailed(null)
            said.say(null)
            try {
              const out = await api.call<{ sent: boolean; error: string | null }>('testMail', {
                body: to.trim() ? { to: to.trim() } : {},
              })
              if (out.sent) said.say(A.testSent(to.trim() || (who.account.email ?? '')), true)
              else
                setFailed({
                  message: out.error ? A.testFailedWhy(out.error) : A.testFailed,
                  howToProceed: A.mailLead,
                })
              await r.reload()
            } catch (x) {
              setFailed(x as ApiError)
            } finally {
              setPending(false)
            }
          }}
        >
          <FormAlert error={failed} />
          <Field
            id="mail-test-to"
            label={A.testTo}
            hint={A.testUsesSaved}
            type="email"
            value={to}
            onValue={setTo}
          />
          <Said text={said.said} id="test-said" focus={said.focus} />
          <div class="actions">
            <Button
              type="submit"
              pending={pending}
              pendingLabel={A.testSending}
              blocked={!configured ? A.testNeeds : blocked()}
            >
              {A.testSend}
            </Button>
          </div>
        </form>
      )}
    </Part>
  )
}

function Failures() {
  const r = mailResource()
  const m = r.data.value
  return (
    <Part id="failures" title={A.failures} lead={A.failuresLead}>
      {!m ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : m.failures.every((l) => l.status === 'skipped') ? (
        <p class="meta" data-state="empty">
          {A.noFailures}
        </p>
      ) : (
        <ul class="list compact">
          {m.failures
            .filter((l) => l.status !== 'skipped')
            .map((l, i) => (
              <li key={`${l.at}-${i}`}>
                <p class="list-title">
                  {A.failureLine(A.mailKinds[l.kind] ?? l.kind, l.to, ago(l.at) ?? T.date(l.at))}
                </p>
                <p class="meta">{l.error ?? A.testFailed}</p>
              </li>
            ))}
        </ul>
      )}
      {/* Mail that never left because mail was not set up is not a failure of the mail server: said apart. */}
      {m?.failures.some((l) => l.status === 'skipped') ? (
        <p class="meta">{A.skippedCount(m.failures.filter((l) => l.status === 'skipped').length)}</p>
      ) : null}
    </Part>
  )
}

export function AdminEmail() {
  return (
    <AdminFrame>
      {(who) => (
        <div class="settings-parts">
          <Server account={who.account.id} />
          <TestMail who={who} />
          <Failures />
        </div>
      )}
    </AdminFrame>
  )
}
