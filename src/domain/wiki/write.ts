// Writing to the wiki directly (spec v0.6 «Escritura directa»; constitution P5 v2.1.0): a key a curator let write
// sends the operations of a proposal, checked the same way, and they apply at once through the one writer of
// pages — all or nothing, a revision per page, one log line that says which key wrote it. A retry with the same
// request key gets the same receipt and writes nothing twice (CA5). A page that moved on since the revision the
// agent read is not written: nothing is, and the current version comes back (CA6). The permission is asked on
// every request (writers.ts), so taking it back counts from the next one (CA3).
import { createHash } from 'node:crypto'
import { AppError, conflict, invalid } from '../../core/errors.ts'
import type { Db } from '../../db/db.ts'
import { allow, type Ctx, inBrain } from '../context.ts'
import { type Checked, checkChange } from './coherence.ts'
import type { Op, Problem } from './model.ts'
import { getPage } from './pages.ts'
import { knownAddresses, type ProposalInput, problemsOf, readPackage } from './proposals.ts'
import { keyIdOf, mayWriteWiki } from './writers.ts'

export type WriteInput = ProposalInput & { maintenance?: boolean; requestKey?: string }

export type WriteReceipt = {
  applied: true
  logId: string
  revised: { index?: number; address: string; revision: number }[]
} & Checked

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// The key's name as the log keeps it: a token's or main key's name, an app's name; a short key's main key, with
// the job it was made for.
async function keyName(db: Db, ctx: Ctx): Promise<string> {
  const c = ctx.who.credential
  const id = keyIdOf(c)
  const r = id
    ? await db.one<{ name: string }>(
        `SELECT coalesce((SELECT name FROM credentials WHERE id = $1),
                         (SELECT client_name FROM oauth_grants WHERE id = $1)) AS name`,
        [id],
      )
    : undefined
  const name = r?.name ?? 'a key'
  return c.kind === 'short' && c.ref ? `${name} (${c.ref})` : name
}

export async function writeWiki(ctx: Ctx, slug: string, input: WriteInput): Promise<WriteReceipt> {
  const pkg = readPackage(ctx, input, 'A write')
  if (input.requestKey !== undefined && (!input.requestKey.trim() || input.requestKey.length > 200)) {
    throw invalid('A request key has 1 to 200 characters.', 'Use a fresh random id per request, e.g. a UUID.')
  }
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await mayWriteWiki(c, brain, role)
    // Same key, same request: the same receipt. Two retries racing are serialised here (as the journal does).
    let keyHash: string | null = null
    let requestHash: string | null = null
    if (input.requestKey !== undefined) {
      keyHash = sha(input.requestKey)
      requestHash = sha(
        JSON.stringify([
          'wiki.write',
          brain.id,
          pkg.title,
          pkg.reason,
          pkg.ops,
          pkg.collected,
          Boolean(input.maintenance),
        ]),
      )
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${ctx.who.credential.id}:${keyHash}`,
      ])
      const seen = await db.one<{ request_hash: string; receipt: WriteReceipt }>(
        'SELECT request_hash, receipt FROM request_keys WHERE credential_id = $1 AND key = $2',
        [ctx.who.credential.id, keyHash],
      )
      if (seen) {
        if (seen.request_hash === requestHash) return seen.receipt
        throw conflict(
          'request_key_reused',
          'This request key was already used for a different request.',
          'Use a new request key for a new write; reuse a key only to retry the very same request.',
        )
      }
    }
    // The checks of a proposal block a write too, all at once (an agent's new page cites its sources).
    const problems = [...pkg.problems, ...(await problemsOf(db, brain.id, pkg.ops, pkg.collected))]
    if (problems.length > 0) {
      const err = new AppError(
        400,
        'write_invalid',
        `The write has ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was written.`,
        'Fix each problem listed in "problems" and send it again.',
      )
      err.problems = problems
      throw err
    }
    const ops = pkg.ops as Op[]
    // An edit goes against the revision the agent read: if the page moved on, nothing is written (CA6).
    const known = await knownAddresses(db, brain.id, ops)
    for (const o of ops) {
      if (o.op !== 'edit' || o.baseRevision === undefined) continue
      const now = known.get(o.address)
      if (now && now.revision !== o.baseRevision) {
        const err = conflict(
          'page_changed',
          `"${o.address}" changed since revision ${o.baseRevision}; it is at ${now.revision}. Nothing was written.`,
          'Apply your change to the current version (in "current") and send it again with its revision.',
        )
        err.current = await getPage(c, slug, o.address)
        throw err
      }
    }
    const name = await keyName(db, c)
    // Applied, and looked at as it now stands: the warnings and the neighbours come with the receipt (CA7, CA9).
    const { applied, coherence, neighbours } = await checkChange(c, db, brain.id, ops, {
      keep: true,
      meta: {
        kind: 'write',
        summary: `Written directly by ${name}: ${pkg.title}`,
        reason: pkg.reason || (ops.length === 1 ? (ops[0]?.reason ?? '') : ''),
        keyName: name,
        maintenance: Boolean(input.maintenance),
      },
    })
    if (!applied) throw invalid('Nothing to write.', 'Send at least one operation.')
    const { revised, logId } = applied
    // The entries it cites, and those collected without changes, are compiled, as with an approved proposal.
    const cited = new Set<string>(pkg.collected)
    for (const o of ops) {
      if (o.op === 'create' || o.op === 'edit')
        for (const s of o.sources ?? []) if ('entryId' in s) cited.add(s.entryId)
    }
    if (cited.size > 0) {
      await db.query('UPDATE entries SET compiled = true WHERE brain_id = $1 AND id = ANY($2)', [
        brain.id,
        [...cited],
      ])
    }
    const receipt: WriteReceipt = {
      applied: true,
      logId,
      revised: revised.map((r) => ({
        ...(r.index === undefined ? {} : { index: r.index }),
        address: r.address,
        revision: r.revision,
      })),
      coherence,
      neighbours,
    }
    if (keyHash && requestHash) {
      await db.query(
        'INSERT INTO request_keys (credential_id, key, request_hash, receipt, created_at) VALUES ($1, $2, $3, $4, $5)',
        [ctx.who.credential.id, keyHash, requestHash, JSON.stringify(receipt), ctx.clock()],
      )
    }
    return receipt
  })
}

// Asking first (CA8): the problems that would block the change, and when there are none, the warnings and the
// neighbours it would have — worked out on the wiki as it would be, then undone. For anyone who may propose.
export async function checkWiki(
  ctx: Ctx,
  slug: string,
  input: ProposalInput,
): Promise<{ problems: Problem[] } & Checked> {
  const pkg = readPackage(ctx, input, 'A change')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug })
    await allow(c, 'wiki.propose', { role, brainStatus: brain.status }, brain.id)
    const problems = [...pkg.problems, ...(await problemsOf(db, brain.id, pkg.ops, pkg.collected))]
    if (problems.length > 0) return { problems, coherence: [], neighbours: [] }
    return { problems, ...(await checkChange(c, db, brain.id, pkg.ops as Op[], { keep: false })) }
  })
}
