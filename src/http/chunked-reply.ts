import { createHash } from 'node:crypto'
import { AppError, invalid } from '../core/errors.ts'
import { head, MAX_REPLY_CHARS } from './bounds.ts'

const PART_CHARS = 120_000 // JSON text can double when escaped inside the response envelope.

// Reserve MCP's text-result envelope and its maximum 10 000-character request id as well.
const MCP_RESERVE = 12_000
const fitsMcp = (text: string) => JSON.stringify(text).length <= MAX_REPLY_CHARS - MCP_RESERVE

// Return the usual body whenever it fits its transport. Continuations refer to an exact
// serialization, so a concurrent edit can never splice two versions of a map or review.
export function chunkedReply(
  kind: 'map' | 'review',
  value: unknown,
  query: URLSearchParams,
  reserveMcp: boolean,
): unknown {
  const field = `${kind}Chunk`
  const text = JSON.stringify(value)
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = query.get(name)
    if (raw === null) return fallback
    const n = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
      throw invalid(
        `"${name}" must be an integer from ${min} to ${max}.`,
        `Correct the ${kind} paging parameters.`,
      )
    }
    return n
  }
  const offset = number('offset', 0, 0, Number.MAX_SAFE_INTEGER)
  const max = number('max', PART_CHARS, 1024, PART_CHARS)
  const seen = query.get('snapshot')
  if (offset > 0 && !seen)
    throw invalid(
      `Continuing a ${kind} needs its snapshot.`,
      `Send the snapshot and next offset from the preceding ${field}.`,
    )
  if (
    !query.has('offset') &&
    !query.has('max') &&
    seen === null &&
    (reserveMcp ? fitsMcp(text) : text.length <= MAX_REPLY_CHARS)
  )
    return value
  const snapshot = createHash('sha256').update(text).digest('hex')
  if (seen !== null && seen !== snapshot) {
    throw new AppError(
      409,
      `${kind}_changed`,
      `The ${kind} changed while it was loading.`,
      `Reload the ${kind} from the beginning.`,
    )
  }
  if (offset >= text.length)
    throw invalid(`The ${kind} offset is past its end.`, `Use next from the preceding ${field}.`)
  let part = head(text.slice(offset), max)
  for (;;) {
    const end = offset + part.length
    const reply = {
      [field]: { text: part, offset, next: end < text.length ? end : null, total: text.length, snapshot },
      howToProceed: `Append ${field}.text in offset order. Request this ${kind} with offset=next and the same snapshot until next is null, then parse the joined JSON.`,
    }
    if (fitsMcp(JSON.stringify(reply))) return reply
    part = head(part, Math.floor(part.length / 2))
  }
}
