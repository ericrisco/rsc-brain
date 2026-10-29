// Repositories linked to a brain (spec B5 «brain_resolve»): a curator links the repositories a brain is
// about; an agent working in one asks which brain is its. Only brains the key can see are answered.
import { atLeast } from '../auth/can.ts'
import { roleIn } from '../auth/principal.ts'
import { brainNotFound, conflict, invalid, notFound } from '../core/errors.ts'
import { listBrains } from './brains.ts'
import { type Ctx, inBrain, ok } from './context.ts'
import { inWeb } from './guards.ts'

// A repository address as people and tools write it, reduced to host and path:
// "https://user@github.com/Org/Repo.git", "git@github.com:org/repo" and "ssh://git@github.com/org/repo/"
// are all "github.com/org/repo".
export function repoKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (!s || s.length > 500) return null
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(s) // git@host:path
  if (scp) s = `${scp[1]}/${scp[2]}`
  else {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    s = s.replace(/^[^/@]*@/, '') // user
  }
  s = s
    .replace(/:\d+(?=\/)/, '') // port
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+/g, '/')
    .toLowerCase()
  if (!/^[a-z0-9.-]+\/[^\s]+$/.test(s) || s.length > 300 || s.includes('..')) return null
  return s
}

export async function listRepos(ctx: Ctx, slug: string) {
  const { brain } = await inBrain(ctx, { slug })
  const rows = await ctx.db.query(
    'SELECT url_key, created_at FROM repo_links WHERE brain_id = $1 ORDER BY url_key',
    [brain.id],
  )
  return rows.map((r) => ({ repo: String(r.url_key), linkedAt: (r.created_at as Date).toISOString() }))
}

async function asCurator(ctx: Ctx, slug: string) {
  inWeb(ctx, 'Linking repositories')
  const { brain, role } = await inBrain(ctx, { slug })
  if (!atLeast(role, 'curator')) {
    throw invalid(`Only curators of "${slug}" link repositories to it.`, 'Ask a curator of the brain.')
  }
  return brain
}

export async function linkRepo(ctx: Ctx, slug: string, url: unknown) {
  const brain = await asCurator(ctx, slug)
  const key = repoKey(url)
  if (!key) {
    throw invalid(
      'That is not a repository address.',
      'Give its remote, such as https://github.com/org/repo.',
    )
  }
  const taken = await ctx.db.one<{ brain_id: string }>('SELECT brain_id FROM repo_links WHERE url_key = $1', [
    key,
  ])
  if (taken && taken.brain_id !== brain.id) {
    throw conflict(
      'repo_linked',
      `${key} is already linked to another brain.`,
      'A repository points to one brain; ask that brain’s curators to unlink it first.',
    )
  }
  if (!taken) {
    await ctx.db.query(
      'INSERT INTO repo_links (url_key, brain_id, added_by, created_at) VALUES ($1, $2, $3, $4)',
      [key, brain.id, ctx.who.accountId, ctx.clock()],
    )
    await ok(ctx, 'repo.link', brain.id, key)
  }
  return { repo: key }
}

export async function unlinkRepo(ctx: Ctx, slug: string, url: unknown) {
  const brain = await asCurator(ctx, slug)
  const key = repoKey(url)
  const r = key
    ? await ctx.db.one('DELETE FROM repo_links WHERE url_key = $1 AND brain_id = $2 RETURNING url_key', [
        key,
        brain.id,
      ])
    : undefined
  if (!r) throw notFound('linked repository')
  await ok(ctx, 'repo.unlink', brain.id, key ?? '')
}

const HOW_TO_LINK =
  'A curator can link this repository to a brain in the Brain web (the brain’s settings, Repositories); until then, name the brain in each call.'

// Which brain is this repository's: the first address linked to a brain the key can see.
export async function resolveRepo(ctx: Ctx, repos: unknown) {
  const list = Array.isArray(repos) ? repos : repos === undefined ? [] : [repos]
  if (list.length === 0 || list.length > 20) {
    throw invalid(
      'Give 1 to 20 repository addresses ("repos").',
      'Pass the remote of the repository you work in, such as the output of "git remote get-url origin".',
    )
  }
  const keys = list.map(repoKey).filter((k): k is string => k !== null)
  for (const key of keys) {
    const row = await ctx.db.one<{ brain_id: string }>('SELECT brain_id FROM repo_links WHERE url_key = $1', [
      key,
    ])
    if (!row) continue
    const role = await roleIn(ctx.db, ctx.who, row.brain_id)
    if (!role) continue
    const b = await ctx.db.one('SELECT slug, name, purpose FROM brains WHERE id = $1', [row.brain_id])
    if (!b) throw brainNotFound()
    return {
      brain: { slug: String(b.slug), name: String(b.name), purpose: String(b.purpose), role },
      repo: key,
    }
  }
  const candidates = (await listBrains(ctx)).map((b) => ({
    slug: b.slug,
    name: b.name,
    purpose: b.purpose,
    role: b.role,
  }))
  return {
    brain: null,
    repos: keys,
    message: 'No brain you can use is linked to this repository.',
    howToProceed: HOW_TO_LINK,
    candidates,
  }
}
