// Updating rsc-brain from its own web (rsc-updates B3; spec CA27, CA28). Who: the administration. Jobs: see that a newer
// version exists, ask for it with the password again (and the code, with a second factor), follow how it goes, try again
// after a failure. In an installation made by rsc-factory there is no button: it points there. Done when: the result is
// said in words ("Updated from X to Y."). Risks: an update that goes wrong (it goes back by itself and says so); a
// stolen session (the password is asked again); a request someone else made first (said, not hidden).
// The server decides everything; this only offers what it allows, and sends the password (and the code) and nothing else.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { api } from '../../api/index.ts'
import { localWhen } from '../../lib/admin.ts'
import type { UpdateView } from '../../lib/updates.ts'
import { me, online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Field } from '../../ui/Field.tsx'
import { PasswordField } from '../../ui/PasswordField.tsx'
import { FormAlert } from '../../ui/states.tsx'
import { blocked, Said, useSaid } from './parts.tsx'

const A = T.admin
type Problems = { password?: string | undefined; code?: string | undefined }
// How often the page asks while an update is requested or running, and how long it waits for the updater to take a
// request before it stops following (the updater looks every 5 seconds).
const FOLLOW_MS = 3000
const GIVE_UP_MS = 90_000

function Ask({
  retry,
  to,
  onClose,
  onAsked,
  onRefused,
}: {
  retry: boolean
  to: string
  onClose: () => void
  onAsked: () => void
  onRefused: () => void
}) {
  const totp = me().data.value?.account.totp === true
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [problems, setProblems] = useState<Problems>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const label = retry ? A.updateTryAgain : A.updateTo(to)
  const close = () => {
    setPassword('')
    setCode('')
    setProblems({})
    setError(null)
    onClose()
  }
  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    const p: Problems = {}
    if (!password) p.password = A.needPassword
    if (totp && !/^\d{6}$/.test(code.trim())) p.code = A.needCode
    setProblems(p)
    if (p.password || p.code) {
      document.getElementById(p.password ? 'update-password' : 'update-code')?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      // Quiet: a wrong password is a 401 to show here, not a session that ended. Only these two are sent.
      await api.call(retry ? 'retryUpdate' : 'requestUpdate', {
        body: { password, ...(totp ? { code: code.trim() } : {}) },
        quiet: true,
      })
      close()
      onAsked()
    } catch (err) {
      const a = err as ApiError
      setPassword('')
      if (a.code === 'reauth_failed') {
        const onCode = totp && /code/i.test(a.message)
        setProblems({ [onCode ? 'code' : 'password']: `${a.message} ${a.howToProceed}` })
        document.getElementById(onCode ? 'update-code' : 'update-password')?.focus()
      } else {
        setError(a)
        // Someone asked first, or the state moved: the page asks again what is true now.
        onRefused()
      }
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open title={label} onClose={close}>
      <form class="form" noValidate onSubmit={submit}>
        <p>{A.updateLead}</p>
        <p>{A.updateAskPassword}</p>
        <FormAlert error={error} />
        <PasswordField
          id="update-password"
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
            id="update-code"
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
            pendingLabel={A.updateSending}
            blocked={blocked()}
          >
            {label}
          </Button>
          <Button kind="quiet" onClick={close}>
            {T.settings.cancel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// What goes under the line that says which version runs: the button, the progress, the failure, or the way to
// rsc-factory. `reload` asks the system again; the part follows an update until it ends.
export function UpdatePart({ view, reload }: { view: UpdateView; reload: () => void }) {
  const said = useSaid()
  const [asking, setAsking] = useState<{ retry: boolean; to: string } | null>(null)
  // Asked from here, and the page keeps checking until the updater has been seen to take it and finish.
  const [following, setFollowing] = useState(false)
  const seen = useRef(false)
  const live = view.kind === 'waiting' || view.kind === 'running'
  useEffect(() => {
    if (live) seen.current = true
    else if (seen.current) {
      seen.current = false
      setFollowing(false)
    }
  }, [view.kind])
  useEffect(() => {
    if (!live && !following) return
    const tick = setInterval(reload, FOLLOW_MS)
    // A request nobody took (the updater went away): stop asking.
    const stop = following && !live ? setTimeout(() => setFollowing(false), GIVE_UP_MS) : undefined
    return () => {
      clearInterval(tick)
      if (stop) clearTimeout(stop)
    }
  }, [live, following])
  const asked = () => {
    said.say(A.updateRequested, true)
    setFollowing(true)
    reload()
  }
  return (
    <div class="update" data-update={view.kind}>
      <Said text={said.said} id="update-said" focus={said.focus} />
      {view.kind === 'companion' ? (
        <>
          <p>
            <strong>{A.updateCompanion}</strong>
          </p>
          {view.factoryUrl ? (
            <p>
              <a href={view.factoryUrl} rel="noopener">
                {A.updateOpenFactory}
              </a>
            </p>
          ) : null}
        </>
      ) : null}
      {view.kind === 'waiting' ? <p>{A.updateWaiting}</p> : null}
      {view.kind === 'running' ? <p>{A.updateRunning(view.to)}</p> : null}
      {view.kind === 'available' && view.refused ? (
        <>
          <p role="alert">
            <strong>{A.updateCannot(view.refused.reason.replace(/^Cannot update:\s*/, ''))}</strong>
          </p>
          <p class="meta">
            {A.updateCannotHow} <code>rsc-brain.sh update</code>
          </p>
        </>
      ) : null}
      {view.kind === 'available' ? (
        <div class="actions">
          <Button kind="primary" blocked={blocked()} onClick={() => setAsking({ retry: false, to: view.to })}>
            {A.updateTo(view.to)}
          </Button>
        </div>
      ) : null}
      {view.kind === 'failed' ? (
        <>
          <p>
            <strong>{A.updateFailedAt(view.to, localWhen(view.failedAt))}</strong>
          </p>
          {view.reason ? (
            <details>
              <summary>{A.updateReason}</summary>
              <pre class="notes">{view.reason}</pre>
            </details>
          ) : null}
          {view.retry === 'now' ? (
            <div class="actions">
              <Button
                kind="primary"
                blocked={blocked()}
                onClick={() => setAsking({ retry: true, to: view.to })}
              >
                {A.updateTryAgain}
              </Button>
            </div>
          ) : view.retry === 'server' ? (
            <>
              <p class="meta">{A.updateServerOnly}</p>
              <p class="meta">
                <code>rsc-brain.sh update</code>
              </p>
            </>
          ) : (
            <p class="meta">{A.updateRetryFrom(localWhen(view.retry.from))}</p>
          )}
        </>
      ) : null}
      {asking ? (
        <Ask
          retry={asking.retry}
          to={asking.to}
          onClose={() => setAsking(null)}
          onAsked={() => {
            setAsking(null)
            asked()
          }}
          onRefused={reload}
        />
      ) : null}
    </div>
  )
}
