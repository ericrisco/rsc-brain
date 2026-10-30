// What the commands that run on a person's machine share (the bridge and the hooks): the address of
// the installation and the token. The token comes from the environment or a file, never from the
// command line (other users of the machine can read command lines), and is never printed.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_ENV, TOKEN_FILE } from '../mcp/kit.ts'

export class UsageError extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

// The MCP address, from --url or RSC_BRAIN_URL. A bare installation address gets /mcp. Plain http only
// to this machine: a token must not cross a network in clear text.
export function mcpAddress(raw: string | undefined): URL {
  const v = raw ?? process.env.RSC_BRAIN_URL
  if (!v)
    throw new UsageError(
      'Pass --url with the MCP address of your installation, such as https://brain.example.com/mcp.',
    )
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw new UsageError(`"${v}" is not an address. Pass one such as https://brain.example.com/mcp.`)
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new UsageError(
      `Use https: the token would travel in clear text to ${u.host}. Plain http is only for this machine (localhost).`,
    )
  }
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/mcp'
  u.hash = ''
  return u
}

// The address of the installation (for /v1) from its MCP address.
export function apiBase(mcp: URL): string {
  return `${mcp.origin}${mcp.pathname.replace(/\/mcp\/?$/, '').replace(/\/+$/, '')}`
}

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)

// RSC_BRAIN_TOKEN, else the file given, else the usual file when it exists. An explicit file that
// cannot be read is an error; no token at all is null.
export function readToken(file: string | undefined): string | null {
  const env = process.env[TOKEN_ENV]?.trim()
  if (env) return checked(env)
  const path = expand(file ?? TOKEN_FILE)
  if (!file && !existsSync(path)) return null
  let t: string
  try {
    t = readFileSync(path, 'utf8').trim()
  } catch {
    throw new UsageError(`Cannot read the token file ${path}. Check that it exists and that you can read it.`)
  }
  return checked(t) || null
}

// A token is one word: a space or a line break inside would end up in an error message, and from
// there in the agent's context.
function checked(t: string): string {
  if (/[\s\x00-\x1f\x7f]/.test(t)) {
    throw new UsageError(
      'The token has a space or a line break inside. Copy it again from the Brain web, as one line.',
    )
  }
  return t
}

export const NO_TOKEN = `No token. Set ${TOKEN_ENV}, or keep it in ${TOKEN_FILE} (or pass --token-file). Create a token in the Brain web, under your profile.`
