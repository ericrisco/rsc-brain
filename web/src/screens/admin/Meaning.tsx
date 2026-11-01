// Meaning search (spec B6 «Admin › Meaning search», spec B3 «Búsqueda por significado»; PR25b). Who: the
// administration. Jobs: give a provider its key (or a local one its address); turn meaning search on, having
// read and accepted that text leaves the installation; follow the processing; turn it off. Done when: it
// says it is on with which provider, and how far processing got, in words. Risks: a key leaking (typed in a
// password box, never shown again, never kept as a draft: only its last 4 come back); turning it on without
// meaning to (the warning must be accepted, by the person, in the same step); turning it off by a slip (asked
// first).
import { useEffect, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { resource } from '../../api/resource.ts'
import { progressLabel } from '../../lib/admin.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { Field } from '../../ui/Field.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { AdminFrame } from './Admin.tsx'
import { blocked, Part, Said, useSaid } from './parts.tsx'

const A = T.admin

type Provider = {
  name: string
  label: string
  needs: 'key' | 'url'
  source: 'settings' | 'environment' | null
  last4: string | null
  url: string | null
  urlHidden: boolean
  unreadable: boolean
  model: string | null
}
type Meaning = {
  enabled: boolean
  provider: string | null
  model: string | null
  acceptedAt: string | null
  available: string[]
  providers: Provider[]
  offReason: string | null
  warning: string
  progress: { done: number; total: number } | null
}
const meaningResource = () => resource<Meaning>('admin:meaning', () => api.call<Meaning>('meaning'))

const labelOf = (m: Meaning, name: string | null) =>
  m.providers.find((p) => p.name === name)?.label ?? name ?? ''

function Status({ m, onSaid }: { m: Meaning; onSaid: (t: string) => void }) {
  const r = meaningResource()
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const p = m.progress
  const busy = m.enabled && p !== null && p.done < p.total
  // While texts are being processed, look again every few seconds (never while the page is hidden).
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      if (!document.hidden) void r.reload()
    }, 3000)
    return () => clearInterval(t)
  }, [busy])
  return (
    <>
      <p class="list-title">{m.enabled ? A.meaningOn(labelOf(m, m.provider), m.model) : A.meaningOff}</p>
      {m.enabled && m.acceptedAt ? <p class="meta">{A.meaningAccepted(T.date(m.acceptedAt))}</p> : null}
      {!m.enabled && m.offReason ? <p class="note">{m.offReason}</p> : null}
      {m.enabled && p ? (
        <div class="progress-block">
          <progress
            id="meaning-progress"
            aria-label={A.processing}
            max={Math.max(1, p.total)}
            value={p.done}
            aria-valuetext={progressLabel(p)}
          />
          <p class="meta" aria-live="polite">
            {progressLabel(p)}
          </p>
        </div>
      ) : null}
      {m.enabled ? (
        <div class="actions">
          <Button kind="quiet" blocked={blocked()} onClick={() => setAsking(true)}>
            {A.turnOff}
          </Button>
        </div>
      ) : null}
      <Dialog open={asking} title={A.turnOffTitle} onClose={() => setAsking(false)}>
        <p>{A.turnOffLead}</p>
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
                r.data.value = await api.call<Meaning>('meaningOff')
                setAsking(false)
                onSaid(A.isOff)
              } catch (e) {
                setError(e as ApiError)
              } finally {
                setPending(false)
              }
            }}
          >
            {A.turnOff}
          </Button>
          <Button kind="quiet" onClick={() => setAsking(false)}>
            {A.keepOn}
          </Button>
        </div>
      </Dialog>
    </>
  )
}

function ProviderPart({ p, onSaid }: { p: Provider; onSaid: (t: string) => void }) {
  const r = meaningResource()
  // The key is in this box only while typed: never a draft, gone once saved or when the tab changes.
  const [v, setV] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<ApiError | null>(null)
  const key = p.needs === 'key'
  const id = `provider-${p.name}`
  const set = p.source === 'settings'
  return (
    <section class="provider" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} class="part-title">
        {p.label}
      </h3>
      <p class="meta">
        {key
          ? p.unreadable
            ? `${A.keyIs(A.unreadable)}${p.model ? ` ${A.envUsed}` : ''}`
            : A.keyIs(A.keyFrom(p.source, p.last4))
          : `${A.addressLine(p.source, p.url)}${p.urlHidden ? A.pathHidden : ''}`}
      </p>
      <form
        class="settings-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault()
          if (pending || !online.value) return
          const t = v.trim()
          const bad = key ? t.length < 20 || /\s/.test(t) : !/^https?:\/\/\S+$/.test(t)
          if (bad) {
            setProblem(key ? A.needKey : A.needAddress)
            document.getElementById(`${id}-value`)?.focus()
            return
          }
          setPending(true)
          setError(null)
          try {
            const was = r.data.value
            const now = await api.call<Meaning>('setProvider', {
              path: { name: p.name },
              body: key ? { key: t } : { url: t },
            })
            r.data.value = now
            setV('')
            // The provider in use changed: the server turned meaning search off until the warning is accepted again.
            const off = was?.enabled && was.provider === p.name && !now.enabled
            onSaid(off ? A.offAfterChange(p.label) : key ? A.keySaved(p.label) : A.addressSaved(p.label))
          } catch (x) {
            setError(x as ApiError)
          } finally {
            setPending(false)
          }
        }}
      >
        <FormAlert error={error} />
        <Field
          id={`${id}-value`}
          label={key ? A.apiKey(p.label) : A.address(p.label)}
          hint={key ? A.apiKeyHint : A.addressHint}
          type={key ? 'password' : 'url'}
          autoComplete={key ? 'new-password' : 'off'}
          spellcheck={false}
          value={v}
          problem={problem}
          onValue={(x) => {
            setV(x)
            if (problem) setProblem(null)
          }}
        />
        <div class="actions">
          <Button type="submit" pending={pending} pendingLabel={A.saving} blocked={blocked()}>
            {key ? A.saveKey : A.saveAddress}
          </Button>
          {set ? (
            <Button
              kind="quiet"
              blocked={blocked()}
              onClick={() => {
                setAskError(null)
                setAsking(true)
              }}
            >
              {key ? A.removeKey : A.removeAddress}
            </Button>
          ) : null}
        </div>
      </form>
      <Dialog
        open={asking}
        title={key ? A.removeKeyTitle(p.label) : A.removeAddressTitle(p.label)}
        onClose={() => setAsking(false)}
      >
        <p>{A.removeKeyLead}</p>
        <FormAlert error={askError} />
        <div class="actions">
          <Button
            kind="primary"
            pending={pending}
            pendingLabel={T.states.pending}
            blocked={blocked()}
            onClick={async () => {
              setPending(true)
              setAskError(null)
              try {
                const was = r.data.value
                const now = await api.call<Meaning>('removeProvider', { path: { name: p.name } })
                r.data.value = now
                setAsking(false)
                const off = was?.enabled && was.provider === p.name && !now.enabled
                onSaid(
                  off ? A.offAfterChange(p.label) : key ? A.keyRemoved(p.label) : A.addressRemoved(p.label),
                )
              } catch (x) {
                setAskError(x as ApiError)
              } finally {
                setPending(false)
              }
            }}
          >
            {key ? A.removeKey : A.removeAddress}
          </Button>
          <Button kind="quiet" onClick={() => setAsking(false)}>
            {A.keepIt}
          </Button>
        </div>
      </Dialog>
    </section>
  )
}

function TurnOn({ m, onSaid }: { m: Meaning; onSaid: (t: string) => void }) {
  const r = meaningResource()
  const [choice, setChoice] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const chosen = m.providers.find((p) => p.name === choice) ?? null
  const why = !chosen ? A.chooseFirst : !accepted ? A.acceptFirst : blocked()
  return (
    <section class="settings-part" aria-labelledby="turn-on-title">
      <h2 id="turn-on-title" class="part-heading" tabIndex={-1}>
        {m.enabled ? A.changeProvider : A.turnOn}
      </h2>
      {m.enabled ? <p class="muted">{A.changeLead}</p> : null}
      <form
        class="settings-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault()
          if (why || pending || !chosen) return
          setPending(true)
          setError(null)
          try {
            r.data.value = await api.call<Meaning>('meaningOn', {
              body: { provider: chosen.name, accept: true },
            })
            setChoice(null)
            onSaid(A.isOn(chosen.label))
          } catch (x) {
            setError(x as ApiError)
          } finally {
            setPending(false)
          }
        }}
      >
        <FormAlert error={error} />
        <fieldset class="choices">
          <legend>{A.provider}</legend>
          {m.providers.map((p) => {
            const ready = m.available.includes(p.name)
            const inUse = m.enabled && m.provider === p.name
            return (
              <div class="pick" key={p.name}>
                <input
                  type="radio"
                  name="meaning-provider"
                  id={`turn-on-${p.name}`}
                  value={p.name}
                  checked={choice === p.name}
                  disabled={!ready || inUse}
                  aria-describedby={!ready || inUse ? `turn-on-${p.name}-why` : undefined}
                  onChange={() => {
                    // A new choice needs its own acceptance: the warning names the provider. Reset here, in
                    // the same step, so a box ticked right after is never undone by a late effect.
                    setChoice(p.name)
                    setAccepted(false)
                  }}
                />
                <label for={`turn-on-${p.name}`}>
                  {p.label}
                  {p.model ? ` (${p.model})` : ''}
                </label>
                {!ready || inUse ? (
                  <span class="reason" id={`turn-on-${p.name}-why`}>
                    {inUse ? A.inUse : A.providerNeeds(p.needs)}
                  </span>
                ) : null}
              </div>
            )
          })}
        </fieldset>
        {chosen ? (
          <>
            <div class="alert warn" role="note">
              <p>{m.warning}</p>
            </div>
            <div class="pick">
              <input
                type="checkbox"
                id="meaning-accept"
                checked={accepted}
                onChange={(e) => setAccepted(e.currentTarget.checked)}
              />
              <label for="meaning-accept">{A.accept(chosen.label)}</label>
            </div>
          </>
        ) : null}
        <div class="actions">
          <Button type="submit" kind="primary" pending={pending} pendingLabel={A.saving} blocked={why}>
            {A.turnOn}
          </Button>
        </div>
      </form>
    </section>
  )
}

function Screen() {
  const r = meaningResource()
  useFresh(r)
  const said = useSaid()
  const m = r.data.value
  const say = (t: string) => said.say(t, true)
  return (
    <div class="settings-parts">
      <Part id="meaning" title={A.meaning} lead={A.meaningLead} start>
        {!m ? (
          r.error.value ? (
            <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
          ) : (
            <Skeleton rows={2} />
          )
        ) : (
          <Status m={m} onSaid={say} />
        )}
        <Said text={said.said} id="meaning-said" focus={said.focus} />
      </Part>
      {m ? (
        <>
          <Part id="providers" title={A.providers} lead={A.providersLead}>
            {m.providers.map((p) => (
              <ProviderPart key={p.name} p={p} onSaid={say} />
            ))}
          </Part>
          <TurnOn m={m} onSaid={say} />
        </>
      ) : null}
    </div>
  )
}

export function AdminMeaning() {
  return <AdminFrame>{() => <Screen />}</AdminFrame>
}
