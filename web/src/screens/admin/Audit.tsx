// The audit (spec B6 «Admin › Audit», spec B4 «Auditoría»; PR25b). Who: the administration. Jobs: find who
// did what, when, in which brain and how it ended; take it away as a file. Done when: the filters narrow the
// lines, and the download holds exactly the lines the filters show (the same query, every page of it).
// Risks: a file that runs as a formula when opened (the server escapes every cell); a download that is not
// what was on screen (it is built from the filters applied, never from what is typed and not applied).
import { useEffect, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { api } from '../../api/index.ts'
import { resource } from '../../api/resource.ts'
import { type AuditFilters, auditExportHref, auditQuery, localWhen, localZone } from '../../lib/admin.ts'
import type { AdminAccount } from '../../lib/settings.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Field } from '../../ui/Field.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import { AdminFrame } from './Admin.tsx'
import { Part } from './parts.tsx'

const A = T.admin

type Row = {
  id: string
  at: string
  actor: { id: string; name: string | null } | null
  key: string | null
  action: string
  brain: string | null
  target: string | null
  outcome: string
  detail: string
}
const EMPTY: AuditFilters = { actor: '', action: '', brain: '', outcome: '', from: '', to: '' }
const GROUPS = [
  'account.',
  'audit.',
  'brain.',
  'branding.',
  'invitation.',
  'key.',
  'meaning.',
  'member.',
  'settings.',
]

// The filters applied, kept while the person moves between the tabs of the administration (memory only).
let kept: AuditFilters = EMPTY

const accountsResource = () =>
  resource<{ accounts: AdminAccount[] }>('admin:accounts', () =>
    api.call<{ accounts: AdminAccount[] }>('accounts'),
  )
const brainsResource = () =>
  resource<{ brains: Array<{ slug: string; name: string }> }>('admin:brains', () =>
    api.call<{ brains: Array<{ slug: string; name: string }> }>('allBrains'),
  )

function Screen() {
  const [typed, setTyped] = useState<AuditFilters>(kept)
  const [applied, setApplied] = useState<AuditFilters>(kept)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  // The newest line the server had when the view was read: the pin of the download when the view is empty.
  const [top, setTop] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [more, setMore] = useState(false)
  const [moreError, setMoreError] = useState<ApiError | null>(null)
  const people = accountsResource()
  const brains = brainsResource()
  useEffect(() => {
    if (!people.data.value) void people.reload()
    if (!brains.data.value) void brains.reload()
  }, [])
  const load = async (f: AuditFilters) => {
    setError(null)
    setRows(null)
    try {
      const page = await api.call<{ items: Row[]; next: string | null; upTo: string }>('auditLines', {
        query: auditQuery(f),
      })
      setRows(page.items)
      setNext(page.next)
      setTop(page.upTo)
    } catch (e) {
      setError(e as ApiError)
    }
  }
  useEffect(() => {
    kept = applied
    void load(applied)
  }, [applied])
  const apply = (f: AuditFilters) => setApplied({ ...f })
  const filtered = Object.values(applied).some((v) => v.trim())
  const set = (k: keyof AuditFilters, v: string) => setTyped({ ...typed, [k]: v })
  return (
    <Part id="audit" title={A.audit} lead={A.auditLead} start>
      <form
        class="filter-box"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          apply(typed)
        }}
      >
        <fieldset class="audit-filters">
          <legend>{A.filter}</legend>
          <p class="hint audit-zone">{A.zone(localZone())}</p>
          <div class="field">
            <label for="audit-who">{A.who}</label>
            <select id="audit-who" value={typed.actor} onChange={(e) => set('actor', e.currentTarget.value)}>
              <option value="">{A.anyone}</option>
              {(people.data.value?.accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <Field
            id="audit-action"
            label={A.action}
            hint={A.actionHint}
            list="audit-groups"
            autoComplete="off"
            spellcheck={false}
            value={typed.action}
            onValue={(v) => set('action', v)}
          />
          <datalist id="audit-groups">
            {GROUPS.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <div class="field">
            <label for="audit-brain">{A.brain}</label>
            <select
              id="audit-brain"
              value={typed.brain}
              onChange={(e) => set('brain', e.currentTarget.value)}
            >
              <option value="">{A.anyBrain}</option>
              {(brains.data.value?.brains ?? []).map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="audit-outcome">{A.outcome}</label>
            <select
              id="audit-outcome"
              value={typed.outcome}
              onChange={(e) => set('outcome', e.currentTarget.value)}
            >
              <option value="">{A.anyOutcome}</option>
              {Object.entries(A.outcomes).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Field
            id="audit-from"
            label={A.from}
            type="date"
            value={typed.from}
            onValue={(v) => set('from', v)}
          />
          <Field id="audit-to" label={A.to} type="date" value={typed.to} onValue={(v) => set('to', v)} />
        </fieldset>
        <div class="actions">
          <Button type="submit" kind="primary">
            {A.apply}
          </Button>
          {filtered ? (
            <Button
              kind="quiet"
              onClick={() => {
                setTyped(EMPTY)
                apply(EMPTY)
                document.getElementById('audit-who')?.focus()
              }}
            >
              {A.clear}
            </Button>
          ) : null}
        </div>
      </form>
      <p class="download">
        <a
          class="button secondary"
          href={auditExportHref(auditQuery(applied), rows?.[0]?.id ?? top)}
          download
        >
          {A.download}
        </a>
      </p>
      <p class="meta">{A.downloadNote}</p>
      {error ? (
        <ErrorState error={error} onRetry={() => void load(applied)} focus={false} />
      ) : rows === null ? (
        <Skeleton rows={4} />
      ) : rows.length === 0 ? (
        <div class="quiet-empty" data-state={filtered ? 'filtered-empty' : 'empty'}>
          <p class="list-title">{A.noLines}</p>
          <p class="muted">{A.noLinesHow}</p>
          {filtered ? (
            <Button
              kind="quiet"
              onClick={() => {
                setTyped(EMPTY)
                apply(EMPTY)
                document.getElementById('audit-who')?.focus()
              }}
            >
              {A.clear}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <p class="meta" role="status">
            {A.showing(rows.length, next !== null)}
          </p>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a table wider than a phone scrolls sideways inside its frame; the keyboard must be able to scroll it too */}
          <section class="table-scroll" tabIndex={0} aria-label={A.linesFrame}>
            <table class="data-table" aria-label={A.lines}>
              <thead>
                <tr>
                  {A.cols.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} id={`audit-${r.id}`} tabIndex={-1}>
                    <td>
                      <time dateTime={r.at}>{localWhen(r.at)}</time>
                    </td>
                    <td>{r.actor?.name ?? r.actor?.id ?? '—'}</td>
                    <td class="mono">{r.action}</td>
                    <td>{r.brain ?? '—'}</td>
                    <td class="mono">{r.target ?? '—'}</td>
                    <td>{A.outcomes[r.outcome] ?? r.outcome}</td>
                    <td>{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <FormAlert error={moreError} />
          {next ? (
            <div class="actions">
              <Button
                pending={more}
                pendingLabel={T.states.pending}
                onClick={async () => {
                  setMore(true)
                  setMoreError(null)
                  try {
                    const page = await api.call<{ items: Row[]; next: string | null }>('auditLines', {
                      query: { ...auditQuery(applied), before: next },
                    })
                    setRows([...rows, ...page.items])
                    setNext(page.next)
                    // The keyboard goes to the first new line, not back to the top.
                    const first = page.items[0]
                    if (first)
                      requestAnimationFrame(() => document.getElementById(`audit-${first.id}`)?.focus())
                  } catch (e) {
                    setMoreError(e as ApiError)
                  } finally {
                    setMore(false)
                  }
                }}
              >
                {A.more}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Part>
  )
}

export function AdminAudit() {
  return <AdminFrame>{() => <Screen />}</AdminFrame>
}
