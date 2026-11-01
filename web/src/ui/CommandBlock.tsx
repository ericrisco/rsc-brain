// A command or a configuration to copy, with what it is and where it goes: the connection kit (B5) as the
// web shows it.
import { T } from '../text.ts'
import { CopyButton } from './CopyButton.tsx'

export type Block = { title: string; text: string; where?: string }

// A file it goes in (".mcp.json", "~/.codex/config.toml"), as opposed to the terminal or a client's own box.
const isFile = (where: string | undefined) => Boolean(where && /[./]/.test(where))

export function CommandBlock({ block, copy = T.connect.copy }: { block: Block; copy?: string }) {
  return (
    <div class="cmd-block">
      <p class="cmd-title">
        {block.title}
        {isFile(block.where) ? (
          <>
            {' '}
            <span class="tag mono">{block.where}</span>
          </>
        ) : null}
      </p>
      <pre class="command">
        <code>{block.text}</code>
      </pre>
      <CopyButton text={block.text} label={copy} />
    </div>
  )
}
