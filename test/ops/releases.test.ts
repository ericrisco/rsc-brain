// What a published version is (rsc-updates §0, §3.9; CA27, CA29b): a `vX.Y.Z` tag of the repository, asked for without
// any credential, with limits on time and size, and what it changes from the `## vX.Y.Z` section of the CHANGELOG.md in
// that tag. There is no shared package: the definition is written again here and pinned by a copy of rsc-factory's
// vectors, with the same SHA-256. And (spec C18) the checker: once a day, sooner after a failure, only the User-Agent,
// and off with an empty RSC_BRAIN_REPO_URL or RSC_BRAIN_RELEASES_URL.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  check,
  compareVersions,
  DEFAULT_REPO_URL,
  isPublished,
  MAX_BYTES,
  NOTES_MAX,
  newestOf,
  notesFor,
  PUBLISHED,
  releaseChecker,
  releaseView,
  repoUrl,
} from '../../src/ops/releases.ts'

type Vectors = {
  pattern: string
  notesMaxChars: number
  newest: Array<{ name: string; tags: string[]; newest: string | null }>
  compare: Array<{ name: string; installed: string; newest: string; result: string }>
  notes: Array<{ name: string; tag: string; changelog: string; notes: string }>
}
// The copy of rsc-factory's test/fixtures/published-vectors.json. When rsc-factory adds sections, both change together.
const VECTORS_SHA256 = '95b691dd221a9f99e0269f9a417594e0f630e523f73fe2ab0d18d0e061ccd4a7'
const vectorsText = readFileSync(new URL('../fixtures/published-vectors.json', import.meta.url), 'utf8')
const vectors = JSON.parse(vectorsText) as Vectors

test('the vectors are the copy of rsc-factory: same SHA-256', () => {
  assert.equal(createHash('sha256').update(vectorsText).digest('hex'), VECTORS_SHA256)
})

const REPO = 'https://github.com/acme/widget'
const AT = '2026-11-04T10:00:00.000Z'
const now = () => new Date(AT)
const SHA = 'a'.repeat(40)
const ADVERTISEMENT = 'application/x-git-upload-pack-advertisement'

const pkt = (line: string) => {
  const size = Buffer.byteLength(line) + 4
  return `${size.toString(16).padStart(4, '0')}${line}`
}
const refs = (...names: string[]) =>
  pkt('# service=git-upload-pack\n') +
  '0000' +
  pkt(`${SHA} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main\n`) +
  names.map((n) => pkt(`${SHA} ${n}\n`)).join('') +
  '0000'

type Call = { url: string; init: RequestInit | undefined }
function stub(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const route = routes[url]
    if (!route) return new Response('not found', { status: 404 })
    return route()
  }) as typeof globalThis.fetch
  return { fetch, calls }
}
const INFO = `${REPO}/info/refs?service=git-upload-pack`
const advert = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': ADVERTISEMENT } })

describe('published: the definition, from the shared vectors', () => {
  test('the pattern is the one the vectors state', () => {
    for (const ok of ['v0.2.0', 'v10.20.30', 'v0.0.0']) assert.ok(isPublished(ok), ok)
    for (const no of ['v01.0.0', 'v0.01.0', 'v0.0.01']) assert.equal(isPublished(no), false, no)
    assert.equal(PUBLISHED.source, vectors.pattern)
    assert.equal(isPublished('v0.2.0\n'), false, 'a line end is not part of a tag')
    assert.equal(NOTES_MAX, vectors.notesMaxChars)
  })
  for (const v of vectors.newest)
    test(`newest: ${v.name}`, () => {
      assert.equal(newestOf(v.tags), v.newest)
    })
  for (const v of vectors.compare)
    test(`compare: ${v.name}`, () => {
      assert.equal(compareVersions(v.installed, v.newest), v.result)
    })
  for (const v of vectors.notes)
    test(`notes: ${v.name}`, () => {
      assert.equal(notesFor(v.changelog, v.tag), v.notes)
    })
  test('notes: at most the limit, whole characters', () => {
    const long = `## v1.0.0\n\n${'é'.repeat(NOTES_MAX + 50)}\n`
    assert.equal(notesFor(long, 'v1.0.0'), 'é'.repeat(NOTES_MAX))
    const emoji = `## v1.0.0\n\n${'😀'.repeat(NOTES_MAX + 1)}`
    const cut = notesFor(emoji, 'v1.0.0')
    assert.equal(Array.from(cut).length, NOTES_MAX)
    assert.equal(cut.isWellFormed(), true)
  })
})

describe('published.check', () => {
  test('the newest tag and its notes, from github.com', async () => {
    const raw = `${REPO}/raw/v0.10.0/CHANGELOG.md`
    const { fetch, calls } = stub({
      [INFO]: () =>
        advert(
          refs(
            'refs/heads/v9.9.9',
            'refs/tags/v0.2.0',
            'refs/tags/v0.2.0^{}',
            'refs/tags/v0.10.0',
            'refs/tags/v0.10.0^{}',
            'refs/tags/v99.0.0-rc1',
          ),
        ),
      [raw]: () => new Response('## v0.10.0\n\n- Ten.\n\n## v0.2.0\n\n- Two.\n'),
    })
    assert.deepEqual(await check(REPO, { fetch, now }), { latest: 'v0.10.0', notes: '- Ten.', at: AT })
    assert.deepEqual(
      calls.map((c) => c.url),
      [INFO, raw],
    )
  })

  test('a branch named like a version is not a version', async () => {
    const { fetch } = stub({ [INFO]: () => advert(refs('refs/heads/v9.9.9', 'refs/heads/main')) })
    assert.deepEqual(await check(REPO, { fetch, now }), { error: 'none', at: AT })
  })

  test('sends no credential of any kind', async () => {
    const { fetch, calls } = stub({ [INFO]: () => advert(refs('refs/tags/v1.0.0')) })
    await check(REPO, { fetch, now })
    assert.ok(calls.length > 0)
    for (const c of calls) {
      const headers = new Headers(c.init?.headers)
      assert.equal(headers.get('authorization'), null)
      assert.equal(headers.get('cookie'), null)
      assert.equal(new URL(c.url).username, '')
      assert.equal(new URL(c.url).password, '')
    }
  })

  test('asks for the old protocol, whose answer lists the refs', async () => {
    const { fetch, calls } = stub({ [INFO]: () => advert(refs('refs/tags/v1.0.0')) })
    await check(REPO, { fetch, now })
    assert.equal(new Headers(calls[0]?.init?.headers).get('git-protocol'), null)
  })

  test('a private repository is no_access: 401, 403, 404', async () => {
    for (const status of [401, 403, 404]) {
      const { fetch } = stub({ [INFO]: () => new Response('no', { status }) })
      assert.deepEqual(await check(REPO, { fetch, now }), { error: 'no_access', at: AT }, String(status))
    }
  })

  test('a sign-in page with a 200 is no_access, not a list of tags', async () => {
    const { fetch } = stub({
      [INFO]: () =>
        new Response('<html>refs/tags/v9.9.9</html>', { headers: { 'content-type': 'text/html' } }),
    })
    assert.deepEqual(await check(REPO, { fetch, now }), { error: 'no_access', at: AT })
  })

  test('the server failing or limiting is network, never no_access', async () => {
    for (const status of [429, 500, 503]) {
      const { fetch } = stub({ [INFO]: () => new Response('later', { status }) })
      assert.deepEqual(await check(REPO, { fetch, now }), { error: 'network', at: AT }, String(status))
    }
  })

  test('a connection that fails is network', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed: https://user:hunter2@example/')
    }) as typeof globalThis.fetch
    const answer = await check(REPO, { fetch, now })
    assert.deepEqual(answer, { error: 'network', at: AT })
    assert.equal(JSON.stringify(answer).includes('hunter2'), false)
  })

  test('an empty repository has no published version', async () => {
    const empty =
      pkt('# service=git-upload-pack\n') +
      '0000' +
      pkt(`${'0'.repeat(40)} capabilities^{}\0multi_ack\n`) +
      '0000'
    const { fetch } = stub({ [INFO]: () => advert(empty) })
    assert.deepEqual(await check(REPO, { fetch, now }), { error: 'none', at: AT })
  })

  test('an answer that cannot be read is network, never "none"', async () => {
    const whole = refs('refs/tags/v1.0.0')
    const bad = {
      'garbage length': 'zzzz# service=git-upload-pack\n',
      truncated: whole.slice(0, whole.length - 25),
      'no service line': pkt(`${SHA} refs/tags/v1.0.0\n`),
      'no end marker': whole.slice(0, -4),
      'a length below the header': `0002${whole}`,
      empty: '',
    }
    for (const [name, body] of Object.entries(bad)) {
      const { fetch } = stub({ [INFO]: () => advert(body) })
      assert.deepEqual(await check(REPO, { fetch, now }), { error: 'network', at: AT }, name)
    }
  })

  test('URLs that are not https, or that carry credentials, are never asked', async () => {
    const urls = [
      'http://github.com/acme/widget',
      'git@github.com:acme/widget.git',
      'ssh://git@github.com/acme/widget',
      'file:///etc/passwd',
      'https://token@github.com/acme/widget',
      'https://user:secret@github.com/acme/widget',
      'https://:secret@github.com/acme/widget',
      'not a url',
      '',
    ]
    for (const url of urls) {
      const { fetch, calls } = stub({})
      assert.deepEqual(await check(url, { fetch, now }), { error: 'no_access', at: AT }, url)
      assert.equal(calls.length, 0, url)
    }
  })

  test('a trailing slash or .git asks the same place, and the notes too', async () => {
    for (const url of [`${REPO}/`, `${REPO}.git`, `${REPO}.git/`]) {
      const asked: string[] = []
      const fetch = (async (input: string | URL | Request) => {
        asked.push(String(input))
        return String(input).includes('/info/refs')
          ? advert(refs('refs/tags/v1.0.0'))
          : new Response('## v1.0.0\n\nOne.\n')
      }) as typeof globalThis.fetch
      assert.deepEqual(await check(url, { fetch, now }), { latest: 'v1.0.0', notes: 'One.', at: AT }, url)
      assert.equal(asked[1], `${REPO}/raw/v1.0.0/CHANGELOG.md`, url)
    }
  })

  test('other servers: the version, without notes, and nothing else is asked', async () => {
    const other = 'https://git.example.com/acme/widget'
    const lookalike = 'https://github.com.evil.example/acme/widget'
    for (const url of [other, lookalike]) {
      const { fetch, calls } = stub({
        [`${url}/info/refs?service=git-upload-pack`]: () => advert(refs('refs/tags/v1.0.0')),
      })
      assert.deepEqual(await check(url, { fetch, now }), { latest: 'v1.0.0', notes: '', at: AT }, url)
      assert.equal(calls.length, 1, url)
    }
  })

  test('notes that cannot be read do not lose the version', async () => {
    const raw = `${REPO}/raw/v1.0.0/CHANGELOG.md`
    const failing: Array<() => Response> = [
      () => new Response('## v1.0.0\n\nFrom an error page.\n', { status: 404 }),
      () => {
        throw new TypeError('fetch failed')
      },
      () => new Response('x'.repeat(MAX_BYTES + 1)),
    ]
    for (const route of failing) {
      const { fetch } = stub({ [INFO]: () => advert(refs('refs/tags/v1.0.0')), [raw]: route })
      assert.deepEqual(await check(REPO, { fetch, now }), { latest: 'v1.0.0', notes: '', at: AT })
    }
  })

  test('at most 2 MB: more is network, and the rest is not read', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        if (pulled > 100) return c.close()
        c.enqueue(new Uint8Array(512 * 1024))
      },
    })
    const { fetch } = stub({
      [INFO]: () => new Response(body, { headers: { 'content-type': ADVERTISEMENT } }),
    })
    assert.equal(MAX_BYTES, 2 * 1024 * 1024)
    assert.deepEqual(await check(REPO, { fetch, now }), { error: 'network', at: AT })
    assert.ok(pulled < 10, `read ${pulled} chunks`)
  })

  test('exactly 2 MB is still read', async () => {
    const other = 'https://git.example.com/a'
    const open = refs('refs/tags/v1.0.0').slice(0, -4)
    const filler = pkt(`${SHA} refs/heads/${'x'.repeat(900)}\n`)
    let body = open + filler.repeat(Math.floor((MAX_BYTES - open.length - 4) / filler.length))
    const gap = MAX_BYTES - body.length - 4
    if (gap) body += pkt(`${SHA} refs/heads/${'y'.repeat(gap - 4 - 40 - 1 - 11 - 1)}\n`)
    const whole = `${body}0000`
    assert.equal(Buffer.byteLength(whole), MAX_BYTES)
    const { fetch } = stub({ [`${other}/info/refs?service=git-upload-pack`]: () => advert(whole) })
    assert.deepEqual(await check(other, { fetch, now }), { latest: 'v1.0.0', notes: '', at: AT })
  })

  test('at most the time allowed: a silent server is network', async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof globalThis.fetch
    const answer = await check(REPO, { fetch: hang, now, timeoutMs: 20 })
    assert.deepEqual(answer, { error: 'network', at: AT })
  })

  test('at most the time allowed, also for a body that never ends', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const { fetch } = stub({
      [INFO]: () => new Response(body, { headers: { 'content-type': ADVERTISEMENT } }),
    })
    const answer = await Promise.race([
      check(REPO, { fetch, now, timeoutMs: 20 }),
      new Promise((r) => setTimeout(() => r('still waiting'), 2000)),
    ])
    assert.deepEqual(answer, { error: 'network', at: AT })
  })

  test('the default limit is 10 seconds', async () => {
    let signal: AbortSignal | null | undefined
    const realTimeout = AbortSignal.timeout
    const asked: number[] = []
    AbortSignal.timeout = (ms: number) => {
      asked.push(ms)
      return realTimeout.call(AbortSignal, ms)
    }
    try {
      const { fetch, calls } = stub({ [INFO]: () => advert(refs()) })
      await check(REPO, { fetch, now })
      signal = calls[0]?.init?.signal
    } finally {
      AbortSignal.timeout = realTimeout
    }
    assert.ok(signal instanceof AbortSignal)
    assert.deepEqual(asked, [10_000])
  })

  test('a redirect is followed only to https, and no further than 3 times', async () => {
    const to = (location: string) => () => new Response(null, { status: 302, headers: { location } })
    const moved = 'https://github.com/acme/moved/info/refs?service=git-upload-pack'
    const ok = stub({
      [INFO]: to(moved),
      [moved]: () => advert(refs('refs/tags/v1.0.0')),
      [`${REPO}/raw/v1.0.0/CHANGELOG.md`]: to('https://raw.example.com/one'),
      'https://raw.example.com/one': () => new Response('## v1.0.0\n\nOne.\n'),
    })
    assert.deepEqual(await check(REPO, { fetch: ok.fetch, now }), { latest: 'v1.0.0', notes: 'One.', at: AT })
    for (const c of ok.calls) assert.equal(c.init?.redirect, 'manual')

    const down = stub({ [INFO]: to('http://github.com/acme/widget/info/refs?service=git-upload-pack') })
    assert.deepEqual(await check(REPO, { fetch: down.fetch, now }), { error: 'network', at: AT })
    assert.equal(down.calls.length, 1, 'never asks over cleartext')

    const creds = stub({ [INFO]: to('https://user:pass@github.com/acme/moved') })
    assert.deepEqual(await check(REPO, { fetch: creds.fetch, now }), { error: 'network', at: AT })
    assert.equal(creds.calls.length, 1, 'never asks with credentials')

    let hops = 0
    const loop = (async () => {
      hops++
      return new Response(null, { status: 302, headers: { location: `https://github.com/l/${hops}` } })
    }) as typeof globalThis.fetch
    assert.deepEqual(await check(REPO, { fetch: loop, now }), { error: 'network', at: AT })
    assert.equal(hops, 4)
  })

  test('never answers "up to date": an error carries no version', async () => {
    const { fetch } = stub({ [INFO]: () => new Response('no', { status: 401 }) })
    const answer = await check(REPO, { fetch, now })
    assert.equal('latest' in answer, false)
  })
})

describe('the checker', () => {
  const FULL = () => ({ [INFO]: () => advert(refs('refs/tags/v0.2.0')) })
  const at = (t: number) => () => new Date(t)
  const T0 = Date.parse('2026-11-02T10:00:00.000Z')

  test('asks with only its User-Agent: no cookie, no key, nothing about the installation', async () => {
    const { fetch, calls } = stub({
      [INFO]: () => advert(refs('refs/tags/v0.2.0', 'refs/tags/v0.3.0-rc1')),
      [`${REPO}/raw/v0.2.0/CHANGELOG.md`]: () => new Response('## v0.2.0\n\n- Faster search.\n'),
    })
    const c = releaseChecker({ repo: REPO, version: '0.1.0', clock: at(T0), fetch })
    await c.check()
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.deepEqual([...new Headers(call.init?.headers).keys()], ['user-agent'])
      assert.equal(new Headers(call.init?.headers).get('user-agent'), 'rsc-brain/0.1.0')
      assert.equal(call.init?.body, undefined)
      assert.equal(call.init?.method ?? 'GET', 'GET')
    }
    assert.deepEqual(c.state(), {
      installed: 'v0.1.0',
      latest: 'v0.2.0',
      notes: '- Faster search.',
      checkedAt: '2026-11-02T10:00:00.000Z',
      error: null,
      lastAttemptAt: '2026-11-02T10:00:00.000Z',
    })
  })

  test('empty RSC_BRAIN_REPO_URL or RSC_BRAIN_RELEASES_URL: no address, and nothing is ever asked', async () => {
    assert.equal(repoUrl({ RSC_BRAIN_REPO_URL: '' }), null)
    assert.equal(repoUrl({ RSC_BRAIN_REPO_URL: '  ' }), null)
    assert.equal(repoUrl({ RSC_BRAIN_RELEASES_URL: '' }), null)
    assert.equal(repoUrl({ RSC_BRAIN_RELEASES_URL: '', RSC_BRAIN_REPO_URL: REPO }), null)
    assert.equal(repoUrl({}), DEFAULT_REPO_URL)
    assert.equal(repoUrl({ RSC_BRAIN_RELEASES_URL: 'https://example.com/list' }), DEFAULT_REPO_URL)
    assert.equal(repoUrl({ RSC_BRAIN_REPO_URL: ` ${REPO} ` }), REPO)
    assert.equal(DEFAULT_REPO_URL, 'https://github.com/ericrisco/rsc-brain')
    const { fetch, calls } = stub({})
    const c = releaseChecker({ repo: null, version: '0.1.0', clock: at(T0), fetch })
    await c.check()
    c.start()
    c.stop()
    assert.equal(calls.length, 0)
    assert.deepEqual(c.state(), {
      installed: 'v0.1.0',
      latest: null,
      notes: null,
      checkedAt: null,
      error: null,
      lastAttemptAt: null,
    })
  })

  test('once a day at most, however often it is asked to check', async () => {
    let now = T0
    const { fetch, calls } = stub(FULL())
    const c = releaseChecker({
      repo: 'https://git.example.com/a',
      version: '0.1.0',
      clock: () => new Date(now),
      fetch,
    })
    await c.check()
    const asked = calls.length
    now += 23 * 3600_000
    await c.check()
    assert.equal(calls.length, asked)
    now += 3600_000
    await c.check()
    assert.equal(calls.length, asked * 2)
  })

  test('a failure keeps what it knew and says so, never throws; the next answer clears it', async () => {
    let now = T0
    let route: () => Response = () => advert(refs('refs/tags/v0.2.0'))
    const fetch = (async () => route()) as typeof globalThis.fetch
    const c = releaseChecker({
      repo: 'https://git.example.com/a',
      version: '0.1.0',
      clock: () => new Date(now),
      fetch,
    })
    await c.check()
    const asked = new Date(now).toISOString()
    for (const [answer, error] of [
      [() => new Response('later', { status: 500 }), 'network'],
      [() => advert('garbage'), 'network'],
      [() => new Response('no', { status: 401 }), 'no_access'],
    ] as const) {
      route = answer
      now += 25 * 3600_000
      await c.check()
      const s = c.state()
      assert.equal(s.latest, 'v0.2.0')
      assert.equal(s.error, error)
      assert.equal(s.checkedAt, asked, 'the last time it had an answer')
      assert.equal(s.lastAttemptAt, new Date(now).toISOString())
    }
    route = () => advert(refs('refs/tags/v0.3.0'))
    now += 25 * 3600_000
    await c.check()
    assert.equal(c.state().latest, 'v0.3.0')
    assert.equal(c.state().error, null)
  })

  test('no published version is an answer: no version, said as such, and asked a day later', async () => {
    let now = T0
    const { fetch, calls } = stub({ [INFO]: () => advert(refs('refs/heads/main')) })
    const c = releaseChecker({ repo: REPO, version: '0.1.0', clock: () => new Date(now), fetch })
    await c.check()
    assert.equal(c.state().error, 'none')
    assert.equal(c.state().latest, null)
    assert.equal(c.state().checkedAt, new Date(now).toISOString())
    now += 23 * 3600_000
    await c.check()
    assert.equal(calls.length, 1)
  })

  test('a private repository is asked once a day: its answer will not change sooner', async () => {
    let now = T0
    const { fetch, calls } = stub({ [INFO]: () => new Response('no', { status: 404 }) })
    const c = releaseChecker({ repo: REPO, version: '0.1.0', clock: () => new Date(now), fetch })
    await c.check()
    assert.equal(c.state().error, 'no_access')
    now += 23 * 3600_000
    await c.check()
    assert.equal(calls.length, 1)
    now += 3600_000
    await c.check()
    assert.equal(calls.length, 2)
  })

  test('a failed check is tried again soon, then less often (15 min doubling up to 6 h)', async () => {
    let now = T0
    let route: () => Response = () => new Response('down', { status: 500 })
    let asked = 0
    const fetch = (async () => {
      asked++
      return route()
    }) as typeof globalThis.fetch
    const c = releaseChecker({
      repo: 'https://git.example.com/a',
      version: '0.1.0',
      clock: () => new Date(now),
      fetch,
    })
    await c.check()
    assert.equal(asked, 1)
    now += 14 * 60_000
    await c.check()
    assert.equal(asked, 1, 'not before 15 minutes')
    now += 60_000
    await c.check()
    assert.equal(asked, 2, 'again after 15 minutes')
    now += 29 * 60_000
    await c.check()
    assert.equal(asked, 2, 'then 30 minutes')
    now += 60_000
    await c.check()
    assert.equal(asked, 3)
    for (let i = 0; i < 6; i++) {
      now += 6 * 3600_000
      await c.check()
    }
    assert.equal(asked, 9, 'at most 6 hours apart')
    route = () => advert(refs('refs/tags/v0.2.0'))
    now += 6 * 3600_000
    await c.check()
    assert.equal(c.state().latest, 'v0.2.0')
    now += 6 * 3600_000
    await c.check()
    assert.equal(asked, 10, 'it answered: once a day again')
  })
})

describe('what the administration is told', () => {
  const none = {
    latest: null,
    notes: null,
    checkedAt: null,
    error: null,
    lastAttemptAt: null,
  }
  const installed = 'v0.2.0'
  const view = (latest: string | null, version = '0.2.0') =>
    releaseView({ ...none, installed, latest }, version)

  test('nothing checks: the version and no more', () => {
    assert.deepEqual(releaseView(null, '0.2.0'), {
      installed: 'v0.2.0',
      ...none,
      newer: false,
      ahead: false,
    })
  })
  test('newer and ahead come from the definition, in numeric order', () => {
    assert.deepEqual([view('v0.10.0', '0.9.0').newer, view('v0.10.0', '0.9.0').ahead], [true, false])
    assert.deepEqual([view('v0.2.0').newer, view('v0.2.0').ahead], [false, false])
    assert.deepEqual([view('v0.9.0', '0.10.0').newer, view('v0.9.0', '0.10.0').ahead], [false, true])
  })
  test('a preview comes before its release, and after the one before', () => {
    assert.deepEqual([view('v0.3.0', '0.3.0-rc.1').newer, view('v0.3.0', '0.3.0-rc.1').ahead], [true, false])
    assert.deepEqual([view('v0.2.0', '0.3.0-rc.1').newer, view('v0.2.0', '0.3.0-rc.1').ahead], [false, true])
  })
  test('a version that is not one is neither', () => {
    assert.deepEqual([view('v0.2.0', 'dev').newer, view('v0.2.0', 'dev').ahead], [false, false])
  })
  test('the error goes with the rest, and a known newer one stays known', () => {
    const v = releaseView(
      { ...none, installed, latest: 'v0.3.0', error: 'network', lastAttemptAt: '2026-11-02T10:00:00.000Z' },
      '0.2.0',
    )
    assert.equal(v.newer, true)
    assert.equal(v.error, 'network')
    assert.equal(v.lastAttemptAt, '2026-11-02T10:00:00.000Z')
  })
})
