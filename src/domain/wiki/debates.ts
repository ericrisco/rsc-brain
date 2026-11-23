// A known debate (e2e finding, health): two pages that contradict each other on purpose, such as two papers that
// disagree, are not a problem to settle. A curator, as a person in the web, marks the pair as known; it then
// leaves the health problems and the cleanup an agent is asked for, and shows in a list of its own. Unmarking it
// brings it back as a contradiction.
import { invalid } from '../../core/errors.ts'
import { allow, type Ctx, inBrain } from '../context.ts'
import { webOnly } from './review.ts'

export async function setDebate(
  ctx: Ctx,
  slug: string,
  o: { a: string; b: string; known: boolean },
): Promise<{ a: string; b: string; known: boolean }> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    webOnly(c)
    await allow(c, 'wiki.decide', { role, brainStatus: brain.status }, brain.id)
    const pages = await db.query<{ id: string; address: string }>(
      `SELECT DISTINCT p.id, p.address FROM pages p JOIN page_addresses a ON a.page_id = p.id
        WHERE p.brain_id = $1 AND a.address = ANY($2)`,
      [brain.id, [o.a, o.b]],
    )
    const byAddress = (x: string) => pages.find((p) => p.address === x) ?? pages.find((p) => p.id === x)
    const first = byAddress(o.a)
    const second = byAddress(o.b)
    if (!first || !second || first.id === second.id)
      throw invalid(
        'Name two different pages of this brain.',
        'Send the addresses of the two pages as "a" and "b".',
      )
    const linked = await db.one(
      `SELECT 1 FROM page_links WHERE brain_id = $1 AND kind = 'contradicts'
          AND ((from_page = $2 AND to_page = $3) OR (from_page = $3 AND to_page = $2))`,
      [brain.id, first.id, second.id],
    )
    if (!linked)
      throw invalid(
        'These two pages are not linked as contradicting each other.',
        'Mark a debate only between pages with a "contradicts" link.',
      )
    // The pair is kept smaller id first, as the database orders them (its collation, not the program's).
    if (o.known) {
      await db.query(
        `INSERT INTO wiki_debates (brain_id, page_a, page_b, acknowledged_by, acknowledged_at)
         VALUES ($1, least($2::text, $3::text), greatest($2::text, $3::text), $4, $5) ON CONFLICT DO NOTHING`,
        [brain.id, first.id, second.id, ctx.who.accountId, ctx.clock()],
      )
    } else {
      await db.query(
        `DELETE FROM wiki_debates
          WHERE brain_id = $1 AND page_a = least($2::text, $3::text) AND page_b = greatest($2::text, $3::text)`,
        [brain.id, first.id, second.id],
      )
    }
    return { a: o.a, b: o.b, known: o.known }
  })
}
