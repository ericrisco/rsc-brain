// Deciding on proposals and editing pages by hand: the same routes for everyone, but only a person's
// web session gets through (spec B2 clarifications). Any key, even a curator's token, is told that
// approval happens in the web (CA9) and the wiki does not change.

import { invalid } from '../../core/errors.ts'
import { approveProposal, returnProposal, reviewProposal } from '../../domain/wiki/decide.ts'
import {
  directChange,
  getWikiSettings,
  maintenanceAsked,
  SETTINGS_FIELDS,
  type SettingsField,
  setWikiSettings,
} from '../../domain/wiki/direct.ts'
import { purgePageRevisions, purgeProposal } from '../../domain/wiki/purge.ts'
import { bool, compact, int, type Obj, obj, reqStr, str, strList } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

function indices(b: Obj, key: string): number[] | undefined {
  const v = b[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0)) {
    throw invalid(`"${key}" is a list of operation numbers.`, `Send "${key}" as [0, 2, …].`)
  }
  return v as number[]
}

export const decideRoutes: Route[] = [
  route('GET /v1/proposals/:id/review', async (r) => ({
    body: await reviewProposal(ctxOf(r), r.params.id as string),
  })),
  route('POST /v1/proposals/:id/approve', async (r) => {
    const b = obj(r.body)
    const corrections = b.corrections
    if (
      corrections !== undefined &&
      (typeof corrections !== 'object' || corrections === null || Array.isArray(corrections))
    ) {
      throw invalid('"corrections" maps an operation number to its corrected operation.', 'Send {"2": {…}}.')
    }
    return {
      body: await approveProposal(
        ctxOf(r),
        r.params.id as string,
        compact({
          fingerprint: reqStr(b, 'fingerprint', 64),
          approve: indices(b, 'approve'),
          comment: str(b, 'comment'),
          corrections: corrections as Record<string, unknown> | undefined,
          baseReviewed: indices(b, 'baseReviewed'),
        }),
      ),
    }
  }),
  route('POST /v1/proposals/:id/return', async (r) => {
    const b = obj(r.body)
    return {
      body: await returnProposal(ctxOf(r), r.params.id as string, {
        fingerprint: reqStr(b, 'fingerprint', 64),
        comment: reqStr(b, 'comment'),
      }),
    }
  }),
  // Editing a page by hand is the web's (direct edits arrive with the web session).
  // A curator's edit by hand: the page's address in the path, the changed fields and the revision read.
  route('PATCH /v1/brains/:slug/pages/*address', async (r) => {
    const b = obj(r.body)
    return {
      body: await directChange(ctxOf(r), r.params.slug as string, {
        ...b,
        op: 'edit',
        address: r.params.address,
        reason: typeof b.reason === 'string' ? b.reason : 'direct edit',
      }),
    }
  }),
  route('POST /v1/brains/:slug/wiki/changes', async (r) => {
    const b = obj(r.body)
    return {
      status: 201,
      body: await directChange(ctxOf(r), r.params.slug as string, {
        ...b,
        reason: typeof b.reason === 'string' ? b.reason : 'direct edit',
      }),
    }
  }),
  route('GET /v1/brains/:slug/wiki/settings', async (r) => ({
    body: await getWikiSettings(ctxOf(r), r.params.slug as string),
  })),
  route('PUT /v1/brains/:slug/wiki/settings', async (r) => {
    const b = obj(r.body)
    const guide = b.guide
    if (guide !== undefined && guide !== null && typeof guide !== 'string') {
      throw invalid('"guide" is text, or null for the default.', 'Fix "guide".')
    }
    const base = baseOf(b.base)
    return {
      body: await setWikiSettings(
        ctxOf(r),
        r.params.slug as string,
        compact({
          base,
          guide: guide as string | null | undefined,
          mapIntro: str(b, 'mapIntro'),
          usageNote: str(b, 'usageNote'),
          meaningExcluded: bool(b, 'meaningExcluded'),
          staleDays: int(b, 'staleDays'),
          longChars: int(b, 'longChars'),
          maintenanceEvery: int(b, 'maintenanceEvery'),
        }),
      ),
    }
  }),
  route('POST /v1/brains/:slug/wiki/maintenance-asked', async (r) => ({
    body: await maintenanceAsked(ctxOf(r), r.params.slug as string),
  })),
  route('POST /v1/brains/:slug/wiki/purge', async (r) => {
    const b = obj(r.body)
    const one = int(b, 'revision', { min: 1, max: 1_000_000 })
    const many = b.revisions
    if (
      many !== undefined &&
      (!Array.isArray(many) || many.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1))
    ) {
      throw invalid('"revisions" is a list of revision numbers.', 'Send "revisions": [4, 5].')
    }
    const list = [...(one === undefined ? [] : [one]), ...((many as number[] | undefined) ?? [])]
    return {
      body: await purgePageRevisions(
        ctxOf(r),
        r.params.slug as string,
        compact({ address: reqStr(b, 'address', 200), pageId: str(b, 'pageId', { max: 40 }) }),
        list,
        strList(b, 'text', { maxItems: 20, maxLen: 500 }) ?? [],
        reqStr(b, 'reason'),
      ),
    }
  }),
  route('POST /v1/proposals/:id/purge', async (r) => ({
    body: await purgeProposal(ctxOf(r), r.params.id as string, reqStr(obj(r.body), 'reason')),
  })),
]

// "base": what each field was when the person read it, as {field: value}; only fields a person edits.
function baseOf(v: unknown): Partial<Record<SettingsField, unknown>> | undefined {
  if (v === undefined || v === null) return undefined
  const bad = () =>
    invalid(
      `"base" holds what each field was when you read it, such as {"staleDays": 90}: ${SETTINGS_FIELDS.join(', ')}.`,
      'Fix "base", or leave it out to save regardless.',
    )
  if (typeof v !== 'object' || Array.isArray(v)) throw bad()
  const out: Partial<Record<SettingsField, unknown>> = {}
  for (const [k, x] of Object.entries(v)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(k)) throw bad()
    if (x !== null && !['string', 'number', 'boolean'].includes(typeof x)) throw bad()
    out[k as SettingsField] = x
  }
  return out
}
