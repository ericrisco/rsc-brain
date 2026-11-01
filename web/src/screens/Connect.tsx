// «Connect your agent» (spec B6, B5 «Kit de conexión», plan T043). Who: anyone signed in, often someone
// who just accepted an invitation. Job: get their agent talking to rsc-brain. Done when: the live check of
// that agent is green. Risk: a token that leaks — it is made only on request, held in this screen's memory,
// shown once, and gone when the person says it is copied, leaves, or the page goes to the back/forward
// cache; it never goes on a command line (the kit pastes it at a hidden prompt).
//
// One tab per agent of the kit (GET /v1/connect, built from the installation's public address). The standard
// connection leads (no token to keep); the token connection is the alternative. Each tab keeps its own
// token and its own live check (lib/connect.ts), so a second agent is checked on its own.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { invalidate, resource } from '../api/resource.ts'
import {
  type AgentCheck,
  afterPoll,
  CHECK_EVERY_MS,
  expire,
  fillToken,
  type KitBlock,
  shouldPoll,
  startCheck,
  tipsDue,
  toAsk,
} from '../lib/connect.ts'
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
  tokenEnv: string
  signIn: { note: string; blocks: KitBlock[] } | null
  token: { note: string; blocks: KitBlock[] }
  reminder: { kind: 'hooks' | 'instructions'; note: string; prompt?: string; blocks: KitBlock[] } | null
  check: string
}
type Kit = { mcpUrl: string; tokenPlaceholder: string; agents: Agent[] }
type Made = { token: { id: string; secret: string; expiresAt: string }; note?: string }
// What one agent's tab holds: its token (only while shown), whether it was hidden, and its check.
type Tab = { made: Made | null; hidden: boolean; check: AgentCheck; error: ApiError | null; pending: boolean }

const kitResource = (brain: string | null) =>
  resource<Kit>(`connect:${brain ?? ''}`, () => api.call<Kit>('connect', { query: brain ? { brain } : {} }))

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// The consent page of the standard sign-in starts from the brain this page names (a hint, not a grant: the
// person still chooses there). Left only when the person copies the standard command, the step that leads to
// that page; never on loading this one. Path /oauth only; gone in an hour.
function hintConsent(slug: string | null) {
  // biome-ignore lint/suspicious/noDocumentCookie: the one cookie API every browser has; the value is an escaped slug
  document.cookie = slug
    ? `rscb_connect=${encodeURIComponent(slug)}; Path=/oauth; Max-Age=3600; SameSite=Lax`
    : 'rscb_connect=; Path=/oauth; Max-Age=0; SameSite=Lax'
}

// Asks the server for the current tab while its check waits, the tab is shown and the browser online. A
// request still in flight when the tab changes or the screen goes changes nothing.
function usePoll(agent: string | null, check: AgentCheck | null, update: (c: AgentCheck) => void) {
  const [problem, setProblem] = useState<ApiError | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const current = useRef(check)
  current.current = check
  useEffect(() => {
    if (!agent || !check || check.kind !== 'waiting') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const c = current.current
      if (stopped || !c) return
      setNow(Date.now())
      // Ten minutes stop the check whatever happened meanwhile (answers, failures, a hidden tab).
      const late = expire(c, Date.now())
      if (late !== c) {
        update(late)
        return
      }
      if (shouldPoll(c, { hidden: document.hidden, online: online.value })) {
        try {
          const ask = toAsk({ tokenId: c.tokenId, knownApps: c.knownApps })
          const [tokens, apps] = await Promise.all([
            ask.includes('tokens')
              ? api.call<{
                  tokens: Array<{ id: string; lastUsedAt: string | null; lastClient: string | null }>
                }>('tokens')
              : Promise.resolve(undefined),
            api.call<{
              apps: Array<{ id: string; name: string; lastUsedAt: string; lastRequestAt: string | null }>
              now?: string
            }>('apps'),
          ])
          if (stopped) return
          setProblem(null)
          const next = afterPoll(c, { tokens: tokens?.tokens, apps: apps.apps, now: apps.now }, Date.now())
          if (next.kind === 'connected') invalidate('profile:')
          update(next)
          if (next.kind !== 'waiting') return
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
  }, [agent, check?.since, check?.kind])
  return { problem, now }
}

function CheckWord({ check }: { check: AgentCheck }) {
  const c = T.connect
  if (check.kind === 'connected')
    return (
      <span class="check-word ok">
        <span class="check-dot" aria-hidden="true" />
        {c.connected}
      </span>
    )
  if (check.kind === 'stopped') return <span class="check-word">{c.stopped}</span>
  if (!online.value) return <span class="check-word">{c.paused}</span>
  return (
    <span class="check-word">
      <span class="check-dot waiting" aria-hidden="true" />
      {c.waiting}
    </span>
  )
}

function LiveCheck({
  agent,
  check,
  problem,
  now,
  onAgain,
}: {
  agent: Agent
  check: AgentCheck
  problem: ApiError | null
  now: number
  onAgain: () => void
}) {
  const c = T.connect
  return (
    <section class="live-check" aria-labelledby="live-title">
      <h2 id="live-title" class="section-title live-title">
        {c.liveTitle}
      </h2>
      <div role="status" aria-live="polite">
        <div
          class={`check-state${check.kind === 'connected' ? ' ok' : ''}`}
          data-check={online.value || check.kind !== 'waiting' ? check.kind : 'offline'}
        >
          <p class="live-line">
            <span class="sr-only">{c.liveFor(agent.name)}: </span>
            <CheckWord check={check} />
          </p>
          {check.kind === 'connected' && check.found ? (
            <>
              <p>{c.reached(check.found.client, clock(check.found.at))}</p>
              <p class="muted">{c.connectedNext}</p>
            </>
          ) : check.kind === 'waiting' && online.value ? (
            <>
              <p class="muted">{c.waitingLead}</p>
              {problem ? <p class="problem">{c.failed(problem.message)}</p> : null}
            </>
          ) : null}
        </div>
      </div>
      {check.kind === 'stopped' ? (
        <div class="actions">
          <Button onClick={onAgain}>{c.checkAgain}</Button>
        </div>
      ) : null}
      {tipsDue(check, now) ? (
        <div class="tips">
          <p>{c.tipsTitle}</p>
          <ul class="tips-list">
            <li>{c.tipRestart}</li>
            <li>{c.tipList[agent.id] ?? c.tipList.other}</li>
            <li>{c.tipVariable(agent.tokenEnv)}</li>
          </ul>
        </div>
      ) : null}
    </section>
  )
}

// The same check, short, beside the configuration: at 320 px the one above is out of sight while configuring.
function MiniCheck({ agent, check }: { agent: Agent; check: AgentCheck }) {
  return (
    <p class="check-mini" data-check-mini={check.kind}>
      <span class="muted">{T.connect.liveFor(agent.name)}: </span>
      <CheckWord check={check} />
    </p>
  )
}

// Tabs with a roving keyboard: Tab enters the selected one; the arrows, Home and End move and select.
function AgentTabs({ agents, at, onPick }: { agents: Agent[]; at: string; onPick: (id: string) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const move = (e: KeyboardEvent) => {
    const i = agents.findIndex((a) => a.id === at)
    const last = agents.length - 1
    const keys: Record<string, number> = {
      ArrowRight: i === last ? 0 : i + 1,
      ArrowLeft: i === 0 ? last : i - 1,
      Home: 0,
      End: last,
    }
    const to = keys[e.key]
    if (to === undefined) return
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
  tab,
  onCreate,
  onDone,
}: {
  agent: Agent
  brain: { slug: string; name: string } | null
  placeholder: string
  tab: Tab
  onCreate: () => void
  onDone: () => void
}) {
  const c = T.connect
  const said = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (tab.made) document.getElementById('copy-new-token')?.focus()
  }, [tab.made])
  useEffect(() => {
    if (tab.hidden) said.current?.focus()
  }, [tab.hidden])
  const made = tab.made
  return (
    <section class="kit-part" aria-labelledby={`token-${agent.id}`}>
      <h3 id={`token-${agent.id}`} class="part-title">
        {c.token}
      </h3>
      <p class="muted">{c.tokenLead(brain?.name ?? null)}</p>
      <p class="how">{c.tokenSafe}</p>
      <FormAlert error={tab.error} />
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
          <MiniCheck agent={agent} check={tab.check} />
          <div class="actions">
            <Button kind="primary" onClick={onDone}>
              {c.done}
            </Button>
          </div>
        </section>
      ) : (
        <>
          {tab.hidden ? (
            <p class="said" tabIndex={-1} ref={said}>
              {c.hidden} <a href="/profile/tokens">{c.profileLink}</a>.
            </p>
          ) : null}
          <div class="actions">
            <Button
              pending={tab.pending}
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

function Panel({
  agent,
  kit,
  tab,
  slug,
  children,
}: {
  agent: Agent
  kit: Kit
  tab: Tab
  slug: string | null
  children: ComponentChildren
}) {
  const c = T.connect
  return (
    <div class="agent-panel" role="tabpanel" id={`panel-${agent.id}`} aria-labelledby={`tab-${agent.id}`}>
      <MiniCheck agent={agent} check={tab.check} />
      <section class="kit-part" aria-labelledby={`standard-${agent.id}`}>
        <h3 id={`standard-${agent.id}`} class="part-title">
          {c.standard} {agent.signIn ? <span class="tag ok">{c.recommended}</span> : null}
        </h3>
        {agent.signIn ? (
          <>
            <p class="muted">{c.standardLead}</p>
            {agent.signIn.blocks.map((b) => (
              <CommandBlock key={b.title} block={b} onCopy={() => hintConsent(slug)} />
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

const freshTab = (agent: string): Tab => ({
  made: null,
  hidden: false,
  check: startCheck(Date.now(), null, agent),
  error: null,
  pending: false,
})

function ConnectFor({ slug }: { slug: string | null }) {
  const c = T.connect
  const r = kitResource(slug)
  const brains = brainsResource().data.value?.brains
  const brain = slug ? { slug, name: brains?.find((b) => b.slug === slug)?.name ?? slug } : null
  const [at, setAt] = useState('claude-code')
  const [tabs, setTabs] = useState<Record<string, Tab>>({})
  const kit = r.data.value
  const agent = kit?.agents.find((a) => a.id === at) ?? kit?.agents[0]
  const tab = agent ? (tabs[agent.id] ?? null) : null
  const patch = (id: string, f: (t: Tab) => Tab) =>
    setTabs((all) => ({ ...all, [id]: f(all[id] ?? freshTab(id)) }))
  // A tab's check starts when it is first shown.
  useEffect(() => {
    if (agent && !tabs[agent.id])
      setTabs((all) => (all[agent.id] ? all : { ...all, [agent.id]: freshTab(agent.id) }))
  }, [agent?.id])
  // Put in the back/forward cache, the page forgets every token it shows.
  useEffect(() => {
    const forget = () =>
      setTabs((all) => Object.fromEntries(Object.entries(all).map(([k, t]) => [k, { ...t, made: null }])))
    window.addEventListener('pagehide', forget)
    return () => window.removeEventListener('pagehide', forget)
  }, [])
  const poll = usePoll(agent?.id ?? null, tab?.check ?? null, (check) => {
    if (agent) patch(agent.id, (t) => (t.check.since === check.since ? { ...t, check } : t))
  })

  const create = async () => {
    if (!agent || !tab || tab.pending || !online.value) return
    const id = agent.id
    patch(id, (t) => ({ ...t, pending: true, error: null, hidden: false }))
    try {
      const m = await api.call<Made>('createToken', {
        body: {
          name: c.tokenName(agent.name),
          perm: 'write',
          days: 90,
          ...(slug ? { brains: [slug] } : { allBrains: true }),
        },
      })
      // A new token: this tab's check starts again, waiting for this token.
      patch(id, (t) => ({ ...t, made: m, pending: false, check: startCheck(Date.now(), m.token.id, id) }))
      invalidate('profile:tokens')
    } catch (e) {
      patch(id, (t) => ({ ...t, pending: false, error: e as ApiError }))
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
      {!kit || !agent ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : (
        <>
          {tab ? (
            <LiveCheck
              agent={agent}
              check={tab.check}
              problem={poll.problem}
              now={poll.now}
              onAgain={() =>
                patch(agent.id, (t) => ({ ...t, check: startCheck(Date.now(), t.check.tokenId, agent.id) }))
              }
            />
          ) : null}
          <AgentTabs agents={kit.agents} at={agent.id} onPick={setAt} />
          {tab ? (
            <Panel key={agent.id} agent={agent} kit={kit} tab={tab} slug={slug}>
              <TokenConnection
                agent={agent}
                brain={brain}
                placeholder={kit.tokenPlaceholder}
                tab={tab}
                onCreate={() => void create()}
                onDone={() => patch(agent.id, (t) => ({ ...t, made: null, hidden: true }))}
              />
            </Panel>
          ) : null}
        </>
      )}
    </div>
  )
}
