// Repositories linked to a brain (spec B5 «brain_resolve»): curators link the repositories a brain is
// about; an agent working in one asks which brain is its. A repository may be linked to several
// brains (each team links its own); a key is only told about the ones it can see.
import { atLeast, type Role } from '../auth/can.ts'
import { roleIn } from '../auth/principal.ts'
import { denied, invalid, notFound } from '../core/errors.ts'
import { listBrains } from './brains.ts'
import { type Ctx, inBrain, ok } from './context.ts'
import { inWeb } from './guards.ts'

// The port of a server tells servers on one host apart; the usual port of the scheme says nothing.
const USUAL: Record<string, string> = {
  ssh: '22',
  'git+ssh': '22',
  'ssh+git': '22',
  https: '443',
  http: '80',
  git: '9418',
}

// A repository address as people and tools write it, reduced to host (and an unusual port) and path:
// "https://user@github.com/Org/Repo.git", "git@github.com:org/repo" and "ssh://git@github.com:22/org/repo/"
// are all "github.com/org/repo".
export function repoKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (!s || s.length > 500) return null
  // A relative path is a folder, not an address.
  if (s.startsWith('.')) return null
  // Without a scheme nor a user (git@…), the first part must name a host: "org/repo" names none.
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^[^/@\s]+@/.test(s)
  if (bare && !/^(localhost|[^/:]*\.[^/:]*)(:\d+)?\//i.test(s)) return null
  let scheme = 'ssh'
  // git@host:path has no port: in "git@host:2024/app", 2024 is the owner.
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(s)
  if (scp) s = `${scp[1]}/${scp[2]}`
  else {
    scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase() ?? 'https'
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    s = s.replace(/^[^/@]*@/, '') // user
  }
  s = s
    .replace(/:(\d+)(?=\/)/, (_, port: string) => (port === USUAL[scheme] ? '' : `:${port}`))
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+/g, '/')
    .toLowerCase()
  if (!/^[a-z0-9][a-z0-9.-]*(:\d+)?\/\S+$/.test(s) || s.length > 300 || s.includes('..')) return null
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

// An archived brain is read-only: no new link (agents could not write to it anyway). Unlinking stays.
const ARCHIVED_LINK = () =>
  denied(
    'This brain is archived, so no repository can be linked to it.',
    'A curator of the brain can unarchive it first.',
  )

export async function linkRepo(ctx: Ctx, slug: string, url: unknown) {
  const brain = await asCurator(ctx, slug)
  if (brain.status === 'archived') throw ARCHIVED_LINK()
  const key = repoKey(url)
  if (!key) {
    throw invalid(
      'That is not a repository address.',
      'Use the full address, e.g. github.com/org/repo (or the output of "git remote get-url origin").',
    )
  }
  // Linking is per brain: what other brains link is never shown, nor in the way.
  const added = await ctx.db.one(
    `INSERT INTO repo_links (url_key, brain_id, added_by, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (url_key, brain_id) DO NOTHING RETURNING url_key`,
    [key, brain.id, ctx.who.accountId, ctx.clock()],
  )
  if (added) await ok(ctx, 'repo.link', brain.id, key)
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

async function workedIn(ctx: Ctx, slug: string) {
  const r = await ctx.db.one(
    `SELECT 1 FROM brains b WHERE b.slug = $1 AND (
       EXISTS (SELECT 1 FROM entries e WHERE e.brain_id = b.id AND e.author_id = $2)
       OR EXISTS (SELECT 1 FROM sessions s WHERE s.brain_id = b.id AND s.account_id = $2))`,
    [slug, ctx.who.accountId],
  )
  return Boolean(r)
}

const HOW_TO_LINK =
  'A curator can link this repository to a brain in the rsc-brain web (the brain’s settings, Repositories); until then, name the brain in each call.'

// Which brain is this repository's: the brains linked to the first address that has any the key can
// see. One is the answer; several are listed for the agent to choose. A folder on the agent's machine
// is not something the server can read.
export async function resolveRepo(ctx: Ctx, repos: unknown) {
  const list = Array.isArray(repos) ? repos : repos === undefined ? [] : [repos]
  if (list.length === 0 || list.length > 20 || list.some((x) => typeof x !== 'string')) {
    throw invalid(
      'Give 1 to 20 repository addresses ("repos").',
      'Pass the remote of the repository you work in, such as the output of "git remote get-url origin".',
    )
  }
  if (list.every((x) => /^(\/|~|[a-z]:\\|\.)/i.test(String(x).trim()))) {
    throw invalid(
      'That is a folder on your machine; rsc-brain can only match repository addresses.',
      'Run "git remote get-url origin" in that folder and pass its output.',
    )
  }
  const keys = list.map(repoKey).filter((k): k is string => k !== null)
  for (const key of keys) {
    const rows = await ctx.db.query('SELECT brain_id FROM repo_links WHERE url_key = $1', [key])
    const seen: Array<{ slug: string; name: string; purpose: string; role: string }> = []
    for (const row of rows) {
      const role = await roleIn(ctx.db, ctx.who, String(row.brain_id))
      if (!role) continue
      const b = await ctx.db.one('SELECT slug, name, purpose FROM brains WHERE id = $1', [row.brain_id])
      if (b) seen.push({ slug: String(b.slug), name: String(b.name), purpose: String(b.purpose), role })
    }
    seen.sort((x, y) => x.slug.localeCompare(y.slug))
    // Anyone who curates a brain can add a person to it and link that person's repository. So a brain
    // is chosen alone only when it is already the person's: they curate it, or they have worked in it.
    // The first time, the person chooses.
    const only = seen.length === 1 ? seen[0] : undefined
    if (only && (atLeast(only.role as Role, 'curator') || (await workedIn(ctx, only.slug)))) {
      return { brain: only, repo: key }
    }
    if (only) {
      return {
        brain: null,
        repo: key,
        brains: seen,
        message: `This repository is linked to "${only.slug}", a brain you have not worked in yet.`,
        howToProceed:
          'Ask the person whether to use it. If they agree, pass it as "brain" in your calls; after the first entry it is chosen alone.',
      }
    }
    if (seen.length > 1) {
      return {
        brain: null,
        repo: key,
        brains: seen,
        message: 'Several of your brains are linked to this repository.',
        howToProceed: 'Ask the person which one, and pass it as "brain" in your calls.',
      }
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
