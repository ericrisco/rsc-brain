// The installation as a whole (spec B6 «Admin»: Limits, Backups & system, Branding; plan G3, G4, G14; PR25b).
// Who: the administration. Jobs: set how many requests each key may make; see that the service is healthy
// and which version runs; say where RSC Factory is, so a run's sessions link to it (CA9); name the
// installation and give it a logo (CA18). Done when: each save says so in words, and the header shows the
// new name and logo at once. Risks: a limit so low the web itself stops (bounded, said beside the field);
// a logo that is a script in disguise (SVG refused here and on the server; the server serves it inert);
// B7 promised as if it were here (said plainly, without buttons that do nothing).
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { resource } from '../../api/resource.ts'
import { factoryProblem, logoProblem, progressLabel, rateProblem } from '../../lib/admin.ts'
import { ago } from '../../lib/brains.ts'
import { branding, me } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Field } from '../../ui/Field.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { AdminFrame } from './Admin.tsx'
import {
  adminDrafts,
  blocked,
  Conflict,
  keepDraft,
  Part,
  PartBody,
  Said,
  useInstallPart,
  useSaid,
} from './parts.tsx'

const A = T.admin
const PROVIDER_LABELS: Record<string, string> = { openai: 'OpenAI', ollama: 'Ollama' }

function Limits({ account }: { account: string }) {
  const { r, base, pending, error, said, theirs, save, follow } = useInstallPart()
  const [v, setV] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Lowering the limit slows every key at once: asked first.
  const [lowering, setLowering] = useState<number | null>(null)
  const commit = (n: number) =>
    void save({ rateLimit: n }).then((done) => {
      if (done) adminDrafts.clear(account, 'rateLimit')
    })
  useEffect(() => {
    if (base && v === null) setV(adminDrafts.get(account, 'rateLimit') ?? String(base.rateLimit))
    else
      follow(
        (x) => String(x.rateLimit),
        (f) => setV((prev) => (prev === null ? prev : f(prev))),
      )
  }, [base])
  return (
    <Part id="limits" title={A.limitsTitle} lead={A.limitsLead} start>
      <PartBody r={r} rows={2} ready={base !== null && v !== null}>
        {base && v !== null ? (
          <form
            class="settings-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              const p = rateProblem(v, base.rateLimitMin, base.rateLimitMax)
              setProblem(p)
              if (p) {
                document.getElementById('rate-limit')?.focus()
                return
              }
              const n = Number(v)
              if (n < base.rateLimit) setLowering(n)
              else commit(n)
            }}
          >
            <FormAlert error={error} />
            {theirs ? (
              <Conflict>
                <p>
                  {A.rateLabel}: <strong>{theirs.rateLimit.toLocaleString('en')}</strong>
                </p>
              </Conflict>
            ) : null}
            <Field
              id="rate-limit"
              label={A.rateLabel}
              hint={A.rateHint(base.rateLimitDefault, base.rateLimitMin, base.rateLimitMax)}
              inputMode="numeric"
              value={v}
              problem={problem}
              onValue={(x) => {
                setV(x)
                keepDraft(account, 'rateLimit', x, String(base.rateLimit))
                said.say(null)
                if (problem) setProblem(null)
              }}
            />
            <Said text={said.said} id="limits-said" focus={said.focus} />
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={A.saving}
                blocked={blocked()}
              >
                {A.saveLimit}
              </Button>
              <Button
                kind="quiet"
                onClick={() => {
                  const d = String(base.rateLimitDefault)
                  setV(d)
                  keepDraft(account, 'rateLimit', d, String(base.rateLimit))
                  document.getElementById('rate-limit')?.focus()
                }}
              >
                {A.defaultLimit}
              </Button>
            </div>
          </form>
        ) : null}
      </PartBody>
      <Dialog open={lowering !== null} title={A.lowerTitle} onClose={() => setLowering(null)}>
        {base && lowering !== null ? <p>{A.lowerLead(base.rateLimit, lowering)}</p> : null}
        <div class="actions">
          <Button
            kind="primary"
            blocked={blocked()}
            onClick={() => {
              const n = lowering
              setLowering(null)
              if (n !== null) commit(n)
            }}
          >
            {A.lower}
          </Button>
          <Button kind="quiet" onClick={() => setLowering(null)}>
            {A.keepLimit}
          </Button>
        </div>
      </Dialog>
    </Part>
  )
}

export function AdminLimits() {
  return <AdminFrame>{(who) => <Limits account={who.account.id} />}</AdminFrame>
}

type System = {
  version: string
  startedAt: string
  database: { ok: boolean; migration: string | null }
  meaning: { enabled: boolean; provider: string | null; progress: { done: number; total: number } | null }
  streams: { open: number; max: number }
  mail: { configured: boolean; lastFailureAt: string | null }
}
const systemResource = () => resource<System>('admin:system', () => api.call<System>('system'))

function Service() {
  const r = systemResource()
  useFresh(r)
  const s = r.data.value
  return (
    <Part id="service" title={A.service} start>
      {!s ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : (
        <>
          <dl class="facts">
            <dt>{A.version}</dt>
            <dd class="mono">{s.version}</dd>
            <dt>{A.running}</dt>
            <dd>{T.date(s.startedAt)}</dd>
            <dt>{A.database}</dt>
            <dd>{A.dbOk(s.database.migration)}</dd>
            <dt>{A.streams}</dt>
            <dd>{A.streamsOpen(s.streams.open, s.streams.max)}</dd>
            <dt>{A.meaningState}</dt>
            <dd>
              {s.meaning.enabled
                ? `${A.meaningOn(PROVIDER_LABELS[s.meaning.provider ?? ''] ?? s.meaning.provider ?? '', null)} ${s.meaning.progress ? progressLabel(s.meaning.progress) : ''}`
                : A.meaningOff}
            </dd>
            <dt>{A.email}</dt>
            <dd>{A.mailState(s.mail.configured, s.mail.lastFailureAt ? ago(s.mail.lastFailureAt) : null)}</dd>
          </dl>
          <div class="actions">
            <Button
              kind="quiet"
              pending={r.loading.value}
              pendingLabel={T.states.pending}
              onClick={() => void r.reload()}
            >
              {A.refresh}
            </Button>
          </div>
        </>
      )}
    </Part>
  )
}

function Factory({ account }: { account: string }) {
  const { r, base, pending, error, said, theirs, save, follow } = useInstallPart()
  const [v, setV] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (base && v === null) setV(adminDrafts.get(account, 'factoryUrl') ?? base.factoryUrl ?? '')
    else
      follow(
        (x) => x.factoryUrl ?? '',
        (f) => setV((prev) => (prev === null ? prev : f(prev))),
      )
  }, [base])
  return (
    <Part id="factory" title={A.factory} lead={A.factoryLead}>
      <PartBody r={r} rows={2} ready={base !== null && v !== null}>
        {base && v !== null ? (
          <form
            class="settings-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              const p = factoryProblem(v)
              setProblem(p)
              if (p) {
                document.getElementById('factory-url')?.focus()
                return
              }
              void save({ factoryUrl: v }).then((done) => {
                if (done) adminDrafts.clear(account, 'factoryUrl')
              })
            }}
          >
            <FormAlert error={error} />
            {theirs ? (
              <Conflict>
                <p>
                  {A.factoryLabel}: <strong>{theirs.factoryUrl ?? '—'}</strong>
                </p>
              </Conflict>
            ) : null}
            <Field
              id="factory-url"
              label={A.factoryLabel}
              hint={A.factoryHint}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellcheck={false}
              value={v}
              problem={problem}
              onValue={(x) => {
                setV(x)
                keepDraft(account, 'factoryUrl', x, base.factoryUrl ?? '')
                said.say(null)
                if (problem) setProblem(null)
              }}
            />
            <Said text={said.said} id="factory-said" focus={said.focus} />
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={A.saving}
                blocked={blocked()}
              >
                {A.saveFactory}
              </Button>
            </div>
          </form>
        ) : null}
      </PartBody>
    </Part>
  )
}

export function AdminSystem() {
  return (
    <AdminFrame>
      {(who) => (
        <div class="settings-parts">
          <Service />
          <Factory account={who.account.id} />
          <Part id="backups" title={A.backups}>
            <p>{A.backupsLead}</p>
          </Part>
        </div>
      )}
    </AdminFrame>
  )
}

function Name({ account }: { account: string }) {
  const { r, base, pending, error, said, theirs, save, follow } = useInstallPart()
  const [v, setV] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (base && v === null) setV(adminDrafts.get(account, 'name') ?? base.name)
    else
      follow(
        (x) => x.name,
        (f) => setV((prev) => (prev === null ? prev : f(prev))),
      )
  }, [base])
  return (
    <Part id="name" title={A.nameTitle} lead={A.nameLead} start>
      <PartBody r={r} rows={2} ready={base !== null && v !== null}>
        {base && v !== null ? (
          <form
            class="settings-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              const n = v.trim()
              const p = !n || n.length > 80 ? A.needName_ : null
              setProblem(p)
              if (p) {
                document.getElementById('install-name')?.focus()
                return
              }
              void save({ name: v }).then((done) => {
                // Saved or not (another administrator's name came back), the header shows the name there is now.
                void branding().reload()
                if (!done) return
                adminDrafts.clear(account, 'name')
                void me().reload()
              })
            }}
          >
            <FormAlert error={error} />
            {theirs ? (
              <Conflict>
                <p>
                  {A.nameLabel}: <strong>{theirs.name}</strong>
                </p>
              </Conflict>
            ) : null}
            <Field
              id="install-name"
              label={A.nameLabel}
              hint={A.nameHint_}
              maxLength={80}
              value={v}
              problem={problem}
              onValue={(x) => {
                setV(x)
                keepDraft(account, 'name', x, base.name)
                said.say(null)
                if (problem) setProblem(null)
              }}
            />
            <Said text={said.said} id="name-said" focus={said.focus} />
            <div class="actions">
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel={A.saving}
                blocked={blocked()}
              >
                {A.saveName}
              </Button>
            </div>
          </form>
        ) : null}
      </PartBody>
    </Part>
  )
}

const readAsBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''))
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(f)
  })

function Logo() {
  const b = branding()
  useFresh(b)
  const current = b.data.value?.logo ?? null
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [asking, setAsking] = useState(false)
  const said = useSaid()
  const input = useRef<HTMLInputElement>(null)
  // The chosen image is shown from memory; its address is let go when replaced or left.
  useEffect(() => {
    if (!file) return setPreview(null)
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const clearChoice = () => {
    setFile(null)
    if (input.current) input.current.value = ''
  }
  return (
    <Part id="logo" title={A.logo} lead={A.logoLead}>
      {!b.data.value ? (
        b.error.value ? (
          <ErrorState error={b.error.value} onRetry={() => void b.reload()} focus={false} />
        ) : (
          <Skeleton rows={2} />
        )
      ) : (
        <div class="settings-form">
          <FormAlert error={error} />
          {current ? (
            <p class="logo-current">
              <img src={current.url} alt={A.currentLogo} />
            </p>
          ) : (
            <p class="meta">{A.noLogo}</p>
          )}
          <div class="field">
            <label for="logo-file">{A.chooseLogo}</label>
            <span class="hint" id="logo-file-hint">
              {A.logoFileHint}
            </span>
            <input
              ref={input}
              id="logo-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-describedby={`logo-file-hint${problem ? ' logo-file-problem' : ''}`}
              aria-invalid={problem ? 'true' : undefined}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0] ?? null
                said.say(null)
                setError(null)
                if (!f) return clearChoice()
                const p = logoProblem(f)
                setProblem(p)
                setFile(p ? null : f)
              }}
            />
            {problem ? (
              <span class="problem" id="logo-file-problem">
                {problem}
              </span>
            ) : null}
          </div>
          {file && preview ? (
            <div class="logo-chosen">
              <img src={preview} alt={A.chosenLogo} />
              <div class="actions">
                <Button
                  kind="primary"
                  pending={pending}
                  pendingLabel={A.uploading}
                  blocked={blocked()}
                  onClick={async () => {
                    setPending(true)
                    setError(null)
                    try {
                      await api.call('uploadLogo', {
                        body: { contentType: file.type, data: await readAsBase64(file) },
                      })
                      clearChoice()
                      await b.reload()
                      said.say(A.uploaded, true)
                    } catch (e) {
                      setError(e as ApiError)
                    } finally {
                      setPending(false)
                    }
                  }}
                >
                  {A.upload}
                </Button>
                <Button
                  kind="quiet"
                  onClick={() => {
                    clearChoice()
                    input.current?.focus()
                  }}
                >
                  {T.settings.cancel}
                </Button>
              </div>
            </div>
          ) : null}
          <Said text={said.said} id="logo-said" focus={said.focus} />
          {current ? (
            <div class="actions">
              <Button kind="quiet" blocked={blocked()} onClick={() => setAsking(true)}>
                {A.removeLogo}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <Dialog open={asking} title={A.removeLogoTitle} onClose={() => setAsking(false)}>
        <p>{A.removeLogoLead}</p>
        <FormAlert error={error} />
        <div class="actions">
          <Button
            kind="primary"
            pending={pending}
            pendingLabel={T.states.pending}
            blocked={blocked()}
            onClick={async () => {
              setPending(true)
              setError(null)
              try {
                await api.call('removeLogo')
                setAsking(false)
                await b.reload()
                said.say(A.logoRemoved, true)
              } catch (e) {
                setError(e as ApiError)
              } finally {
                setPending(false)
              }
            }}
          >
            {A.removeLogo}
          </Button>
          <Button kind="quiet" onClick={() => setAsking(false)}>
            {A.keepLogo}
          </Button>
        </div>
      </Dialog>
    </Part>
  )
}

export function AdminBranding() {
  return (
    <AdminFrame>
      {(who) => (
        <div class="settings-parts">
          <Name account={who.account.id} />
          <Logo />
        </div>
      )}
    </AdminFrame>
  )
}
