// What the parts of the administration (PR25b) share: a titled part, a body that never shows an empty box
// while its values are on their way, what a part says once done (taking the keyboard there, so it never
// falls to the page), the conflict of a save, and the settings of the installation read and saved field by
// field on what each part read (per-field compare-and-set, like a brain's settings).
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { type Resource, resource } from '../../api/resource.ts'
import { type InstallationRead, installationSave } from '../../lib/admin.ts'
import { fieldDrafts } from '../../lib/settings.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { writeBlocked } from '../../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'

const A = T.admin
export const blocked = () => writeBlocked({ online: online.value, pending: false })

export function Part({
  id,
  title,
  lead,
  children,
  start = false,
}: {
  id: string
  title: string
  lead?: string
  children: ComponentChildren
  // The first part of a page: the screen's own focus goes to its heading on arrival.
  start?: boolean
}) {
  return (
    <section class="settings-part" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} class="part-heading" tabIndex={-1} data-start={start ? true : undefined}>
        {title}
      </h2>
      {lead ? <p class="muted">{lead}</p> : null}
      {children}
    </section>
  )
}

// A part shows its fields only once its values are read: never an empty box to type in meanwhile.
export function PartBody<T>({
  r,
  rows,
  ready,
  children,
}: {
  r: Resource<T>
  rows: number
  ready: boolean
  children: ComponentChildren
}) {
  if (ready) return <>{children}</>
  if (r.data.value) return <Skeleton rows={rows} />
  return r.error.value ? (
    <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
  ) : (
    <Skeleton rows={rows} />
  )
}

// What a part says once done; announced, and focused when `focus` moves (the control pressed may be gone).
export function Said({
  text,
  id,
  focus = 0,
  tone = 'ok',
}: {
  text: string | null
  id: string
  focus?: number
  tone?: 'ok' | 'error'
}) {
  useEffect(() => {
    if (focus) document.getElementById(id)?.focus()
  }, [focus])
  return (
    <p class={`said ${tone}`} role="status" id={id} tabIndex={-1}>
      {text}
    </p>
  )
}

export function useSaid() {
  const [said, setSaid] = useState<string | null>(null)
  const [focus, setFocus] = useState(0)
  return {
    said,
    focus,
    say: (t: string | null, take = false) => {
      setSaid(t)
      if (take && t) setFocus((n) => n + 1)
    },
  }
}

export function Conflict({ children }: { children?: ComponentChildren }) {
  return (
    <>
      <FormAlert error={{ message: A.changedTitle, howToProceed: A.changedHow }} />
      {children ? (
        <div class="theirs">
          <p class="meta">{A.theirs}</p>
          {children}
        </div>
      ) : null}
    </>
  )
}

// What was typed and not saved, in this tab's memory only, by account and field (never a secret).
const SCOPE = '\u0000installation'
export const adminDrafts = {
  get: (account: string, field: string) => fieldDrafts.get(account, SCOPE, field),
  set: (account: string, field: string, v: string) => fieldDrafts.set(account, SCOPE, field, v),
  clear: (account: string, field: string) => fieldDrafts.clear(account, SCOPE, field),
}
// A field's draft: kept while it differs from what was read, dropped when it is back to it.
export function keepDraft(account: string, field: string, value: string, read: string): void {
  if (value === read) adminDrafts.clear(account, field)
  else adminDrafts.set(account, field, value)
}

export const installResource = () =>
  resource<InstallationRead>('admin:settings', () => api.call<InstallationRead>('installSettings'))

// One part of the installation's settings: its own base (what it read when it opened), a save that sends
// only what changed beside that base, a conflict that brings the values now while what was typed stays.
export function useInstallPart() {
  const r = installResource()
  const [base, setBase] = useState<InstallationRead | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const said = useSaid()
  const [theirs, setTheirs] = useState<InstallationRead | null>(null)
  const was = useRef<InstallationRead | null>(null)
  useFresh(r)
  useEffect(() => {
    if (r.data.value && !base && !r.loading.value) setBase(r.data.value)
  }, [r.data.value, r.loading.value])
  const save = async (edit: Parameters<typeof installationSave>[1]): Promise<InstallationRead | null> => {
    if (pending || !online.value || !base) return null
    setError(null)
    setPending(true)
    said.say(null)
    try {
      const fresh = await api.call<InstallationRead & { unchanged?: boolean }>('saveInstallSettings', {
        body: installationSave(base, edit),
      })
      r.data.value = fresh
      was.current = base
      setBase(fresh)
      setTheirs(null)
      said.say(fresh.unchanged ? A.nothing : A.saved, true)
      return fresh
    } catch (e) {
      const a = e as ApiError
      if (a.code === 'settings_changed' && a.current && typeof a.current === 'object') {
        const now = a.current as InstallationRead
        r.data.value = now
        was.current = base
        setBase(now)
        setTheirs(now)
      } else setError(a)
      return null
    } finally {
      setPending(false)
    }
  }
  // A field still showing the old base follows the new one; what the person typed stays.
  const follow = <K,>(field: (x: InstallationRead) => K, set: (f: (prev: K) => K) => void) => {
    const before = was.current
    if (!before || !base || before === base) return
    const old = field(before)
    const now = field(base)
    set((prev) => (prev === old ? now : prev))
  }
  return { r, base, pending, error, said, theirs, save, follow }
}
