// Admin › Backups & system: the copies and the installation key (spec B7 «Copias y restauración», plan §3.4, T018).
// Who: the administration. Jobs: see that copies are being made (the last good one, the last failure in words), make
// one by hand, download one, restore one of this list, keep the installation key. Done when: a copy made says so; a
// restore leads everyone, this person too, to sign in again with «Restored. Everyone signs in again». Risks: a
// restore that loses writes without warning (the dialog says the date of the copy and of the last write, and asks the
// name of the installation and the password); a key that leaks (shown only after the password, in this screen's
// memory, gone when hidden or when the page is put away); a failure nobody sees (a band at the top of every page of
// the administration until a good copy).
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api, forgetSession } from '../../api/index.ts'
import { resource } from '../../api/resource.ts'
import { localWhen } from '../../lib/admin.ts'
import {
  bandOf,
  confirmProblem,
  failureText,
  keyFile,
  keyFileName,
  lastUpdateOf,
  lastUpdateText,
  reasonLabel,
  restoreBlocked,
  sizeLabel,
  warningText,
} from '../../lib/backups.ts'
import { ago } from '../../lib/brains.ts'
import { justRestored, me, online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { CopyButton } from '../../ui/CopyButton.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Field } from '../../ui/Field.tsx'
import { PasswordField } from '../../ui/PasswordField.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { blocked, Part, Said, useSaid } from './parts.tsx'

const A = T.admin
type Problems = { confirm?: string | undefined; password?: string | undefined; code?: string | undefined }
// The first copies shown; the rest on asking (40 daily copies are a long list at 320 px).
const FIRST = 10

export type CopyItem = {
  id: string
  createdAt: string
  bytes: number
  reason: string
  keyId: string
  needsOldKey: boolean
}
export type CopiesView = {
  configured: boolean
  items: CopyItem[]
  lastOk: { at: string; file: string } | null
  lastFailure: { at: string; category: string } | null
  lastWarning: { at: string; code: string } | null
  keyId: string | null
  schedule: { at: string; keep: number; timezone: string }
  lastUpdate: unknown
  running: boolean
}
export const backupsResource = () =>
  resource<CopiesView>('admin:backups', () => api.call<CopiesView>('backups'))

// The band at the top of every page of the administration while the last copy failed (until a good one).
export function BackupBand() {
  const r = backupsResource()
  useFresh(r)
  const { path } = useLocation()
  const failed = bandOf(r.data.value)
  if (!failed) return null
  return (
    <div class="alert backup-band" role="alert" data-state="backup-failed">
      <span class="kind">{A.failedTitle}</span>
      <span>{A.band(localWhen(failed.at))}</span>
      <span class="muted">{failureText(failed.category)}</span>
      {path === '/admin/system' ? null : (
        <a href="/admin/system#backups-title" class="band-link">
          {A.bandLink}
        </a>
      )}
    </div>
  )
}

function CopyRow({
  c,
  running,
  onRestore,
}: {
  c: CopyItem
  running: boolean
  onRestore: (c: CopyItem) => void
}) {
  const when = localWhen(c.createdAt)
  const why = restoreBlocked(c, { running, online: online.value })
  return (
    <li class="with-actions copy-row">
      <div>
        <p class="copy-when">
          <strong>{when}</strong> <span class="muted">· {reasonLabel(c.reason)}</span>
        </p>
        <p class="meta">
          {sizeLabel(c.bytes)} · <span class="mono">{A.keyIdOf(c.keyId)}</span>{' '}
          {c.needsOldKey ? <span class="tag warn">{A.needsOldKey}</span> : null}
        </p>
      </div>
      <div class="row-actions">
        <a
          class="button"
          href={`/v1/admin/backups/${encodeURIComponent(c.id)}/download`}
          download
          aria-label={A.downloadName(when)}
        >
          {A.copyDownload}
        </a>
        <Button blocked={why} aria-label={A.restoreName(when)} onClick={() => onRestore(c)}>
          {A.copyRestore}
        </Button>
      </div>
    </li>
  )
}

export function BackupsPart({ freeBytes }: { freeBytes: number | null | undefined }) {
  const r = backupsResource()
  useFresh(r)
  const v = r.data.value
  const said = useSaid()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [waiting, setWaiting] = useState<{ id: string; read: boolean } | null>(null)
  const [all, setAll] = useState(false)
  const [restoring, setRestoring] = useState<CopyItem | null>(null)
  // While a copy is being made, the list is read again every second until it ends.
  useEffect(() => {
    if (!v?.running) return
    const t = setTimeout(() => void r.reload(), 1000)
    return () => clearTimeout(t)
  }, [v])
  // Once it ended: said, with the keyboard there (the button pressed is back to itself). Only what was read after
  // the copy started counts (`read`): the list from before says nothing about it.
  useEffect(() => {
    if (!waiting?.read || !v || v.running) return
    const made = v.items.find((i) => i.id === waiting.id)
    said.say(made ? A.copyMade(localWhen(made.createdAt)) : A.copyFailedNow, true)
    setWaiting(null)
  }, [v, waiting])
  const make = async () => {
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    said.say(null)
    try {
      const { id } = await api.call<{ id: string }>('makeBackup', { body: {} })
      setWaiting({ id, read: false })
      await r.reload()
      setWaiting({ id, read: true })
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  const failed = bandOf(v)
  const update = lastUpdateOf(v?.lastUpdate)
  const items = v?.items ?? []
  const shown = all ? items : items.slice(0, FIRST)
  return (
    <Part id="backups" title={A.backups} lead={A.backupsLead} start>
      {!v ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : !v.configured ? (
        <div class="alert warn" role="note" data-state="backups-off">
          <span class="kind">{T.kind.warning}</span>
          <strong>{A.backupsOff}</strong>
          <span>{A.backupsOffHow}</span>
        </div>
      ) : (
        <>
          {failed ? (
            <div class="alert" role="note" data-state="copy-failed">
              <span class="kind">{A.failedTitle}</span>
              <span>{localWhen(failed.at)}</span>
              <span>{failureText(failed.category)}</span>
            </div>
          ) : null}
          {v.lastWarning ? (
            <div class="alert warn" role="note" data-state="copy-warning">
              <span class="kind">{A.warnTitle}</span>
              <span>{localWhen(v.lastWarning.at)}</span>
              <span>{warningText(v.lastWarning.code)}</span>
            </div>
          ) : null}
          <dl class="facts">
            <dt>{A.lastGood}</dt>
            <dd>{v.lastOk ? `${localWhen(v.lastOk.at)} (${ago(v.lastOk.at) ?? ''})` : A.noCopyYet}</dd>
            <dt>{A.schedule}</dt>
            <dd>{A.scheduleText(v.schedule.at, v.schedule.timezone, v.schedule.keep)}</dd>
            {freeBytes != null ? (
              <>
                <dt>{A.freeSpace}</dt>
                <dd>{sizeLabel(freeBytes)}</dd>
              </>
            ) : null}
            <dt>{A.lastUpdate}</dt>
            <dd data-state="last-update">
              {update ? `${localWhen(update.at)}: ${lastUpdateText(update)}` : A.noUpdateYet}
            </dd>
          </dl>
          {update && !update.ok ? (
            <div class="alert warn" role="note" data-state="update-failed">
              <span class="kind">{A.updateFailedTitle}</span>
              <span>{lastUpdateText(update)}</span>
              {update.log ? (
                <details class="update-log">
                  <summary>{A.updateLog}</summary>
                  <pre>{update.log}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
          <FormAlert error={error} />
          <div class="actions">
            <Button
              kind="primary"
              pending={pending || v.running}
              pendingLabel={A.makingCopy}
              blocked={blocked()}
              onClick={() => void make()}
            >
              {A.makeCopy}
            </Button>
          </div>
          <Said text={said.said} id="backups-said" focus={said.focus} />
          <h3 class="part-title">{A.copies}</h3>
          {items.length === 0 ? (
            <div class="quiet-empty" data-state="empty">
              <p>{A.noCopies}</p>
              <p class="meta">{A.noCopiesHow(v.schedule.at)}</p>
            </div>
          ) : (
            <>
              <p class="meta">
                {A.copiesCount(items.length)}. {A.copyDownloadNote}
              </p>
              <ul class="list compact copies">
                {shown.map((c) => (
                  <CopyRow key={c.id} c={c} running={v.running} onRestore={setRestoring} />
                ))}
              </ul>
              {!all && items.length > FIRST ? (
                <Button kind="quiet" onClick={() => setAll(true)}>
                  {A.showAllCopies(items.length)}
                </Button>
              ) : null}
            </>
          )}
        </>
      )}
      <RestoreDialog copy={restoring} onClose={() => setRestoring(null)} />
    </Part>
  )
}

type Impact = {
  copyAt: string
  copyLastWriteAt: string | null
  lastWriteAt: string | null
  lostWrites: boolean
}

// Restoring one copy of the list: what is lost, the copy made first, everyone signing in again; the name of the
// installation and the password (and the code) before anything happens.
function RestoreDialog({ copy, onClose }: { copy: CopyItem | null; onClose: () => void }) {
  const { route } = useLocation()
  const who = me().data.value
  const name = who?.installation.name ?? ''
  const totp = who?.account.totp === true
  const [impact, setImpact] = useState<Impact | null>(null)
  const [impactError, setImpactError] = useState<ApiError | null>(null)
  const [confirm, setConfirm] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [problems, setProblems] = useState<Problems>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const load = async (c: CopyItem) => {
    setImpact(null)
    setImpactError(null)
    try {
      setImpact(await api.call<Impact>('backupImpact', { path: { id: c.id } }))
    } catch (e) {
      setImpactError(e as ApiError)
    }
  }
  useEffect(() => {
    setConfirm('')
    setPassword('')
    setCode('')
    setProblems({})
    setError(null)
    if (copy) void load(copy)
  }, [copy?.id])
  // Any close of the native dialog ends this one; never while a restore runs (`locked` opens it again).
  const close = () => {
    if (pending) return
    setPassword('')
    setCode('')
    onClose()
  }
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!copy || pending || !online.value) return
    const p: typeof problems = {}
    const c = confirmProblem(confirm, name)
    if (c) p.confirm = c
    if (!password) p.password = A.needPassword
    if (totp && !/^\d{6}$/.test(code.trim())) p.code = A.needCode
    setProblems(p)
    const first = (['confirm', 'password', 'code'] as const).find((k) => p[k])
    if (first) {
      document.getElementById(`restore-${first}`)?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      await api.call('restoreBackup', {
        path: { id: copy.id },
        body: { confirm, password, ...(totp ? { code: code.trim() } : {}) },
        // Quiet: a wrong password is a 401 to show here; and the session that asked ends with the restore, so its
        // answer is the last one, never a «session ended».
        quiet: true,
      })
      setPassword('')
      forgetSession()
      justRestored.value = true
      route('/sign-in', true)
    } catch (err) {
      const a = err as ApiError
      setPassword('')
      if (a.code === 'reauth_failed') {
        const onCode = totp && /code/i.test(a.message)
        setProblems({ [onCode ? 'code' : 'password']: `${a.message} ${a.howToProceed}` })
        document.getElementById(onCode ? 'restore-code' : 'restore-password')?.focus()
      } else if (a.code === 'confirm_mismatch') {
        setProblems({ confirm: `${a.message} ${a.howToProceed}` })
        document.getElementById('restore-confirm')?.focus()
      } else setError(a)
    } finally {
      setPending(false)
    }
  }
  const when = copy ? localWhen(copy.createdAt) : ''
  return (
    <Dialog
      open={copy !== null}
      title={A.restoreTitle(when)}
      onClose={close}
      class="restore-dialog"
      locked={pending}
    >
      {!impact ? (
        impactError ? (
          <ErrorState error={impactError} onRetry={() => copy && void load(copy)} focus={false} />
        ) : (
          <Skeleton rows={2} label={A.impactLoading} />
        )
      ) : (
        <form class="form" noValidate onSubmit={submit}>
          <div class="alert warn" role="note">
            <span class="kind">{T.kind.warning}</span>
            <strong>{A.restoreReplace(localWhen(impact.copyAt))}</strong>
            <span>
              {impact.lostWrites && impact.lastWriteAt
                ? A.restoreLost(localWhen(impact.lastWriteAt), ago(impact.lastWriteAt) ?? '')
                : A.restoreNothingLost}
            </span>
          </div>
          <p>{A.restoreFirst}</p>
          <p>{A.restoreEnds}</p>
          <FormAlert error={error} />
          <Field
            id="restore-confirm"
            label={A.restoreConfirm}
            hint={A.restoreConfirmHint(name)}
            autoComplete="off"
            spellcheck={false}
            value={confirm}
            problem={problems.confirm}
            onValue={(x) => {
              setConfirm(x)
              if (problems.confirm) setProblems({ ...problems, confirm: undefined })
            }}
          />
          <PasswordField
            id="restore-password"
            label={A.yourPassword}
            autocomplete="current-password"
            value={password}
            problem={problems.password}
            onValue={(x) => {
              setPassword(x)
              if (problems.password) setProblems({ ...problems, password: undefined })
            }}
          />
          {totp ? (
            <Field
              id="restore-code"
              label={A.yourCode}
              hint={A.yourCodeHint}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              problem={problems.code}
              onValue={(x) => {
                setCode(x)
                if (problems.code) setProblems({ ...problems, code: undefined })
              }}
            />
          ) : null}
          <div class="actions">
            <Button
              type="submit"
              kind="primary"
              pending={pending}
              pendingLabel={A.restoring}
              blocked={blocked()}
            >
              {A.doRestore}
            </Button>
            <Button kind="quiet" onClick={close} blocked={pending ? A.restoring : null}>
              {A.keepAsIs}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

// The installation key: its id always; the key itself only after the password (and the code), shown in this
// screen's memory until hidden or the page is put away, with a copy and a download.
export function KeyPart({ keyId }: { keyId: string | null | undefined }) {
  const who = me().data.value
  const totp = who?.account.totp === true
  const [asking, setAsking] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [problems, setProblems] = useState<Problems>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const [shown, setShown] = useState<{ key: string; keyId: string } | null>(null)
  const [href, setHref] = useState<string | null>(null)
  const said = useSaid()
  const opener = useRef<HTMLButtonElement>(null)
  // Put in the back/forward cache, or left: the key is forgotten.
  useEffect(() => {
    const away = () => {
      setShown(null)
      setPassword('')
      setAsking(false)
    }
    window.addEventListener('pagehide', away)
    return () => window.removeEventListener('pagehide', away)
  }, [])
  // The download is made from memory; its address is let go with the key.
  useEffect(() => {
    if (!shown) return setHref(null)
    const url = URL.createObjectURL(new Blob([keyFile(shown.key)], { type: 'text/plain' }))
    setHref(url)
    return () => URL.revokeObjectURL(url)
  }, [shown])
  const close = () => {
    const was = shown !== null
    setAsking(false)
    setShown(null)
    setPassword('')
    setCode('')
    setProblems({})
    setError(null)
    if (was) said.say(A.keyHidden, true)
  }
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    const p: typeof problems = {}
    if (!password) p.password = A.needPassword
    if (totp && !/^\d{6}$/.test(code.trim())) p.code = A.needCode
    setProblems(p)
    if (p.password || p.code) {
      document.getElementById(p.password ? 'key-password' : 'key-code')?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      // Quiet: a wrong password is a 401 to show here, not a session that ended.
      const k = await api.call<{ key: string; keyId: string }>('installationKey', {
        body: { password, ...(totp ? { code: code.trim() } : {}) },
        quiet: true,
      })
      setPassword('')
      setCode('')
      setShown(k)
    } catch (err) {
      const a = err as ApiError
      setPassword('')
      if (a.code === 'reauth_failed') {
        const onCode = totp && /code/i.test(a.message)
        setProblems({ [onCode ? 'code' : 'password']: `${a.message} ${a.howToProceed}` })
        document.getElementById(onCode ? 'key-code' : 'key-password')?.focus()
      } else setError(a)
    } finally {
      setPending(false)
    }
  }
  useEffect(() => {
    if (shown) document.getElementById('copy-installation-key')?.focus()
  }, [shown])
  const name = who?.installation.name ?? ''
  return (
    <Part id="installation-key" title={A.keyTitle} lead={A.keyLead}>
      <dl class="facts">
        <dt>{A.keyId}</dt>
        <dd class="mono">{keyId ?? '—'}</dd>
      </dl>
      <p class="meta">{A.keyIdHint}</p>
      <Said text={said.said} id="key-said" focus={said.focus} />
      <div class="actions">
        <button
          ref={opener}
          type="button"
          class="button"
          onClick={() => {
            said.say(null)
            setAsking(true)
          }}
        >
          {A.showKey}
        </button>
      </div>
      <Dialog open={asking} title={shown ? A.keyShown : A.keyTitle} onClose={close}>
        {shown ? (
          <div class="once">
            <p>{A.keyOnceHere}</p>
            <pre class="command">
              <code>{shown.key}</code>
            </pre>
            <p class="meta mono">{A.keyIdOf(shown.keyId)}</p>
            <div class="actions">
              <CopyButton text={shown.key} label={A.copyTheKey} id="copy-installation-key" />
              {href ? (
                <a class="button" href={href} download={keyFileName(name, shown.keyId)}>
                  {A.downloadKey}
                </a>
              ) : null}
              <Button kind="primary" onClick={close}>
                {A.hideTheKey}
              </Button>
            </div>
          </div>
        ) : (
          <form class="form" noValidate onSubmit={submit}>
            <p>{A.keyAsk}</p>
            <FormAlert error={error} />
            <PasswordField
              id="key-password"
              label={A.yourPassword}
              autocomplete="current-password"
              value={password}
              problem={problems.password}
              autoFocus
              onValue={(x) => {
                setPassword(x)
                if (problems.password) setProblems({ ...problems, password: undefined })
              }}
            />
            {totp ? (
              <Field
                id="key-code"
                label={A.yourCode}
                hint={A.yourCodeHint}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                problem={problems.code}
                onValue={(x) => {
                  setCode(x)
                  if (problems.code) setProblems({ ...problems, code: undefined })
                }}
              />
            ) : null}
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={A.revealing}
                blocked={blocked()}
              >
                {A.revealKey}
              </Button>
              <Button kind="quiet" onClick={close}>
                {T.settings.cancel}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Part>
  )
}
