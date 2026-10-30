// A brain, the first version: its name, role and purpose (the Overview with numbers, sessions and first
// steps arrives with G8 in PR18). A brain the person cannot read answers like one that does not exist,
// and says who to ask (constitution Brain P4, general P6).
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { viewState } from '../ui/state.ts'
import { ErrorState, Skeleton } from '../ui/states.tsx'
import type { BrainRow } from './Home.tsx'

export type BrainOne = BrainRow & { description: string }

export const brainResource = (slug: string) =>
  resource<{ brain: BrainOne }>(`brain:${slug}:basic`, () =>
    api.call<{ brain: BrainOne }>('brain', { path: { slug } }),
  )

export function Brain({ slug }: { slug: string }) {
  const r = brainResource(slug)
  const state = viewState({
    loading: r.loading.value,
    data: r.data.value,
    error: r.error.value,
    online: online.value,
  })
  const b = r.data.value?.brain
  if (state === 'loading') return <Skeleton rows={2} />
  if (!b) return r.error.value ? <ErrorState error={r.error.value} onRetry={() => void r.reload()} /> : null
  return (
    <>
      <div class="title-row start">
        <h1 class="title">{b.name}</h1>
        <span class="tag">{b.role}</span>
      </div>
      <dl class="facts">
        <dt>{T.brain.purpose}</dt>
        <dd>{b.purpose || <span class="muted">{T.brain.noPurpose}</span>}</dd>
        {b.description ? (
          <>
            <dt>About</dt>
            <dd>{b.description}</dd>
          </>
        ) : null}
        <dt>Address</dt>
        <dd class="mono">{b.slug}</dd>
      </dl>
    </>
  )
}
