// Plan §3.2 (T004): the one door of the web to the network. Every route it calls is an operation of v1
// (spec B6: no private routes, constitution Brain P4); writes carry the anti-CSRF header of B4; a refusal
// arrives as { status, code, message, howToProceed }; a lost session leads to sign-in and back, only to
// an address inside the web.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError, createClient, type Transport } from '../../web/src/api/client.ts'
import { draft } from '../../web/src/api/draft.ts'
import {
  invalidate,
  invalidateByEvent,
  resetResources,
  resource,
  wantsFresh,
} from '../../web/src/api/resource.ts'
import { ROUTE_TABLE } from '../../web/src/api/routes.ts'
import { safeNext, signInPath } from '../../web/src/lib/nav.ts'
import { V1 } from '../api/v1.ts'

type Seen = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  credentials?: string
}

function fake(answer: (s: Seen) => { status: number; body?: unknown; text?: string } | Error) {
  const seen: Seen[] = []
  const transport: Transport = async (url, init) => {
    const s: Seen = { url, method: init.method, headers: init.headers, credentials: init.credentials }
    if (init.body !== undefined) s.body = init.body
    seen.push(s)
    const a = answer(s)
    if (a instanceof Error) throw a
    const text = a.text ?? (a.body === undefined ? '' : JSON.stringify(a.body))
    return { status: a.status, text: async () => text }
  }
  return { seen, transport }
}

const ERR = (code: string) => ({ error: { code, message: `${code} happened.`, howToProceed: `Do ${code}.` } })

describe('the route table of the web', () => {
  it('holds only operations of v1', () => {
    const pinned = new Set(V1)
    for (const [name, op] of Object.entries(ROUTE_TABLE)) {
      assert.ok(pinned.has(op.route), `${name}: ${op.route} is not an operation of v1`)
    }
  })
})

describe('the API client', () => {
  it('reads send the session cookie of this origin and no anti-CSRF header', async () => {
    const f = fake(() => ({ status: 200, body: { brains: [] } }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    assert.deepEqual(await api.call('brains'), { brains: [] })
    assert.equal(f.seen[0]?.url, '/v1/brains')
    assert.equal(f.seen[0]?.method, 'GET')
    assert.equal(f.seen[0]?.credentials, 'same-origin')
    assert.equal(f.seen[0]?.headers['x-requested-with'], undefined)
  })

  it('writes carry X-Requested-With: rsc-brain-web and a JSON body', async () => {
    const f = fake(() => ({ status: 200, body: { account: { id: 'acc_1' } } }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    await api.call('login', { body: { email: 'a@example.test', password: 'p' } })
    assert.equal(f.seen[0]?.method, 'POST')
    assert.equal(f.seen[0]?.headers['x-requested-with'], 'rsc-brain-web')
    assert.equal(f.seen[0]?.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(f.seen[0]?.body ?? ''), { email: 'a@example.test', password: 'p' })
  })

  it('fills path parameters (encoded) and the query', async () => {
    const f = fake(() => ({ status: 200, body: {} }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    await api.call('brain', { path: { slug: 'a b/c' } })
    await api.call('search', { query: { q: 'retention & intros', brains: undefined } })
    assert.equal(f.seen[0]?.url, '/v1/brains/a%20b%2Fc')
    assert.equal(f.seen[1]?.url, '/v1/search?q=retention+%26+intros')
  })

  it('a refusal becomes an ApiError with what happened and how to proceed', async () => {
    const f = fake(() => ({ status: 409, body: ERR('changed') }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    const err = await api.call('brains').catch((e: unknown) => e)
    assert.ok(err instanceof ApiError)
    assert.deepEqual(
      { status: err.status, code: err.code, message: err.message, howToProceed: err.howToProceed },
      { status: 409, code: 'changed', message: 'changed happened.', howToProceed: 'Do changed.' },
    )
  })

  // An edit on a page that moved on (CA10): the refusal brings the current version, and a change with
  // problems lists each one, so the screen can show them without losing what was typed.
  it('a refusal keeps the current version and the problems the server sends with it', async () => {
    const current = { page: { revision: 3 } }
    const problems = [{ op: 0, message: '"title" is longer than 200 characters.' }]
    const f = fake(() => ({
      status: 409,
      body: { error: { ...ERR('page_changed').error, current, problems } },
    }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    const err = await api.call('brains').catch((e: unknown) => e)
    assert.ok(err instanceof ApiError)
    assert.deepEqual(err.current, current)
    assert.deepEqual(err.problems, problems)
    const plain = await createClient({
      transport: fake(() => ({ status: 400, body: ERR('x') })).transport,
      onSignedOut: () => {},
      here: () => '/',
    })
      .call('brains')
      .catch((e: unknown) => e)
    assert.ok(plain instanceof ApiError)
    assert.equal(plain.current, undefined)
    assert.deepEqual(plain.problems, [])
  })

  it('a reply that is not the envelope still says what to do', async () => {
    const f = fake(() => ({ status: 502, text: '<html>bad gateway</html>' }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    const err = (await api.call('brains').catch((e: unknown) => e)) as ApiError
    assert.equal(err.status, 502)
    assert.equal(err.code, 'bad_answer')
    assert.ok(err.howToProceed)
  })

  it('no network is an "offline" ApiError, not a crash', async () => {
    const f = fake(() => new TypeError('Failed to fetch'))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    const err = (await api.call('brains').catch((e: unknown) => e)) as ApiError
    assert.equal(err.status, 0)
    assert.equal(err.code, 'offline')
    assert.match(err.howToProceed, /connection/i)
  })

  it('a 401 on a private operation signs the person out and returns them where they were', async () => {
    const f = fake(() => ({ status: 401, body: ERR('unauthorized') }))
    const out: string[] = []
    const api = createClient({
      transport: f.transport,
      onSignedOut: (to) => out.push(to),
      here: () => '/b/acme/wiki?type=decision',
    })
    await api.call('brains').catch(() => {})
    assert.deepEqual(out, ['/sign-in?next=%2Fb%2Facme%2Fwiki%3Ftype%3Ddecision'])
  })

  it('a 401 on a public operation (a wrong password) does not', async () => {
    const f = fake(() => ({ status: 401, body: ERR('bad_credentials') }))
    const out: string[] = []
    const api = createClient({
      transport: f.transport,
      onSignedOut: (to) => out.push(to),
      here: () => '/sign-in',
    })
    const err = (await api.call('login', { body: {} }).catch((e: unknown) => e)) as ApiError
    assert.equal(err.code, 'bad_credentials')
    assert.deepEqual(out, [])
  })

  it('a quiet call (who am I, at start) reports 401 without moving the person', async () => {
    const f = fake(() => ({ status: 401, body: ERR('unauthorized') }))
    const out: string[] = []
    const api = createClient({
      transport: f.transport,
      onSignedOut: (to) => out.push(to),
      here: () => '/b/x',
    })
    await api.call('me', { quiet: true }).catch(() => {})
    assert.deepEqual(out, [])
  })
})

describe('where sign-in returns to', () => {
  it('only an address inside the web', () => {
    assert.equal(safeNext('/b/acme'), '/b/acme')
    assert.equal(safeNext('/b/acme?x=1#y'), '/b/acme?x=1#y')
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      null,
      '/sign-in?next=/x',
      ' /b',
      '/b\nx',
    ]) {
      assert.equal(safeNext(bad), '/', String(bad))
    }
  })

  it('a sign-in address carries the next address only when it is safe', () => {
    assert.equal(signInPath('/b/acme'), '/sign-in?next=%2Fb%2Facme')
    assert.equal(signInPath('/'), '/sign-in')
    assert.equal(signInPath('//evil.example'), '/sign-in')
  })
})

describe('resources', () => {
  it('load once, are shared by key, and reload when invalidated', async () => {
    resetResources()
    let n = 0
    const load = async () => {
      n += 1
      return { n }
    }
    const a = resource('brains', load)
    const b = resource('brains', load)
    assert.equal(a, b)
    assert.equal(a.loading.value, true)
    await a.settled()
    assert.deepEqual(a.data.value, { n: 1 })
    assert.equal(a.loading.value, false)
    invalidate('brain')
    assert.equal(a.stale.value, true)
    await a.settled()
    assert.deepEqual(a.data.value, { n: 2 })
    assert.equal(a.stale.value, false)
    invalidate('other')
    assert.equal(n, 2)
  })

  it('a change in the wiki reloads the proposals open on it (an old base shows at once, PR21 review)', async () => {
    resetResources()
    let n = 0
    const r = resource('brain:growth:proposals:review:prp_1', async () => ({ n: ++n }))
    await r.settled()
    invalidateByEvent('wiki.changed', 'growth')
    await r.settled()
    assert.equal(n, 2)
    invalidateByEvent('wiki.changed', 'other')
    await r.settled()
    assert.equal(n, 2)
  })

  it('a screen that just made a resource does not ask again, even once its first answer is in', async () => {
    resetResources()
    let n = 0
    const r = resource('page', async () => ({ n: ++n }))
    await r.settled()
    // The first screen to look: the load it started is the fresh one (a fast answer must not count twice).
    assert.equal(wantsFresh(r), false)
    // Any later screen showing it again asks for a fresh one.
    assert.equal(wantsFresh(r), true)
    r.loading.value = true
    assert.equal(wantsFresh(r), false, 'not while one is on its way')
  })

  it('keep the last data on error, and say so', async () => {
    resetResources()
    let fail = false
    const r = resource('me', async () => {
      if (fail) throw new ApiError(500, 'internal', 'Broken.', 'Try again.')
      return { ok: 1 }
    })
    await r.settled()
    fail = true
    await r.reload()
    assert.deepEqual(r.data.value, { ok: 1 })
    assert.equal(r.error.value?.code, 'internal')
    fail = false
    await r.reload()
    assert.equal(r.error.value, undefined)
  })
})

describe('drafts', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      m,
    }
  }

  it('keep what was typed until it is sent', () => {
    const s = memory()
    const d = draft('invite.name', s)
    assert.equal(d.get(), '')
    d.set('Ana')
    assert.equal(draft('invite.name', s).get(), 'Ana')
    d.clear()
    assert.equal(draft('invite.name', s).get(), '')
  })

  it('never hold a password, a code or a token', () => {
    const s = memory()
    for (const key of ['signin.password', 'signin.code', 'reset.token', 'profile.tokenSecret', 'x.secret']) {
      assert.throws(() => draft(key, s), /never/, key)
    }
    assert.equal(s.m.size, 0)
  })
})

describe('a download through the client (an export, spec B7)', () => {
  const streamOf = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p))
        c.close()
      },
    })
  const zipAnswer =
    (parts: string[]): Transport =>
    async () => ({
      status: 200,
      text: async () => parts.join(''),
      headers: {
        get: (n: string) =>
          n === 'content-disposition'
            ? 'attachment; filename="rsc-brain-growth-readable-20261102T101010Z.zip"'
            : null,
      },
      body: streamOf(parts),
    })

  it('gives the file with the name the server gave, counting what arrives', async () => {
    const seen: number[] = []
    const api = createClient({
      transport: zipAnswer(['PK', 'abc', 'def']),
      onSignedOut: () => {},
      here: () => '/',
    })
    const got = await api.download(
      'exportBrain',
      { path: { slug: 'growth' }, query: { format: 'readable' } },
      (n) => seen.push(n),
    )
    assert.equal(got.name, 'rsc-brain-growth-readable-20261102T101010Z.zip')
    assert.equal(got.bytes, 8)
    assert.equal(await got.blob.text(), 'PKabcdef')
    assert.deepEqual(seen, [2, 5, 8])
  })

  it('asks with the session cookie, at the address of the operation, with its query', async () => {
    const f = fake(() => ({ status: 200, text: 'x' }))
    const api = createClient({ transport: f.transport, onSignedOut: () => {}, here: () => '/' })
    await api.download('exportBrain', {
      path: { slug: 'a b' },
      query: { format: 'faithful', includeForgotten: 1 },
    })
    assert.equal(f.seen[0]?.url, '/v1/brains/a%20b/export?format=faithful&includeForgotten=1')
    assert.equal(f.seen[0]?.method, 'GET')
    assert.equal(f.seen[0]?.credentials, 'same-origin')
    assert.equal(f.seen[0]?.headers['x-requested-with'], undefined)
  })

  it('a refusal arrives as an ApiError; a lost session leads to sign-in', async () => {
    let to = ''
    const f = fake(() => ({ status: 401, body: ERR('unauthorized') }))
    const api = createClient({
      transport: f.transport,
      onSignedOut: (t) => (to = t),
      here: () => '/b/x/settings',
    })
    await assert.rejects(api.download('exportBrain', { path: { slug: 'x' } }), (e: ApiError) => {
      assert.equal(e.code, 'unauthorized')
      return true
    })
    assert.match(to, /^\/sign-in/)
    const g = fake(() => ({ status: 503, body: ERR('under_maintenance') }))
    const api2 = createClient({ transport: g.transport, onSignedOut: () => {}, here: () => '/' })
    await assert.rejects(api2.download('exportBrain', { path: { slug: 'x' } }), /under_maintenance happened/)
    const h = fake(() => new Error('down'))
    const api3 = createClient({ transport: h.transport, onSignedOut: () => {}, here: () => '/' })
    await assert.rejects(
      api3.download('exportBrain', { path: { slug: 'x' } }),
      (e: ApiError) => e.code === 'offline',
    )
  })
})

describe('the web client: uploading a file (an import, B7 PR32)', () => {
  type Sent = { url: string; method: string; headers: Record<string, string>; size: number }
  const uploader = (answer: { status: number; body?: unknown } | Error, steps: number[] = []) => {
    const sent: Sent[] = []
    return {
      sent,
      upload: async (
        url: string,
        init: { method: string; headers: Record<string, string>; body: Blob },
        progress?: (sent: number, total: number) => void,
      ) => {
        sent.push({ url, method: init.method, headers: init.headers, size: init.body.size })
        for (const n of steps) progress?.(n, init.body.size)
        if (answer instanceof Error) throw answer
        const text = answer.body === undefined ? '' : JSON.stringify(answer.body)
        return { status: answer.status, text: async () => text }
      },
    }
  }
  const noFetch: Transport = async () => {
    throw new Error('an upload never goes through the JSON transport')
  }

  it('sends the file as the body, with the header of the web, and says how much has gone', async () => {
    const u = uploader({ status: 200, body: { report: { pages: 5 } } }, [3, 6])
    const api = createClient({ transport: noFetch, upload: u.upload, onSignedOut: () => {}, here: () => '/' })
    const seen: Array<[number, number]> = []
    const got = await api.upload<{ report: { pages: number } }>(
      'importBrain',
      { path: { slug: 'my brain' }, query: { name: 'docs.zip' } },
      new Blob(['PKzip']),
      (s, t) => seen.push([s, t]),
    )
    assert.equal(got.report.pages, 5)
    assert.deepEqual(u.sent, [
      {
        url: '/v1/brains/my%20brain/import?name=docs.zip',
        method: 'POST',
        headers: {
          accept: 'application/json',
          'x-requested-with': 'rsc-brain-web',
          'content-type': 'application/zip',
        },
        size: 5,
      },
    ])
    assert.deepEqual(seen, [
      [3, 5],
      [6, 5],
    ])
  })

  it('a refusal is an ApiError with the words of the server; a lost session leads to sign-in; no network is offline', async () => {
    const no = uploader({ status: 409, body: ERR('brain_not_empty') })
    const api = createClient({
      transport: noFetch,
      upload: no.upload,
      onSignedOut: () => {},
      here: () => '/',
    })
    await assert.rejects(
      api.upload('importBrain', { path: { slug: 'x' } }, new Blob(['x'])),
      (e: ApiError) => {
        assert.deepEqual([e.status, e.code], [409, 'brain_not_empty'])
        return true
      },
    )
    let to = ''
    const gone = uploader({ status: 401, body: ERR('unauthorized') })
    const api2 = createClient({
      transport: noFetch,
      upload: gone.upload,
      onSignedOut: (t) => (to = t),
      here: () => '/b/x/settings/import',
    })
    await assert.rejects(api2.upload('importBrain', { path: { slug: 'x' } }, new Blob(['x'])))
    assert.equal(to, '/sign-in?next=%2Fb%2Fx%2Fsettings%2Fimport')
    const down = uploader(new Error('down'))
    const api3 = createClient({
      transport: noFetch,
      upload: down.upload,
      onSignedOut: () => {},
      here: () => '/',
    })
    await assert.rejects(
      api3.upload('importBrain', { path: { slug: 'x' } }, new Blob(['x'])),
      (e: ApiError) => e.code === 'offline',
    )
  })
})
