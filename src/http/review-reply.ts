// Reviews can repeat a long page in before/after and stale-base states. Page the serialized review,
// including a single large operation, without dropping fields or relaxing the API response bound.
import { createHash } from 'node:crypto'
import { AppError, invalid } from '../core/errors.ts'
import { head, MAX_REPLY_CHARS } from './bounds.ts'

const PART_CHARS = 120_000 // JSON text can double when escaped inside the response envelope.

// Reserve MCP's text-result envelope and its maximum 10 000-character request id as well.
const fits = (value: unknown) => JSON.stringify(JSON.stringify(value)).length <= MAX_REPLY_CHARS - 12_000

export function reviewReply(review: unknown, query: URLSearchParams): unknown {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = query.get(name)
    if (raw === null) return fallback
    const n = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
      throw invalid(
        `"${name}" must be an integer from ${min} to ${max}.`,
        'Correct the review paging parameters.',
      )
    }
    return n
  }
  const text = JSON.stringify(review)
  const offset = number('offset', 0, 0, Number.MAX_SAFE_INTEGER)
  const max = number('max', PART_CHARS, 1024, PART_CHARS)
  const seen = query.get('snapshot')
  if (offset > 0 && !seen)
    throw invalid(
      'Continuing a review needs its snapshot.',
      'Send the snapshot and next offset from the preceding reviewChunk.',
    )
  const snapshot = createHash('sha256').update(text).digest('hex')
  if (seen !== null && seen !== snapshot) {
    throw new AppError(
      409,
      'review_changed',
      'The review changed while it was loading.',
      'Reload the review from the beginning before deciding.',
    )
  }
  if (offset >= text.length)
    throw invalid('The review offset is past its end.', 'Use next from the preceding reviewChunk.')
  if (fits(review) && !query.has('offset') && !query.has('max') && !seen) return review
  let part = head(text.slice(offset), max)
  for (;;) {
    const end = offset + part.length
    const reply = {
      reviewChunk: { text: part, offset, next: end < text.length ? end : null, total: text.length, snapshot },
      howToProceed:
        'Append reviewChunk.text in offset order. Request this review with offset=next and the same snapshot until next is null, then parse the joined JSON before deciding.',
    }
    if (fits(reply)) return reply
    part = head(part, Math.floor(part.length / 2))
  }
}
