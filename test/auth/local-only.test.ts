// «This machine only» behind containers (spec B7 C19, plan §3.8, risk 7). B4's rule: a password only over an
// encrypted connection or from this machine. In a container, a browser on the same machine reaches the service
// through the container's gateway, never from 127.0.0.1. With RSC_BRAIN_LOCAL_ONLY=1 (the launcher sets it only
// when the port is published on 127.0.0.1 alone, and the service refuses to start otherwise), a request that comes
// straight from that gateway, through no proxy, counts as this machine. Anything else does not: another address,
// any forwarded header, the flag off.
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { describe, it } from 'node:test'
import { readConfig } from '../../src/config.ts'
import { requireSecure } from '../../src/domain/installation.ts'
import { connOf, defaultGateway, dockerGateway } from '../../src/http/conn.ts'

// A browser on this machine names the address it opened: 127.0.0.1:<port> (or localhost, [::1]).
const req = (remoteAddress: string, headers: Record<string, string> = { host: '127.0.0.1:8090' }) =>
  ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage

const GATEWAY = '172.18.0.1'
const passwordAccepted = (r: IncomingMessage, o: Parameters<typeof connOf>[1]) => {
  try {
    requireSecure(connOf(r, o))
    return true
  } catch {
    return false
  }
}

describe('RSC_BRAIN_LOCAL_ONLY: a password over http from the container gateway', () => {
  it('with the flag, a request straight from the gateway counts as this machine and may use a password', () => {
    const c = connOf(req(GATEWAY), { trusted: [], localGateways: [GATEWAY] })
    assert.deepEqual([c.local, c.encrypted, c.ip], [true, false, GATEWAY])
    assert.equal(passwordAccepted(req(GATEWAY), { trusted: [], localGateways: [GATEWAY] }), true)
    // The same address written as IPv6-mapped IPv4 (a dual-stack listener).
    assert.equal(connOf(req(`::ffff:${GATEWAY}`), { trusted: [], localGateways: [GATEWAY] }).local, true)
  })

  it('with the flag, a request from the gateway for another host name is refused (not what this machine opens)', () => {
    for (const host of ['localhost', 'localhost:8090', '[::1]:8090', '127.0.0.1']) {
      assert.equal(
        connOf(req(GATEWAY, { host }), { trusted: [], localGateways: [GATEWAY] }).local,
        true,
        host,
      )
    }
    for (const host of [
      '192.168.1.5:8090',
      'brain.example.com',
      '127.0.0.1.nip.io:8090',
      'localhost.evil:80',
      '',
    ]) {
      assert.equal(
        connOf(req(GATEWAY, { host }), { trusted: [], localGateways: [GATEWAY] }).local,
        false,
        host,
      )
    }
    assert.equal(connOf(req(GATEWAY, {}), { trusted: [], localGateways: [GATEWAY] }).local, false, 'no Host')
  })

  it('without the flag, the same request over http is refused', () => {
    assert.equal(connOf(req(GATEWAY), { trusted: [], localGateways: [] }).local, false)
    assert.equal(passwordAccepted(req(GATEWAY), { trusted: [], localGateways: [] }), false)
  })

  it('with the flag, any other address is still refused: another container, the network, a public address', () => {
    for (const ip of ['172.18.0.5', '10.0.0.7', '192.168.1.20', '203.0.113.7', '::ffff:203.0.113.7', '']) {
      assert.equal(passwordAccepted(req(ip), { trusted: [], localGateways: [GATEWAY] }), false, ip)
    }
  })

  it('with the flag, a request from the gateway that carries forwarded headers is refused (it was relayed)', () => {
    for (const h of [
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-proto': 'http' },
      { forwarded: 'for=127.0.0.1' },
    ]) {
      assert.equal(
        passwordAccepted(req(GATEWAY, { host: '127.0.0.1:8090', ...h }), {
          trusted: [],
          localGateways: [GATEWAY],
        }),
        false,
      )
    }
    // Even when the gateway is also a trusted proxy: what a proxy relays is never «this machine».
    const viaProxy = connOf(req(GATEWAY, { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'http' }), {
      trusted: [GATEWAY],
      localGateways: [GATEWAY],
    })
    assert.deepEqual([viaProxy.local, viaProxy.encrypted, viaProxy.ip], [false, false, '203.0.113.7'])
  })

  it('loopback stays this machine with or without the flag; encrypted stays accepted', () => {
    assert.equal(connOf(req('127.0.0.1'), { trusted: [], localGateways: [] }).local, true)
    assert.equal(connOf(req('::1'), { trusted: [], localGateways: [GATEWAY] }).local, true)
  })
})

describe('the container gateway', () => {
  it('looks like a Docker network gateway in 172.16.0.0/12 or 192.168.0.0/16; anything else is warned about', () => {
    for (const ip of ['172.17.0.1', '172.18.0.1', '172.31.255.1', '192.168.65.1', '192.168.0.1']) {
      assert.equal(dockerGateway(ip), true, ip)
    }
    for (const ip of ['172.15.0.1', '172.32.0.1', '10.0.0.1', '203.0.113.1', '1.2.3.4', 'x']) {
      assert.equal(dockerGateway(ip), false, ip)
    }
  })

  // /proc/net/route: the default route (destination 00000000) and its gateway, little-endian hex.
  const ROUTES = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  ].join('\n')

  it('is read from the default route', () => {
    assert.equal(defaultGateway(ROUTES), '172.18.0.1')
  })

  it('is none without a default route, or with an unreadable table', () => {
    assert.equal(defaultGateway(ROUTES.split('\n').slice(0, 1).join('\n')), null)
    assert.equal(defaultGateway(''), null)
    assert.equal(defaultGateway('garbage\nx\ty\tz'), null)
  })
})

describe('RSC_BRAIN_LOCAL_ONLY in the settings', () => {
  const base = { RSC_BRAIN_DATABASE_URL: 'postgres://x@localhost/x' }

  it('is off by default', () => {
    assert.equal(readConfig(base).localOnly, false)
  })

  it('is on with 1 only when the port is published on this machine alone', () => {
    for (const publish of ['127.0.0.1:8090', '[::1]:8090']) {
      assert.equal(
        readConfig({ ...base, RSC_BRAIN_LOCAL_ONLY: '1', RSC_BRAIN_PUBLISH: publish }).localOnly,
        true,
        publish,
      )
    }
  })

  it('refuses to start when the port may be published to the network, or the value is not 1 or 0', () => {
    for (const publish of [
      undefined,
      '',
      '8090',
      '0.0.0.0:8090',
      '192.168.1.5:8090',
      ':8090',
      '127.0.0.1.evil:1',
      'localhost:8090',
    ]) {
      const env = {
        ...base,
        RSC_BRAIN_LOCAL_ONLY: '1',
        ...(publish === undefined ? {} : { RSC_BRAIN_PUBLISH: publish }),
      }
      assert.throws(() => readConfig(env), /RSC_BRAIN_LOCAL_ONLY.*127\.0\.0\.1/s, String(publish))
    }
    assert.throws(
      () => readConfig({ ...base, RSC_BRAIN_LOCAL_ONLY: 'yes' }),
      /RSC_BRAIN_LOCAL_ONLY must be 1 or 0/,
    )
    assert.equal(readConfig({ ...base, RSC_BRAIN_LOCAL_ONLY: '0' }).localOnly, false)
  })
})
