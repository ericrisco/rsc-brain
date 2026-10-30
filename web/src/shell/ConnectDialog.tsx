// «Connect your agent» (spec B6, B5 «Kit de conexión»): the commands of each agent for this
// installation, from the server's kit (GET /v1/connect), built from its public address, never from the
// address the browser is on. The standard sign-in needs no token; the check says how to see it works.
import { useEffect, useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { writeBlocked } from '../ui/state.ts'
import { ErrorState, FormAlert, Skeleton } from '../ui/states.tsx'
import { connectFor } from './dialogs.ts'

type Block = { title: string; text: string }
type Kit = {
  mcpUrl: string
  agents: Array<{
    id: string
    name: string
    signIn: { note: string; blocks: Block[] } | null
    check: string
  }>
}

const kitResource = (brain: string | null) =>
  resource<Kit>(`connect:${brain ?? ''}`, () => api.call<Kit>('connect', { query: brain ? { brain } : {} }))

export function CommandBlock({ block, copy = T.connect.copy }: { block: Block; copy?: string }) {
  return (
    <div class="cmd-block">
      <p class="cmd-title">{block.title}</p>
      <pre class="command">
        <code>{block.text}</code>
      </pre>
      <CopyButton text={block.text} label={copy} />
    </div>
  )
}

function Body({ brain }: { brain: string | null }) {
  const r = kitResource(brain)
  const [agent, setAgent] = useState('claude-code')
  const kit = r.data.value
  if (!kit) {
    return r.error.value ? (
      <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
    ) : (
      <Skeleton rows={2} />
    )
  }
  const a = kit.agents.find((x) => x.id === agent) ?? kit.agents[0]
  return (
    <>
      <p class="muted">{T.connect.lead}</p>
      <div class="field">
        <label for="connect-agent">{T.connect.agent}</label>
        <select id="connect-agent" value={a?.id} onChange={(e) => setAgent(e.currentTarget.value)}>
          {kit.agents.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      {a?.signIn ? (
        <>
          {a.signIn.blocks.map((b) => (
            <CommandBlock key={b.title} block={b} />
          ))}
          <p class="how">{a.signIn.note}</p>
        </>
      ) : (
        <>
          <p>{T.connect.otherLead}</p>
          <CommandBlock block={{ title: T.connect.address, text: kit.mcpUrl }} />
        </>
      )}
      <TokenInstead brain={brain} agent={a?.name ?? 'Agent'} />
      {a ? (
        <div class="check">
          <h3>{T.connect.check}</h3>
          <p>{a.check}</p>
        </div>
      ) : null}
    </>
  )
}

type Made = { token: { secret: string; expiresAt: string }; note?: string }

// For an agent that cannot use the browser sign-in: a personal token (B4), made here and shown once —
// held only by this dialog, never stored, gone when it closes. Listing and revoking tokens comes with
// the profile page.
function TokenInstead({ brain, agent }: { brain: string | null; agent: string }) {
  const c = T.connect
  const [made, setMade] = useState<Made | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => {
    if (made) document.getElementById('copy-token')?.focus()
  }, [made])
  const create = async () => {
    if (pending || !online.value) return
    setPending(true)
    setError(null)
    try {
      setMade(
        await api.call<Made>('createToken', {
          body: {
            name: c.tokenName(agent),
            perm: 'write',
            days: 90,
            ...(brain ? { brains: [brain] } : { allBrains: true }),
          },
        }),
      )
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <section class="token-instead" aria-labelledby="token-instead-title">
      <h3 id="token-instead-title">{c.tokenTitle}</h3>
      <p>{c.tokenLead}</p>
      <FormAlert error={error} />
      {made ? (
        <div class="cmd-block">
          <p class="cmd-title">{c.tokenFor(brain)}</p>
          <pre class="command">
            <code>{made.token.secret}</code>
          </pre>
          <p class="meta">
            {c.tokenOnce} {c.tokenUntil(T.date(made.token.expiresAt))}
          </p>
          {made.note ? <p class="meta">{made.note}</p> : null}
          <CopyButton text={made.token.secret} label={c.copyToken} id="copy-token" />
        </div>
      ) : (
        <Button
          pending={pending}
          pendingLabel={c.creatingToken}
          blocked={writeBlocked({ online: online.value, pending: false })}
          onClick={() => void create()}
        >
          {c.createToken}
        </Button>
      )}
      <p class="how">{c.tokenLater}</p>
    </section>
  )
}

export function ConnectDialog() {
  const at = connectFor.value
  return (
    <Dialog
      open={at !== null}
      title={T.connect.title}
      onClose={() => (connectFor.value = null)}
      class="wide-dialog"
    >
      {at ? <Body key={at.brain ?? ''} brain={at.brain} /> : null}
    </Dialog>
  )
}
