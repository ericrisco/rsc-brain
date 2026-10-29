// Fetching a client's metadata document (spec B4, plan risk 1): the address comes from whoever starts a
// sign-in, so the server must not become a way to reach what is behind it. Only https; every address
// the name resolves to is checked, in the same lookup the connection uses (no second resolution to
// rebind); private, local, link and reserved ranges are refused; no redirects; 5 seconds; 64 KB.
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

export const FETCH_TIMEOUT_MS = 5000
export const FETCH_MAX_BYTES = 64 * 1024

// Tests serve documents from this machine over http; only they set this.
export type FetchPolicy = { allowLoopbackHttp?: boolean }

// Two lists: Node's BlockList also checks IPv4 against IPv6 rules (as mapped addresses).
const blocked = new BlockList()
const blocked6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['fec0::', 10], // site-local (deprecated)
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(net, bits, 'ipv6')
}

const LOOPBACK = new Set(['127.0.0.1', '::1'])

// An address Brain refuses to reach. IPv4 written inside IPv6 (::ffff:10.0.0.1) is checked as IPv4.
export function forbiddenAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return blocked.check(ip, 'ipv4')
  if (family !== 6) return true
  // IPv4 inside IPv6 (::ffff:10.0.0.1, or ::ffff:a00:1) is checked as the IPv4 it is.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]
  if (dotted) return blocked.check(dotted, 'ipv4')
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (hex) {
    const [a, b] = [Number.parseInt(hex[1] as string, 16), Number.parseInt(hex[2] as string, 16)]
    return blocked.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, 'ipv4')
  }
  return blocked6.check(ip, 'ipv6')
}

export class FetchRefused extends Error {}

const guardedLookup =
  (policy: FetchPolicy): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4)
      const list = addresses as Array<{ address: string; family: number }>
      const ok = list.filter(
        (a) => !forbiddenAddress(a.address) || (policy.allowLoopbackHttp && LOOPBACK.has(a.address)),
      )
      if (ok.length === 0 || ok.length !== list.length) {
        // Said like any other failure, so the answer does not map names only reachable inside.
        return callback(new FetchRefused('The document could not be fetched.'), '', 4)
      }
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (e: null, a: unknown) => void)(null, ok)
      const first = ok[0] as { address: string; family: number }
      callback(null, first.address, first.family)
    })
  }

export async function fetchJson(address: string, policy: FetchPolicy = {}): Promise<unknown> {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new FetchRefused('Not an address.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = LOOPBACK.has(host) || host === 'localhost'
  const plainOk = policy.allowLoopbackHttp && loopback && url.protocol === 'http:'
  if (url.protocol !== 'https:' && !plainOk) throw new FetchRefused('Only https addresses are fetched.')
  if (url.username || url.password) throw new FetchRefused('Addresses with credentials are not fetched.')
  if (isIP(host) && forbiddenAddress(host) && !(policy.allowLoopbackHttp && LOOPBACK.has(host))) {
    throw new FetchRefused(`${host} is an address Brain does not reach.`)
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'rsc-brain' },
        lookup: guardedLookup(policy),
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(
            new FetchRefused(`The document answered ${res.statusCode} (redirects are not followed).`),
          )
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > FETCH_MAX_BYTES) {
            req.destroy(new FetchRefused('The document is larger than 64 KB.'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new FetchRefused('The document is not JSON.'))
          }
        })
        res.on('error', reject)
      },
    )
    const timer = setTimeout(
      () => req.destroy(new FetchRefused('The document took longer than 5 seconds.')),
      FETCH_TIMEOUT_MS,
    )
    req.on('close', () => clearTimeout(timer))
    req.on('timeout', () => req.destroy(new FetchRefused('The document took longer than 5 seconds.')))
    req.on('error', (e) =>
      reject(
        e instanceof FetchRefused ? e : new FetchRefused(`The document could not be fetched: ${e.message}`),
      ),
    )
    req.end()
  })
}
