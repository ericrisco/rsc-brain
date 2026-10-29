// Deciding on proposals and editing pages by hand: the same routes for everyone, but only a person's
// web session gets through (spec B2 clarifications). Any key, even a curator's token, is told that
// approval happens in the web (CA9) and the wiki does not change.

import { invalid } from '../../core/errors.ts'
import { inBrain } from '../../domain/context.ts'
import { approveProposal, returnProposal, reviewProposal } from '../../domain/wiki/decide.ts'
import { webOnly } from '../../domain/wiki/review.ts'
import { compact, type Obj, obj, reqStr, str } from '../input.ts'
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
  route('PATCH /v1/brains/:slug/pages/*address', async (r) => {
    const ctx = ctxOf(r)
    await inBrain(ctx, { slug: r.params.slug as string })
    webOnly(ctx)
    throw invalid('Direct edits are not open yet.', 'Propose the change.')
  }),
]
