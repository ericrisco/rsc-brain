// «Connect your agent» (spec B6, B5 «Kit de conexión», plan T043). Who: anyone signed in, often someone
// who just accepted an invitation. Job: get their agent talking to rsc-brain. Done when: the live check is
// green. Risk: a token that leaks — it is made here only on request, held in this screen's memory, shown
// once with the configuration filled in, and gone when the person says it is copied or leaves.
//
// One tab per agent of the kit (GET /v1/connect, built from the installation's public address): the
// standard connection, the token connection, the optional reminder and how to check it works. The live
// check asks every 2 seconds (lib/connect.ts says why a poll and not the event stream).
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import { CHECK_EVERY_MS, type Check, checkOf, fillToken, type KitBlock, toAsk } from '../lib/connect.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CommandBlock } from '../ui/CommandBlock.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'
import { brainsResource } from './Home.tsx'

type Agent = {
  id: string
  name: string
  signIn: { note: string; blocks: KitBlock[] } | null
  token: { note: string; blocks: KitBlock[] }
  reminder: { kind: 'hooks' | 'instructions'; note: string; prompt?: string; blocks: KitBlock[] } | null
  check: string
}
type Kit = { mcpUrl: string; tokenPlaceholder: string; agents: Agent[] }
type Made = { token: { id: string; secret: string; expiresAt: string }; note?: string }

const kitResource = (brain: string | null) =>
  resource<Kit>(`connect:${brain ?? ''}`, () => api.call<Kit>('connect', { query: brain ? { brain } : {} }))

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// The live check: asks the server every 2 seconds until the agent's first request arrives. It never asks
// while the tab is hidden or the browser is offline, and a request still in flight when the screen goes
// changes nothing.
function useLiveCheck(tokenId: string | null): { check: Check; problem: ApiError | null } {
  const [check, setCheck] = useState<Check>({ kind: 'waiting' })
  const [problem, setProblem] = useState<ApiError | null>(null)
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (check.kind === 'connected') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (stopped) return
      if (!document.hidden && online.value) {
        try {
          const ask = toAsk({ tokenId, knownApps: known.current })
          const [tokens, apps] = await Promise.all([
            ask.includes('tokens')
              ? api.call<{
                  tokens: Array<{ id: string; lastUsedAt: string | null; lastClient: string | null }>
                }>('tokens')
              : Promise.resolve(undefined),
            api.call<{ apps: Array<{ id: string; name: string; lastUsedAt: string }> }>('apps'),
          ])
          if (stopped) return
          // The first answer says which apps were connected before: they do not count.
          known.current ??= new Set(apps.apps.map((a) => a.id))
          setProblem(null)
          const c = checkOf({ tokenId, knownApps: known.current, tokens: tokens?.tokens, apps: apps.apps })
          if (c.kind === 'connected') {
            // The profile lists them with their last use now.
            invalidate('profile:')
            setCheck(c)
            return
          }
        } catch (e) {
          if (stopped) return
          setProblem(e as ApiError)
        }
      }
      timer = setTimeout(() => void tick(), CHECK_EVERY_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [tokenId, check.kind])
  return { check, problem }
}

function LiveCheck({ check, problem }: { check: Check; problem: ApiError | null }) {
  const c = T.connect
  return (
    <section class="live-check" aria-labelledby="live-title">
      <h2 id="live-title" class="section-title live-title">
        {c.liveTitle}
      </h2>
      <div role="status" aria-live="polite">
        {check.kind === 'connected' ? (
          <div class="check-state ok" data-check="connected">
            <p class="check-word">
              <span class="check-dot" aria-hidden="true" />
              {c.connected}
            </p>
            <p>{c.reached(check.client, clock(check.at))}</p>
            <p class="muted">{c.connectedNext}</p>
          </div>
        ) : !online.value ? (
          <div class="check-state" data-check="offline">
            <p class="check-word">{c.paused}</p>
          </div>
        ) : (
          <div class="check-state" data-check="waiting">
            <p class="check-word">
              <span class="check-dot waiting" aria-hidden="true" />
              {c.waiting}
            </p>
            <p class="muted">{c.waitingLead}</p>
            {problem ? <p class="problem">{c.failed(problem.message)}</p> : null}
          </div>
        )}
      </div>
    </section>
  )
}

// Tabs with a roving keyboard: Tab enters the selected one; the arrows, Home and End move and select.
function AgentTabs({ agents, at, onPick }: { agents: Agent[]; at: string; onPick: (id: string) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const move = (e: KeyboardEvent) => {
    const i = agents.findIndex((a) => a.id === at)
    const last = agents.length - 1
    const to =
      e.key === 'ArrowRight'
        ? i === last
          ? 0
          : i + 1
        : e.key === 'ArrowLeft'
          ? i === 0
            ? last
            : i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1
    if (to < 0) return
    e.preventDefault()
    const next = agents[to]
    if (!next) return
    onPick(next.id)
    list.current?.querySelector<HTMLElement>(`#tab-${next.id}`)?.focus()
  }
  return (
    <div class="agent-tabs" role="tablist" aria-label={T.connect.agent} ref={list} onKeyDown={move}>
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          role="tab"
          id={`tab-${a.id}`}
          aria-selected={a.id === at ? 'true' : 'false'}
          aria-controls={`panel-${a.id}`}
          tabIndex={a.id === at ? 0 : -1}
          onClick={() => onPick(a.id)}
        >
          {a.name}
        </button>
      ))}
    </div>
  )
}

function TokenConnection({
  agent,
  brain,
  placeholder,
  made,
  pending,
  error,
  hidden,
  onCreate,
  onDone,
}: {
  agent: Agent
  brain: { slug: string; name: string } | null
  placeholder: string
  made: Made | null
  pending: boolean
  error: ApiError | null
  hidden: boolean
  onCreate: () => void
  onDone: () => void
}) {
  const c = T.connect
  const said = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (made) document.getElementById('copy-new-token')?.focus()
  }, [made])
  useEffect(() => {
    if (hidden) said.current?.focus()
  }, [hidden])
  return (
    <section class="kit-part" aria-labelledby={`token-${agent.id}`}>
      <h3 id={`token-${agent.id}`} class="part-title">
        {c.token}
      </h3>
      <p class="muted">{c.tokenLead(brain?.name ?? null)}</p>
      <FormAlert error={error} />
      {made ? (
        <section class="once" aria-labelledby="once-title">
          <h4 id="once-title" class="part-title">
            {c.yourToken}
          </h4>
          <p>{c.tokenOnce}</p>
          <pre class="command">
            <code>{made.token.secret}</code>
          </pre>
          <p class="meta">{c.tokenUntil(T.date(made.token.expiresAt))}</p>
          {made.note ? <p class="meta">{made.note}</p> : null}
          <CopyButton text={made.token.secret} label={c.copyToken} id="copy-new-token" />
          <p class="how">{agent.token.note}</p>
          {fillToken(agent.token.blocks, placeholder, made.token.secret).map((b) => (
            <CommandBlock key={b.title} block={b} />
          ))}
          <div class="actions">
            <Button kind="primary" onClick={onDone}>
              {c.done}
            </Button>
          </div>
        </section>
      ) : (
        <>
          {hidden ? (
            <p class="said" tabIndex={-1} ref={said}>
              {c.hidden} <a href="/profile/tokens">{c.profileLink}</a>.
            </p>
          ) : null}
          <div class="actions">
            <Button
              pending={pending}
              pendingLabel={c.creatingToken}
              blocked={writeBlocked({ online: online.value, pending: false })}
              onClick={onCreate}
            >
              {c.createToken}
            </Button>
          </div>
          <p class="how">{agent.token.note}</p>
          {agent.token.blocks.map((b) => (
            <CommandBlock key={b.title} block={b} />
          ))}
        </>
      )}
    </section>
  )
}

function Panel({ agent, kit, children }: { agent: Agent; kit: Kit; children: ComponentChildren }) {
  const c = T.connect
  return (
    <div class="agent-panel" role="tabpanel" id={`panel-${agent.id}`} aria-labelledby={`tab-${agent.id}`}>
      <section class="kit-part" aria-labelledby={`standard-${agent.id}`}>
        <h3 id={`standard-${agent.id}`} class="part-title">
          {c.standard}
        </h3>
        {agent.signIn ? (
          <>
            <p class="muted">{c.standardLead}</p>
            {agent.signIn.blocks.map((b) => (
              <CommandBlock key={b.title} block={b} />
            ))}
            <p class="how">{agent.signIn.note}</p>
          </>
        ) : (
          <>
            <p class="muted">{c.noStandard}</p>
            <CommandBlock block={{ title: c.address, text: kit.mcpUrl }} />
          </>
        )}
      </section>
      {children}
      {agent.reminder ? (
        <section class="kit-part" aria-labelledby={`reminder-${agent.id}`}>
          <h3 id={`reminder-${agent.id}`} class="part-title">
            {c.reminder}
          </h3>
          <p class="how">{agent.reminder.note}</p>
          {agent.reminder.prompt ? <p class="meta">{c.reminderPrompt(agent.reminder.prompt)}</p> : null}
          {agent.reminder.blocks.map((b) => (
            <CommandBlock key={b.title} block={b} />
          ))}
        </section>
      ) : null}
      <section class="kit-part" aria-labelledby={`check-${agent.id}`}>
        <h3 id={`check-${agent.id}`} class="part-title">
          {c.check}
        </h3>
        <p>{agent.check}</p>
      </section>
    </div>
  )
}

export function Connect() {
  const { query } = useLocation()
  const slug = query.brain || null
  return <ConnectFor key={slug ?? ''} slug={slug} />
}

function ConnectFor({ slug }: { slug: string | null }) {
  const c = T.connect
  const r = kitResource(slug)
  const brains = brainsResource().data.value?.brains
  const brain = slug ? { slug, name: brains?.find((b) => b.slug === slug)?.name ?? slug } : null
  const [at, setAt] = useState('claude-code')
  const [made, setMade] = useState<Made | null>(null)
  const [tokenId, setTokenId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [hidden, setHidden] = useState(false)
  const live = useLiveCheck(tokenId)
  const kit = r.data.value
  const agent = kit?.agents.find((a) => a.id === at) ?? kit?.agents[0]

  const create = async () => {
    if (pending || !online.value || !agent) return
    setPending(true)
    setError(null)
    setHidden(false)
    try {
      const m = await api.call<Made>('createToken', {
        body: {
          name: c.tokenName(agent.name),
          perm: 'write',
          days: 90,
          ...(slug ? { brains: [slug] } : { allBrains: true }),
        },
      })
      setMade(m)
      setTokenId(m.token.id)
      invalidate('profile:tokens')
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }

  return (
    <div class="connect">
      <div class="title-row">
        <div class="title-group">
          <h1 class="title">{c.title}</h1>
        </div>
      </div>
      <p class="lead">{c.lead(brain?.name ?? null)}</p>
      {slug ? (
        <p class="meta">
          <a href="/connect">{c.allBrains}</a>
        </p>
      ) : null}
      <LiveCheck check={live.check} problem={live.problem} />
      {!kit || !agent ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : (
        <>
          <AgentTabs agents={kit.agents} at={agent.id} onPick={setAt} />
          <Panel agent={agent} kit={kit}>
            <TokenConnection
              agent={agent}
              brain={brain}
              placeholder={kit.tokenPlaceholder}
              made={made}
              pending={pending}
              error={error}
              hidden={hidden}
              onCreate={() => void create()}
              onDone={() => {
                setMade(null)
                setHidden(true)
              }}
            />
          </Panel>
        </>
      )}
    </div>
  )
}
