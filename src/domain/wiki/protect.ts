// Spec learning-memory A3 (plan §2.6): a curator, in the web, protects a page or takes the protection off. On a
// protected page only a person in the web or a key with the wiki write permission writes; the other keys' parts wait
// for a person (parts.ts). No page is born protected (CA-A19). Each change is a line in the wiki log («Protected: …»,
// «Unprotected: …»), never a revision: the page itself does not change. Asking for what it already is changes nothing.
import { AppError } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import { allow, type Ctx, inBrain } from '../context.ts'
import { getPage, type PageReading, pageNotFound, resolve } from './pages.ts'

export async function setProtection(
  ctx: Ctx,
  slug: string,
  address: string,
  value: boolean,
): Promise<PageReading> {
  await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    if (ctx.who.credential.kind !== 'web')
      throw new AppError(
        403,
        'protect_web_only',
        'Protecting a page is done in the web.',
        'Open the page in the rsc-brain web, signed in as a curator, and use the Protected switch. Keys cannot protect or unprotect pages.',
      )
    await allow(c, 'wiki.decide', { role, brainStatus: brain.status }, brain.id)
    // The wiki's lock: a protection never lands between the reading and the writing of a change to the page.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brain.id}`])
    const row = await resolve(db, brain.id, address)
    if (!row) throw pageNotFound(address)
    if (Boolean(row.protected) === value) return
    const now = ctx.clock()
    await db.query('UPDATE pages SET protected = $2, protected_by = $3, protected_at = $4 WHERE id = $1', [
      row.id,
      value,
      value ? ctx.who.accountId : null,
      value ? now : null,
    ])
    await db.query(
      `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary, pages, credential_id)
       VALUES ($1, $2, $3, $4, 'protect', $5, $6, $7)`,
      [
        newId('wlg'),
        brain.id,
        now,
        ctx.who.accountId,
        `${value ? 'Protected' : 'Unprotected'}: ${row.address}`.slice(0, 500),
        [String(row.address)],
        ctx.who.credential.id,
      ],
    )
  })
  return getPage(ctx, slug, address)
}
