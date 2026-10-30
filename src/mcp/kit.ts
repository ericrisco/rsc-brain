// The connection kit (spec B5 «El kit de conexión»): for each agent, how to connect with the standard
// sign-in (only the address), how to connect with a token, the optional reminder, and how to check it
// works. The web page «connect your agent» (B6) shows it and fills the token placeholder once, when
// the person creates a token there; the server never puts a secret in the kit.
//
// Config files read the token from the environment (RSC_BRAIN_TOKEN), so a file shared in a
// repository never holds it; only the line that sets the variable carries the placeholder.
import { SAFE_URL } from '../core/urls.ts'

export const TOKEN_ENV = 'RSC_BRAIN_TOKEN'
export const TOKEN_PLACEHOLDER = '<paste-your-token>'
export const TOKEN_FILE = '~/.config/rsc-brain/token'
export const SERVER_NAME = 'rsc-brain'
export const AGENT_IDS = ['claude-code', 'codex', 'opencode', 'cursor', 'other'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export type Block = {
  title: string
  // Where it goes: a file, "terminal", or "mcpServers" (the usual block of a local MCP client).
  where: string
  format: 'shell' | 'json' | 'toml' | 'text'
  text: string
}

export type AgentKit = {
  id: AgentId
  name: string
  signIn: { note: string; blocks: Block[] } | null
  token: { note: string; blocks: Block[] }
  reminder:
    | { kind: 'hooks'; note: string; blocks: Block[] }
    | { kind: 'instructions'; note: string; prompt: string; blocks: Block[] }
    | null
  check: string
}

export type Kit = {
  mcpUrl: string
  tokenEnv: string
  tokenPlaceholder: string
  agents: AgentKit[]
}

const json = (v: unknown) => JSON.stringify(v, null, 2)

// Sets the variable the config files read. The only block with the placeholder for most agents.
const exportToken: Block = {
  title: 'Put the token in your environment (your shell profile, for example ~/.zshrc)',
  where: 'terminal',
  format: 'shell',
  text: `export ${TOKEN_ENV}="${TOKEN_PLACEHOLDER}"`,
}

// The token in a file only you can read, for the bridge and the hooks of agents that do not pass your
// shell environment to the programs they start.
const tokenFile: Block = {
  title: 'Keep the token in a file only you can read',
  where: 'terminal',
  format: 'shell',
  text: `mkdir -p ~/.config/rsc-brain && (umask 077 && printf '%s\\n' '${TOKEN_PLACEHOLDER}' > ${TOKEN_FILE})`,
}

// What to tell agents without hooks, for their instructions file (spec B5 clarification: the
// reminder is an invocable prompt plus this text).
const INSTRUCTIONS_TEXT = (brain: string | null) =>
  [
    '## RSC Brain',
    '',
    `- At the start of a task, call brain_resolve with the output of \`git remote get-url origin\`${brain ? ` (or use the brain "${brain}")` : ''}, then mem_context.`,
    '- Search with mem_search before you decide. Save decisions, discoveries and corrections with mem_save as you work.',
    '- Before you finish, close your brain session with mem_session_summary: goal, done, discovered, decided, pending.',
  ].join('\n')

export function connectKit(o: { mcpUrl: string; brain: string | null; agent?: AgentId }): Kit {
  // Never a character a shell would read: the address goes into commands people paste and into hooks
  // that run on every session. The installation refuses such an address; this is the second lock.
  if (!SAFE_URL.test(o.mcpUrl)) throw new Error('The public address holds characters a shell would read.')
  const url = o.mcpUrl
  const check = `Ask your agent: "What does this brain know about X?"${
    o.brain ? ` It should answer from the brain "${o.brain}".` : ''
  }`
  const hookArgs = `--url ${url}`
  const instructions = (
    where: string,
  ): { kind: 'instructions'; note: string; prompt: string; blocks: Block[] } => ({
    kind: 'instructions',
    note: 'This agent has no start and stop hooks for Brain. Add this text to its instructions file, and use the "close_session" prompt of the server ("Close my session") when you finish.',
    prompt: 'close_session',
    blocks: [
      { title: 'Add to the instructions file', where, format: 'text', text: INSTRUCTIONS_TEXT(o.brain) },
    ],
  })

  const agents: AgentKit[] = [
    // Claude Code. Sources (2026-10-30): https://code.claude.com/docs/en/mcp ("claude mcp add --transport
    // http <name> <url>", sign-in with /mcp or "claude mcp login"; .mcp.json {"type":"http","url",
    // "headers"} with ${VAR} expansion) and https://code.claude.com/docs/en/hooks (SessionStart with
    // matchers startup|resume|clear|compact|fork; Stop takes no matcher; {"type":"command","command"}).
    {
      id: 'claude-code',
      name: 'Claude Code',
      signIn: {
        note: 'Add the address, then run /mcp in Claude Code (or "claude mcp login rsc-brain") and accept in your browser.',
        blocks: [
          {
            title: 'Add Brain for all your projects',
            where: 'terminal',
            format: 'shell',
            text: `claude mcp add --transport http ${SERVER_NAME} ${url} --scope user`,
          },
        ],
      },
      token: {
        note: `Claude Code reads \${${TOKEN_ENV}} from your environment when it starts the connection.`,
        blocks: [
          exportToken,
          {
            title: 'Add Brain to a project (the file can be shared: it holds no token)',
            where: '.mcp.json',
            format: 'json',
            text: json({
              mcpServers: {
                [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } },
              },
            }),
          },
        ],
      },
      reminder: {
        kind: 'hooks',
        note: `At the start of a session the hook brings the context of the brain linked to the repository; when Claude stops with a brain session still open, it asks once for the summary. The hooks need the rsc-brain command and a token (${TOKEN_ENV} or ${TOKEN_FILE}). They never block your work when Brain does not answer.`,
        blocks: [
          {
            title: 'Add to ~/.claude/settings.json (or .claude/settings.json in a project)',
            where: '~/.claude/settings.json',
            format: 'json',
            text: json({
              hooks: {
                SessionStart: [
                  {
                    matcher: 'startup|resume|clear|compact|fork',
                    hooks: [
                      {
                        type: 'command',
                        command: `rsc-brain hook session-start ${hookArgs}${o.brain ? ` --brain ${o.brain}` : ''}`,
                        timeout: 15,
                      },
                    ],
                  },
                ],
                Stop: [
                  { hooks: [{ type: 'command', command: `rsc-brain hook stop ${hookArgs}`, timeout: 15 }] },
                ],
              },
            }),
          },
        ],
      },
      check,
    },
    // Codex. Source (2026-10-30): https://developers.openai.com/codex/mcp (now
    // https://learn.chatgpt.com/docs/extend/mcp?surface=cli): [mcp_servers.<name>] with url for
    // streamable HTTP and bearer_token_env_var for the token; "codex mcp add <name> --url <url>" and
    // "codex mcp login <name>" for OAuth. Codex speaks remote HTTP itself: no bridge needed.
    {
      id: 'codex',
      name: 'Codex',
      signIn: {
        note: 'Add the address, then sign in; your browser opens to accept.',
        blocks: [
          {
            title: 'Add Brain and sign in',
            where: 'terminal',
            format: 'shell',
            text: `codex mcp add ${SERVER_NAME} --url ${url}\ncodex mcp login ${SERVER_NAME}`,
          },
        ],
      },
      token: {
        note: `Codex sends the value of ${TOKEN_ENV} as the bearer token.`,
        blocks: [
          exportToken,
          {
            title: 'Add to ~/.codex/config.toml',
            where: '~/.codex/config.toml',
            format: 'toml',
            text: `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\nbearer_token_env_var = "${TOKEN_ENV}"`,
          },
        ],
      },
      reminder: instructions('AGENTS.md'),
      check,
    },
    // OpenCode. Source (2026-10-30): https://opencode.ai/docs/mcp-servers/ ("mcp": {"<name>": {"type":
    // "remote","url","headers","oauth"}}; OAuth starts by itself on a 401, or "opencode mcp auth
    // <name>"; "oauth": false for a server used with a key; {env:VAR} in values).
    {
      id: 'opencode',
      name: 'OpenCode',
      signIn: {
        note: 'Add the address; OpenCode opens your browser to sign in (or run "opencode mcp auth rsc-brain").',
        blocks: [
          {
            title: 'Add to opencode.json',
            where: 'opencode.json',
            format: 'json',
            text: json({
              $schema: 'https://opencode.ai/config.json',
              mcp: { [SERVER_NAME]: { type: 'remote', url } },
            }),
          },
        ],
      },
      token: {
        note: `OpenCode reads {env:${TOKEN_ENV}} from your environment.`,
        blocks: [
          exportToken,
          {
            title: 'Add to opencode.json',
            where: 'opencode.json',
            format: 'json',
            text: json({
              $schema: 'https://opencode.ai/config.json',
              mcp: {
                [SERVER_NAME]: {
                  type: 'remote',
                  url,
                  oauth: false,
                  headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` },
                },
              },
            }),
          },
        ],
      },
      reminder: instructions('AGENTS.md'),
      check,
    },
    // Cursor. Source (2026-10-30): https://cursor.com/docs/context/mcp ("mcpServers": {"<name>":
    // {"url","headers"}} in .cursor/mcp.json or ~/.cursor/mcp.json; streamable HTTP; OAuth with PKCE;
    // ${env:NAME} in url and headers).
    {
      id: 'cursor',
      name: 'Cursor',
      signIn: {
        note: 'Add the address; Cursor asks you to sign in and opens your browser.',
        blocks: [
          {
            title: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
            where: '.cursor/mcp.json',
            format: 'json',
            text: json({ mcpServers: { [SERVER_NAME]: { url } } }),
          },
        ],
      },
      token: {
        note: `Cursor reads \${env:${TOKEN_ENV}} from your environment.`,
        blocks: [
          exportToken,
          {
            title: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
            where: '.cursor/mcp.json',
            format: 'json',
            text: json({
              mcpServers: {
                [SERVER_NAME]: { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } },
              },
            }),
          },
        ],
      },
      reminder: instructions('AGENTS.md (or a rule in .cursor/rules)'),
      check,
    },
    // Any other agent: remote HTTP with a bearer header when it can, the local bridge when it only
    // speaks MCP over stdio (spec B5 CA15).
    {
      id: 'other',
      name: 'Other agents',
      signIn: null,
      token: {
        note: `If your agent speaks MCP over HTTP, give it the address and the header "Authorization: Bearer <token>". If it only starts local MCP programs, use the bridge: it runs on your machine and connects to Brain with your token (from ${TOKEN_FILE} or ${TOKEN_ENV}).`,
        blocks: [
          tokenFile,
          {
            title: 'Local MCP through the bridge',
            where: 'mcpServers',
            format: 'json',
            text: json({
              mcpServers: {
                [SERVER_NAME]: {
                  command: 'rsc-brain',
                  args: ['bridge', '--url', url, '--token-file', TOKEN_FILE],
                },
              },
            }),
          },
          {
            title: 'Remote MCP over HTTP',
            where: 'remote',
            format: 'text',
            text: `URL: ${url}\nHeader: Authorization: Bearer ${TOKEN_PLACEHOLDER}`,
          },
        ],
      },
      reminder: instructions("your agent's instructions file"),
      check,
    },
  ]
  return {
    mcpUrl: url,
    tokenEnv: TOKEN_ENV,
    tokenPlaceholder: TOKEN_PLACEHOLDER,
    agents: o.agent ? agents.filter((a) => a.id === o.agent) : agents,
  }
}
