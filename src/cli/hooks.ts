// The optional reminder of Claude Code (spec B5 «El kit de conexión», CA16): two hooks.
//
// - session-start: brings the context of the brain linked to the repository the session works in
//   (brain_resolve with `git remote get-url origin`, then mem_context), printed as additional context.
// - stop: when the key still has a brain session open (work without a summary), asks Claude once to
//   close it with mem_session_summary before it stops.
//
// Contract (https://code.claude.com/docs/en/hooks, read 2026-10-30): the hook gets JSON on stdin
// (session_id, cwd, hook_event_name; SessionStart adds source; Stop adds stop_hook_active, true when
// Claude is already continuing because of a stop hook). SessionStart adds context with
// {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}} (at most 10 000
// characters inline). Stop keeps Claude working with {"decision":"block","reason":…}.
//
// Both fail open: whatever goes wrong (no token, Brain down, bad input), they exit 0 and print nothing,
// so the agent's work is never held up by the brain.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apiBase } from './remote.ts'

type Json = Record<string, unknown>
const CALL_TIMEOUT_MS = 5_000
// What Claude Code takes inline from a hook.
const MAX_CONTEXT = 10_000

async function readInput(input: NodeJS.ReadableStream): Promise<Json | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of input) {
    size += (c as Buffer).length
    if (size > 1_048_576) return null
    chunks.push(c as Buffer)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

async function api(base: string, token: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  const json = (await res.json()) as Json
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return json
}

async function originOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 3_000,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

const cut = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max - 40)}\n[cut: call mem_context for the rest]`

export async function sessionStart(o: {
  url: URL
  token: string
  brain: string | undefined
  input: NodeJS.ReadableStream
  out: (s: string) => void
}): Promise<void> {
  const input = (await readInput(o.input)) ?? {}
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  const base = apiBase(o.url)
  let slug: string | null = null
  let linked = false
  let note: string | null = null
  const origin = await originOf(cwd)
  if (origin) {
    const r = await api(base, o.token, 'POST', '/v1/resolve', { repos: [origin] })
    const brain = r.brain as Json | null
    if (brain && typeof brain.slug === 'string') {
      slug = brain.slug
      linked = true
    } else if (!o.brain) {
      const options = ((r.brains ?? r.candidates ?? []) as Json[]).map((b) => `"${String(b.slug)}"`)
      note = `RSC Brain: ${String(r.message ?? '')} ${String(r.howToProceed ?? '')}${
        options.length ? ` Brains you can use: ${options.join(', ')}.` : ''
      }`
    }
  }
  slug ??= o.brain ?? null
  let text: string
  if (slug) {
    const c = await api(base, o.token, 'GET', `/v1/brains/${encodeURIComponent(slug)}/context?max=9000`)
    const head = `RSC Brain: this session works in the brain "${slug}"${
      linked ? ' (linked to this repository)' : ''
    }. Name it as "brain" in your calls, open a session with mem_session_start, and close it with mem_session_summary.\n\n`
    text = cut(head + String(c.text ?? ''), MAX_CONTEXT)
  } else if (note) {
    text = cut(note, MAX_CONTEXT)
  } else return
  o.out(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`,
  )
}

// Where the stop hook remembers that it already asked (so it asks once per brain session in each
// Claude Code session, even if the agent does not close it).
function stateDir(): string {
  if (process.env.RSC_BRAIN_STATE_DIR) return process.env.RSC_BRAIN_STATE_DIR
  let who = 'user'
  try {
    who = String(userInfo().uid)
  } catch {}
  return join(tmpdir(), `rsc-brain-${who}`)
}

export async function stop(o: {
  url: URL
  token: string
  input: NodeJS.ReadableStream
  out: (s: string) => void
}): Promise<void> {
  const input = await readInput(o.input)
  if (!input || input.stop_hook_active === true) return
  const r = await api(apiBase(o.url), o.token, 'GET', '/v1/me/sessions')
  const open = (Array.isArray(r.items) ? r.items : []) as Json[]
  const claude = typeof input.session_id === 'string' ? input.session_id : ''
  const dir = stateDir()
  const mark = (id: unknown) =>
    join(
      dir,
      createHash('sha256')
        .update(`${claude}\n${String(id)}`)
        .digest('hex'),
    )
  const unasked = open.filter((s) => !existsSync(mark(s.id)))
  if (unasked.length === 0) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const s of unasked) writeFileSync(mark(s.id), '', { mode: 0o600 })
  } catch {}
  const list = unasked.map((s) => `session "${String(s.id)}" in the brain "${String(s.brain)}"`).join('; ')
  const reason =
    `Before you finish: your RSC Brain work has no summary yet (${list}). ` +
    'Call mem_session_summary with that session and a short summary: goal, done, discovered, decided, pending. ' +
    'If nothing in it is worth keeping, call mem_session_end instead.'
  o.out(`${JSON.stringify({ decision: 'block', reason })}\n`)
}
