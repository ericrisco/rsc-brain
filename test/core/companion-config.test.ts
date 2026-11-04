// Companion mode (plan F1 §3.1, T047): the settings the launcher gives the service, and the two checks of the
// handshake that need no database: the request comes straight from the shared network, and it carries the one-time
// key. No PostgreSQL: runs in CI.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readConfig } from '../../src/config.ts'
import { fromSharedNetwork, sameKey } from '../../src/domain/companion.ts'

const TOKEN = 'c0ffee'.repeat(11)
const base = { RSC_BRAIN_DATABASE_URL: 'postgres://x' }
const companion = {
  ...base,
  RSC_BRAIN_COMPANION_TOKEN: TOKEN,
  RSC_BRAIN_COMPANION_NETWORK: '192.168.210.0/24',
  RSC_BRAIN_COMPANION_GATEWAY: '192.168.210.1',
  RSC_BRAIN_FACTORY_URL: 'https://factory.example.com/',
  RSC_BRAIN_SETUP_URL: 'https://brain.example.com',
}

describe('companion mode: the settings', () => {
  it('off without RSC_BRAIN_COMPANION_TOKEN', () => {
    assert.equal(readConfig(base).companion, null)
  })

  it('on with the key, the shared network, its gateway and the address of rsc-factory', () => {
    assert.deepEqual(readConfig(companion).companion, {
      token: TOKEN,
      network: '192.168.210.0/24',
      gateway: '192.168.210.1',
      factoryUrl: 'https://factory.example.com',
      publicUrl: 'https://brain.example.com',
    })
    const noGateway = { ...companion, RSC_BRAIN_COMPANION_GATEWAY: '' }
    assert.equal(readConfig(noGateway).companion?.gateway, null)
  })

  const bad: Array<[string, Record<string, string>, RegExp]> = [
    ['a short key', { RSC_BRAIN_COMPANION_TOKEN: 'short-key' }, /RSC_BRAIN_COMPANION_TOKEN.*32/],
    ['a key with a space', { RSC_BRAIN_COMPANION_TOKEN: `${TOKEN} x` }, /RSC_BRAIN_COMPANION_TOKEN/],
    ['no shared network', { RSC_BRAIN_COMPANION_NETWORK: '' }, /RSC_BRAIN_COMPANION_NETWORK/],
    [
      'a network that is not IPv4 CIDR',
      { RSC_BRAIN_COMPANION_NETWORK: 'rsc-shared' },
      /RSC_BRAIN_COMPANION_NETWORK/,
    ],
    [
      'a network that takes in every address',
      { RSC_BRAIN_COMPANION_NETWORK: '0.0.0.0/0' },
      /RSC_BRAIN_COMPANION_NETWORK/,
    ],
    ['a prefix past 32', { RSC_BRAIN_COMPANION_NETWORK: '10.0.0.0/33' }, /RSC_BRAIN_COMPANION_NETWORK/],
    ['an octet past 255', { RSC_BRAIN_COMPANION_NETWORK: '10.0.300.0/16' }, /RSC_BRAIN_COMPANION_NETWORK/],
    [
      'a gateway that is not an address',
      { RSC_BRAIN_COMPANION_GATEWAY: 'gw' },
      /RSC_BRAIN_COMPANION_GATEWAY/,
    ],
    ['a gateway off the network', { RSC_BRAIN_COMPANION_GATEWAY: '10.0.0.1' }, /RSC_BRAIN_COMPANION_GATEWAY/],
    ['no address of rsc-factory', { RSC_BRAIN_FACTORY_URL: '' }, /RSC_BRAIN_FACTORY_URL/],
    [
      'an address of rsc-factory in clear',
      { RSC_BRAIN_FACTORY_URL: 'http://factory.example.com' },
      /RSC_BRAIN_FACTORY_URL/,
    ],
  ]
  for (const [what, change, says] of bad) {
    it(`refuses to start with ${what}, naming the setting`, () => {
      assert.throws(() => readConfig({ ...companion, ...change }), says)
    })
  }
})

describe('companion mode: the handshake’s own checks', () => {
  const net = { network: '192.168.210.0/24', gateway: '192.168.210.1' }
  it('only straight from the shared network: not its gateway (this machine), not a proxy, not elsewhere', () => {
    assert.equal(fromSharedNetwork('192.168.210.7', net, []), true)
    assert.equal(fromSharedNetwork('::ffff:192.168.210.7', net, []), true)
    assert.equal(fromSharedNetwork('192.168.210.255', net, []), true)
    assert.equal(fromSharedNetwork('192.168.210.1', net, []), false)
    assert.equal(fromSharedNetwork('192.168.210.2', net, ['192.168.210.2']), false)
    assert.equal(fromSharedNetwork('192.168.211.7', net, []), false)
    assert.equal(fromSharedNetwork('127.0.0.1', net, []), false)
    assert.equal(fromSharedNetwork('::1', net, []), false)
    assert.equal(fromSharedNetwork('', net, []), false)
    assert.equal(fromSharedNetwork('10.1.2.3', { network: '10.0.0.0/8', gateway: null }, []), true)
    assert.equal(fromSharedNetwork('11.1.2.3', { network: '10.0.0.0/8', gateway: null }, []), false)
  })

  it('the key: equal only when it is the same, whatever the length', () => {
    assert.equal(sameKey(`Bearer ${TOKEN}`, TOKEN), true)
    assert.equal(sameKey(`Bearer ${TOKEN.slice(0, -1)}x`, TOKEN), false)
    assert.equal(sameKey(`Bearer ${TOKEN.slice(0, 10)}`, TOKEN), false)
    assert.equal(sameKey(`Bearer ${TOKEN}${TOKEN}`, TOKEN), false)
    assert.equal(sameKey(TOKEN, TOKEN), false)
    assert.equal(sameKey('Bearer ', TOKEN), false)
    assert.equal(sameKey(undefined, TOKEN), false)
  })
})
