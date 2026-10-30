// «Connect your agent» (spec B6, B5 «Kit de conexión»): the commands of each agent for this
// installation, from the server's kit (GET /v1/connect), built from its public address, never from the
// address the browser is on. The standard sign-in needs no token; the check says how to see it works.
import { useState } from 'preact/hooks'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { T } from '../text.ts'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { ErrorState, Skeleton } from '../ui/states.tsx'
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
          <p class="how">{T.connect.otherToken}</p>
        </>
      )}
      {a ? (
        <div class="check">
          <h3>{T.connect.check}</h3>
          <p>{a.check}</p>
        </div>
      ) : null}
    </>
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
