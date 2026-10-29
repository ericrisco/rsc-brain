// Reading the audit (spec B4 «Auditoría»): the administration sees all of it, with filters, and can
// download it; a curator sees the part of their brain. Nobody edits it (the database refuses).
import { atLeast } from '../auth/can.ts'
import { brainNotFound, invalid } from '../core/errors.ts'
import type { Row } from '../db/db.ts'
import { type Ctx, inBrain, ok } from './context.ts'
import { adminOnly, inWeb } from './guards.ts'

export const AUDIT_PAGE = 100
export const AUDIT_EXPORT_MAX = 100_000

export type AuditFilters = {
  action?: string | undefined // an action, or a prefix ending in "." (such as "invitation.")
  actor?: string | undefined // account id
  brain?: string | undefined // slug
  outcome?: string | undefined
  from?: string | undefined // ISO time, inclusive
  to?: string | undefined // ISO time, exclusive
  before?: string | undefined // the id of the last row of the previous page
}

function timeOf(v: string | undefined, field: string): Date | undefined {
  if (v === undefined) return undefined
  const d = new Date(v)
  if (Number.isNaN(d.getTime()) || v.length > 40)
    throw invalid(`"${field}" is a date or time.`, 'Such as 2026-10-29 or 2026-10-29T10:00:00Z.')
  return d
}

async function query(ctx: Ctx, f: AuditFilters, brainId: string | null, limit: number) {
  const where: string[] = []
  const args: unknown[] = []
  const p = (v: unknown) => {
    args.push(v)
    return `$${args.length}`
  }
  if (brainId) where.push(`a.brain_id = ${p(brainId)}`)
  else if (f.brain) {
    const b = await ctx.db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [f.brain])
    // A deleted brain keeps its audit: its id is accepted as well as a slug.
    where.push(`a.brain_id = ${p(b?.id ?? f.brain)}`)
  }
  if (f.action) {
    if (f.action.length > 80)
      throw invalid('"action" is too long.', 'Such as "invitation." or "member.role".')
    if (f.action.endsWith('.')) where.push(`a.action LIKE ${p(`${f.action.replace(/[%_\\]/g, '\\$&')}%`)}`)
    else where.push(`a.action = ${p(f.action)}`)
  }
  if (f.actor) where.push(`a.actor_id = ${p(f.actor.slice(0, 80))}`)
  if (f.outcome) {
    if (f.outcome !== 'ok' && f.outcome !== 'denied')
      throw invalid('"outcome" is ok or denied.', 'Choose one.')
    where.push(`a.outcome = ${p(f.outcome)}`)
  }
  const from = timeOf(f.from, 'from')
  const to = timeOf(f.to, 'to')
  if (from) where.push(`a.at >= ${p(from)}`)
  if (to) where.push(`a.at < ${p(to)}`)
  if (f.before) {
    if (!/^\d{1,18}$/.test(f.before))
      throw invalid('"before" is the id of a row.', 'Use the "next" value of the previous page.')
    where.push(`a.id < ${p(f.before)}`)
  }
  const rows = await ctx.db.query(
    `SELECT a.*, ac.name AS actor_name, b.slug AS brain_slug FROM audit a
       LEFT JOIN accounts ac ON ac.id = a.actor_id LEFT JOIN brains b ON b.id = a.brain_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT ${p(limit)}`,
    args,
  )
  return rows.map(view)
}

const view = (r: Row) => ({
  id: String(r.id),
  at: (r.at as Date).toISOString(),
  actor:
    r.actor_id == null
      ? null
      : { id: String(r.actor_id), name: r.actor_name == null ? null : String(r.actor_name) },
  key: r.credential_id == null ? null : String(r.credential_id),
  action: String(r.action),
  brain: r.brain_id == null ? null : String(r.brain_slug ?? r.brain_id),
  target: r.target == null ? null : String(r.target),
  outcome: String(r.outcome),
  detail: String(r.detail),
})

export async function readAudit(ctx: Ctx, f: AuditFilters) {
  adminOnly(ctx)
  const items = await query(ctx, f, null, AUDIT_PAGE + 1)
  const more = items.length > AUDIT_PAGE
  const page = items.slice(0, AUDIT_PAGE)
  return { items: page, next: more ? (page.at(-1)?.id ?? null) : null }
}

// A curator sees the audit of their brain.
export async function brainAudit(ctx: Ctx, slug: string, f: AuditFilters) {
  inWeb(ctx, 'Reading the audit')
  const { brain, role } = await inBrain(ctx, { slug })
  if (!atLeast(role, 'curator')) throw brainNotFound()
  const items = await query(ctx, { ...f, brain: undefined }, brain.id, AUDIT_PAGE + 1)
  const more = items.length > AUDIT_PAGE
  const page = items.slice(0, AUDIT_PAGE)
  return { items: page, next: more ? (page.at(-1)?.id ?? null) : null }
}

// A cell a spreadsheet must not run as a formula.
const cell = (v: string | null) => {
  let s = v ?? ''
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Up to 100 000 rows, newest first; when there are more it says so, so a file never looks complete
// when it is not. Downloading is itself recorded.
export async function exportAudit(ctx: Ctx, f: AuditFilters): Promise<{ csv: string; truncated: boolean }> {
  adminOnly(ctx)
  const all = await query(ctx, f, null, AUDIT_EXPORT_MAX + 1)
  const truncated = all.length > AUDIT_EXPORT_MAX
  const rows = all.slice(0, AUDIT_EXPORT_MAX)
  await ok(
    ctx,
    'audit.export',
    null,
    undefined,
    `${rows.length} row(s)${truncated ? ', more not included' : ''}`,
  )
  const head = 'id,at,actor_id,actor_name,key,action,brain,target,outcome,detail'
  const lines = rows.map((r) =>
    [
      r.id,
      r.at,
      r.actor?.id ?? '',
      r.actor?.name ?? '',
      r.key,
      r.action,
      r.brain,
      r.target,
      r.outcome,
      r.detail,
    ]
      .map((v) => cell(v))
      .join(','),
  )
  return { csv: `${[head, ...lines].join('\r\n')}\r\n`, truncated }
}
