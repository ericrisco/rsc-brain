// Plan §3.10 (T017, spec C18): whether a newer release exists is one request a day to the public list of releases,
// with nothing in it but `User-Agent: rsc-brain/<version>`; an empty RSC_BRAIN_RELEASES_URL turns it off (no request
// at all). What it learns stays in memory: the newest release, its notes and when it was checked.
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { DEFAULT_RELEASES_URL, newer, releaseChecker, releasesUrl } from '../../src/ops/releases.ts'

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string }

describe('releases', () => {
  let server: Server
  let base = ''
  const seen: Seen[] = []
  let answer: { status: number; body: string } = { status: 200, body: '[]' }
  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(answer.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => new Promise<void>((r) => server.close(() => r())))

  const clock = () => new Date('2026-11-02T10:00:00.000Z')

  it('asks with only its User-Agent: no query, no body, no cookie, nothing about the installation', async () => {
    seen.length = 0
    answer = {
      status: 200,
      body: JSON.stringify([
        { tag_name: 'v0.3.0-rc.1', prerelease: true, draft: false, body: 'not yet' },
        { tag_name: 'v0.2.0', prerelease: false, draft: false, body: '## 0.2.0\n- Faster search.' },
        { tag_name: 'v0.1.0', prerelease: false, draft: false, body: 'first' },
      ]),
    }
    const c = releaseChecker({ url: `${base}/releases`, version: '0.1.0', clock })
    await c.check()
    assert.equal(seen.length, 1)
    const got = seen[0] as Seen
    assert.equal(got.method, 'GET')
    assert.equal(got.url, '/releases')
    assert.equal(got.body, '')
    assert.equal(got.headers['user-agent'], 'rsc-brain/0.1.0')
    // Only what HTTP itself needs besides it.
    assert.deepEqual(Object.keys(got.headers).sort(), ['connection', 'host', 'user-agent'])
    assert.deepEqual(c.state(), {
      installed: '0.1.0',
      latest: '0.2.0',
      notes: '## 0.2.0\n- Faster search.',
      checkedAt: '2026-11-02T10:00:00.000Z',
    })
  })

  it('an empty RSC_BRAIN_RELEASES_URL asks nothing, ever', async () => {
    seen.length = 0
    assert.equal(releasesUrl({ RSC_BRAIN_RELEASES_URL: '' }), null)
    assert.equal(releasesUrl({}), DEFAULT_RELEASES_URL)
    assert.match(DEFAULT_RELEASES_URL, /^https:\/\/api\.github\.com\/repos\/ericrisco\/rsc-brain\/releases$/)
    const c = releaseChecker({ url: null, version: '0.1.0', clock })
    await c.check()
    c.start()
    c.stop()
    assert.equal(seen.length, 0)
    assert.deepEqual(c.state(), { installed: '0.1.0', latest: null, notes: null, checkedAt: null })
  })

  it('once a day at most, however often it is asked to check', async () => {
    seen.length = 0
    answer = { status: 200, body: JSON.stringify([{ tag_name: 'v0.1.0', body: '' }]) }
    let now = Date.parse('2026-11-02T10:00:00.000Z')
    const c = releaseChecker({ url: `${base}/r`, version: '0.1.0', clock: () => new Date(now) })
    await c.check()
    now += 23 * 3600_000
    await c.check()
    assert.equal(seen.length, 1)
    now += 3600_000
    await c.check()
    assert.equal(seen.length, 2)
  })

  it('a failure, a bad answer or one too large keeps what it knew, and never throws', async () => {
    seen.length = 0
    answer = { status: 200, body: JSON.stringify([{ tag_name: 'v0.2.0', body: 'ok' }]) }
    let now = Date.parse('2026-11-02T10:00:00.000Z')
    const c = releaseChecker({ url: `${base}/r`, version: '0.1.0', clock: () => new Date(now) })
    await c.check()
    for (const a of [
      { status: 500, body: 'oops' },
      { status: 200, body: 'not json' },
      { status: 200, body: JSON.stringify({ message: 'rate limited' }) },
      { status: 200, body: JSON.stringify([{ tag_name: 'x'.repeat(10) }]).padEnd(3_000_000, ' ') },
    ]) {
      answer = a
      now += 25 * 3600_000
      await c.check()
      assert.equal(c.state().latest, '0.2.0')
    }
    const down = releaseChecker({ url: 'http://127.0.0.1:1/none', version: '0.1.0', clock })
    await down.check()
    assert.equal(down.state().latest, null)
  })

  it('a failed check is tried again soon, then less often (15 min doubling up to 6 h), never once a day', async () => {
    seen.length = 0
    answer = { status: 500, body: 'down' }
    let now = Date.parse('2026-11-02T10:00:00.000Z')
    const c = releaseChecker({ url: `${base}/r`, version: '0.1.0', clock: () => new Date(now) })
    await c.check()
    assert.equal(seen.length, 1)
    now += 14 * 60_000
    await c.check()
    assert.equal(seen.length, 1, 'not before 15 minutes')
    now += 60_000
    await c.check()
    assert.equal(seen.length, 2, 'again after 15 minutes')
    now += 29 * 60_000
    await c.check()
    assert.equal(seen.length, 2, 'then 30 minutes')
    now += 60_000
    await c.check()
    assert.equal(seen.length, 3)
    // Many failures: at most 6 hours apart.
    for (let i = 0; i < 6; i++) {
      now += 6 * 3600_000
      await c.check()
    }
    assert.equal(seen.length, 9)
    // It answers: then once a day.
    answer = { status: 200, body: JSON.stringify([{ tag_name: 'v0.2.0', body: '' }]) }
    now += 6 * 3600_000
    await c.check()
    assert.equal(c.state().latest, '0.2.0')
    now += 6 * 3600_000
    await c.check()
    assert.equal(seen.length, 10)
  })

  it('notes are bounded, and only a newer release counts as new', () => {
    assert.equal(newer('0.2.0', '0.1.0'), true)
    assert.equal(newer('0.1.10', '0.1.9'), true)
    assert.equal(newer('0.1.0', '0.1.0'), false)
    assert.equal(newer('0.0.9', '0.1.0'), false)
    assert.equal(newer('1.0.0', '0.9.9'), true)
    assert.equal(newer('garbage', '0.1.0'), false)
  })
})
