// What a request's connection is: encrypted or not, from this machine or not, and from which address. B4's rule
// («a password only over an encrypted connection or from this machine») reads it.
//
// «This machine only» (RSC_BRAIN_LOCAL_ONLY, spec B7 C19): in a container, a browser on the same machine reaches
// the service through the container's gateway, never from 127.0.0.1. With the flag on, a request that comes
// straight from that gateway (through no proxy) counts as this machine. That is only true because the port is
// published on 127.0.0.1 alone: readConfig refuses the flag otherwise, and the launcher sets both together. Published
// to the network, every outside client would also arrive from the gateway, and passwords would cross it in clear.
import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { Conn } from './router.ts'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export type ConnOptions = {
  // Proxies whose X-Forwarded-Proto / X-Forwarded-For are believed.
  trusted: string[]
  // With RSC_BRAIN_LOCAL_ONLY: the container's gateway; empty otherwise.
  localGateways: string[]
}

const plain = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip)

// What a browser on this machine names in Host: the loopback address it opened, with any port.
const LOCAL_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i

export function connOf(req: IncomingMessage, o: ConnOptions): Conn {
  const remote = req.socket.remoteAddress ?? ''
  const h = req.headers
  const proxied =
    h['x-forwarded-for'] !== undefined || h['x-forwarded-proto'] !== undefined || h.forwarded !== undefined
  const userAgent = String(h['user-agent'] ?? '').slice(0, 200)
  if (proxied && o.trusted.includes(remote)) {
    // The trusted proxy appends what it saw: the last entry is its own; earlier ones the client wrote.
    const last = (v: string | string[] | undefined) =>
      String(v ?? '')
        .split(',')
        .at(-1)
        ?.trim() ?? ''
    return {
      encrypted: last(h['x-forwarded-proto']) === 'https',
      local: false,
      ip: last(h['x-forwarded-for']) || remote,
      userAgent,
    }
  }
  // From the gateway, and for the address this machine opens: a request relayed from elsewhere (host networking, a
  // port published by hand) names another host.
  const fromGateway =
    remote !== '' && o.localGateways.includes(plain(remote)) && LOCAL_HOST_HEADER.test(String(h.host ?? ''))
  return {
    encrypted: Boolean((req.socket as TLSSocket).encrypted),
    local: (LOOPBACK.has(remote) || fromGateway) && !proxied,
    ip: remote,
    userAgent,
  }
}

// The gateway of the default route in /proc/net/route (Linux; little-endian hex), or null without one.
export function defaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/)
    if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway)) continue
    const n = Number.parseInt(gateway, 16)
    if (n === 0) continue
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.')
  }
  return null
}

// Whether a gateway looks like a Docker network's (172.16.0.0/12 or 192.168.0.0/16, where Docker takes its networks).
// Anything else (host networking, another runtime) is warned about at start: the flag is then likely misplaced.
export function dockerGateway(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
