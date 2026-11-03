import { createBrain, deleteBrain, setArchived } from '../../domain/brains.ts'
import type { Ctx } from '../../domain/context.ts'
import { brainOverview, getBrainWithStats, listBrainsWithStats } from '../../domain/overview.ts'
import { linkRepo, listRepos, resolveRepo, unlinkRepo } from '../../domain/repos.ts'
import { serviceInvite } from '../../domain/service-invite.ts'
import { compact, obj, reqStr, str } from '../input.ts'
import { type Req, type Route, route } from '../router.ts'

export const ctxOf = (r: Req): Ctx => ({
  db: r.db,
  root: r.db,
  clock: r.clock,
  who: r.who,
  tz: r.tz,
  meaning: r.meaning,
  mail: r.mail,
  log: r.log,
})

export const brainRoutes: Route[] = [
  route('GET /v1/brains', async (r) => ({ body: { brains: await listBrainsWithStats(ctxOf(r)) } })),
  route('POST /v1/brains', async (r) => {
    const b = obj(r.body)
    const input = {
      slug: reqStr(b, 'slug', 64),
      name: str(b, 'name', { max: 80 }) ?? '',
      description: str(b, 'description', { max: 2000 }),
      purpose: str(b, 'purpose', { max: 1000 }),
      firstCurator: str(b, 'firstCurator', { max: 200 }),
    }
    return {
      status: 201,
      body: { brain: await createBrain(ctxOf(r), compact(input), r.serviceInvitesPerHour) },
    }
  }),
  route('GET /v1/brains/:slug', async (r) => ({
    body: { brain: await getBrainWithStats(ctxOf(r), r.params.slug as string) },
  })),
  route('GET /v1/brains/:slug/overview', async (r) => ({
    body: await brainOverview(ctxOf(r), r.params.slug as string),
  })),
  route('POST /v1/brains/:slug/archive', async (r) => ({
    body: { brain: await setArchived(ctxOf(r), r.params.slug as string, true) },
  })),
  route('POST /v1/brains/:slug/unarchive', async (r) => ({
    body: { brain: await setArchived(ctxOf(r), r.params.slug as string, false) },
  })),
  // A service account brings people into a brain it created (plan rsc-factory-brain §3.1, spec C6).
  route('POST /v1/brains/:slug/invitations', async (r) => ({
    status: 201,
    body: await serviceInvite(
      ctxOf(r),
      r.params.slug as string,
      { people: obj(r.body).people },
      r.serviceInvitesPerHour,
    ),
  })),
  route('GET /v1/brains/:slug/repos', async (r) => ({
    body: { repos: await listRepos(ctxOf(r), r.params.slug as string) },
  })),
  route('POST /v1/brains/:slug/repos', async (r) => ({
    status: 201,
    body: await linkRepo(ctxOf(r), r.params.slug as string, obj(r.body).repo),
  })),
  route('DELETE /v1/brains/:slug/repos', async (r) => {
    await unlinkRepo(ctxOf(r), r.params.slug as string, obj(r.body).repo)
    return { body: { unlinked: true } }
  }),
  // It only looks the repositories up: the maintenance gate lets it through.
  {
    ...route('POST /v1/resolve', async (r) => ({ body: await resolveRepo(ctxOf(r), obj(r.body).repos) })),
    maintenance: 'reads',
  },
  route('DELETE /v1/brains/:slug', async (r) => {
    await deleteBrain(ctxOf(r), r.params.slug as string, str(obj(r.body), 'confirm') ?? '')
    return { body: { deleted: r.params.slug } }
  }),
]
