// Spec B7 «Importar» (plan §3.6, T030, CA19): POST /v1/brains/{slug}/import takes a .zip of up to 50 MB from a
// curator in the web and answers with the report. Who may not import is refused before any of the body is read (a
// reader, a contributor, a key; someone outside is told the brain does not exist), a zip over 50 MB is refused as
// it arrives, and a brain with anything in it refuses the import and stays as it was (CA19). The command line
// imports a folder or a zip as an administrator who joined the brain and made itself its curator.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { WEB_HEADER } from '../../src/http/app.ts'
import { IMPORT_HOOKS, IMPORT_LIMITS, IMPORT_STATE } from '../../src/ops/import/import.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'
import { zipOfFolder } from '../helpers/zipfolder.ts'

const SAMPLE = new URL('../fixtures/docs-sample/', import.meta.url).pathname
const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const MB = 1024 * 1024

type Answer = { status: number; body: Record<string, unknown> & { error?: { code: string } }; text: string }
async function upload(
  w: World,
  who: { session?: string; key?: string },
  slug: string,
  body: Buffer,
  name = 'docs.zip',
) {
  const res = await fetch(`${w.base}/v1/brains/${slug}/import?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      ...(who.session ? { cookie: `rscb_session=${who.session}`, 'x-requested-with': WEB_HEADER } : {}),
      ...(who.key ? { authorization: `Bearer ${who.key}` } : {}),
    },
    body: new Uint8Array(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {}, text } as Answer
}

// A body that keeps coming slowly (it says 40 MB, under the limit): how the server answers, and whether it closes
// before the body is there.
function trickle(
  base: string,
  path: string,
  cookie: string,
  length = 40 * MB,
): Promise<{ status: string; closedMs: number | null; close: boolean; text: string }> {
  const u = new URL(base)
  return new Promise((resolve) => {
    const t0 = Date.now()
    let got = ''
    let tick: NodeJS.Timeout | undefined
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/zip\r\nX-Requested-With: rsc-brain-web\r\nCookie: rscb_session=${cookie}\r\nContent-Length: ${length}\r\n\r\n`,
      )
      tick = setInterval(() => {
        if (!s.destroyed) s.write(Buffer.alloc(16384, 0x20))
      }, 5)
    })
    s.on('data', (d) => {
      got += d.toString('latin1')
    })
    s.on('error', () => {})
    const done = (closedMs: number | null) => {
      if (tick) clearInterval(tick)
      s.destroy()
      resolve({
        status: /HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? '',
        closedMs,
        close: /connection: close/i.test(got),
        text: got,
      })
    }
    s.on('close', () => done(Date.now() - t0))
    setTimeout(() => done(null), 3000).unref()
  })
}

// An upload that has started and keeps its body coming until stopped.
function hold(base: string, path: string, cookie: string): Promise<{ stop(): void }> {
  const u = new URL(base)
  return new Promise((resolve) => {
    let tick: NodeJS.Timeout | undefined
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/zip\r\nX-Requested-With: rsc-brain-web\r\nCookie: rscb_session=${cookie}\r\nContent-Length: ${40 * MB}\r\n\r\n`,
      )
      tick = setInterval(() => {
        if (!s.destroyed) s.write(Buffer.alloc(1024, 0x20))
      }, 20)
      // Long enough for the server to take its turn.
      setTimeout(
        () =>
          resolve({
            stop: () => {
              clearInterval(tick)
              s.destroy()
            },
          }),
        300,
      )
    })
    s.on('error', () => {})
  })
}

// Second pass on PR32: the whole zip goes, then the client leaves before the answer (after `leaveMs`).
function sendAndLeave(
  base: string,
  path: string,
  cookie: string,
  body: Buffer,
  leaveMs: number,
): Promise<void> {
  const u = new URL(base)
  return new Promise((resolve) => {
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/zip\r\nX-Requested-With: rsc-brain-web\r\nCookie: rscb_session=${cookie}\r\nContent-Length: ${body.length}\r\n\r\n`,
      )
      s.write(body)
      setTimeout(() => {
        s.destroy()
        resolve()
      }, leaveMs)
    })
    s.on('error', () => {})
  })
}

// Second pass on PR32: a body that starts and then stops coming (`every`: ms between small pieces; 0: never again).
function stalled(
  base: string,
  path: string,
  cookie: string,
  every: number,
): Promise<{ status: string; code: string; ms: number }> {
  const u = new URL(base)
  return new Promise((resolve) => {
    const t0 = Date.now()
    let got = ''
    let tick: NodeJS.Timeout | undefined
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/zip\r\nX-Requested-With: rsc-brain-web\r\nCookie: rscb_session=${cookie}\r\nContent-Length: ${MB}\r\n\r\nPK`,
      )
      if (every) tick = setInterval(() => !s.destroyed && s.write(Buffer.alloc(8, 0x20)), every)
    })
    s.on('data', (d) => {
      got += d.toString('latin1')
    })
    s.on('error', () => {})
    const done = () => {
      if (tick) clearInterval(tick)
      s.destroy()
      resolve({
        status: /HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? '',
        code: /"code":"([a-z_]+)"/.exec(got)?.[1] ?? '',
        ms: Date.now() - t0,
      })
    }
    s.on('close', done)
    setTimeout(done, 4000).unref()
  })
}

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

describe('the import route and the command (CA19)', { skip: skipPg }, () => {
  let w: World
  let zip: Buffer
  const p: Record<string, { id: string; key: string }> = {}
  const s: Record<string, string> = {}
  const P = (k: string) => p[k] as { id: string; key: string }
  const S = (k: string) => s[k] as string
  const counts = async (slug: string) =>
    w.db.one(
      `SELECT (SELECT count(*)::int FROM pages x JOIN brains b ON b.id = x.brain_id WHERE b.slug = $1) AS pages,
              (SELECT count(*)::int FROM entries x JOIN brains b ON b.id = x.brain_id WHERE b.slug = $1) AS entries,
              (SELECT count(*)::int FROM wiki_log x JOIN brains b ON b.id = x.brain_id WHERE b.slug = $1) AS log,
              (SELECT imported_at FROM brains WHERE slug = $1) AS imported`,
      [slug],
    )

  before(async () => {
    w = await world()
    zip = await zipOfFolder(SAMPLE)
    for (const [k, o] of [
      ['eric', {}],
      ['rita', {}],
      ['carl', {}],
      ['out', {}],
      ['boss', { isAdmin: true }],
    ] as const) {
      p[k] = await w.person(k[0]?.toUpperCase() + k.slice(1), o)
      s[k] = await w.web(P(k).id)
    }
    for (const slug of ['fresh', 'full', 'cli', 'cli-zip', 'archived'])
      assert.equal((await w.call(P('eric').key, 'POST', '/v1/brains', { slug, name: slug })).status, 201)
    await w.member('fresh', P('rita').id, 'reader')
    await w.member('fresh', P('carl').id, 'contributor')
    const e = await w.call(P('eric').key, 'POST', '/v1/brains/full/entries', {
      type: 'fact',
      title: 'One',
      content: 'One entry.',
    })
    assert.equal(e.status, 201, e.text)
    assert.equal((await w.callWeb(S('eric'), 'POST', '/v1/brains/archived/archive')).status, 200)
  })
  after(async () => w.close())

  it('a curator in the web imports a zip and gets the report', async () => {
    const r = await upload(w, { session: S('eric') }, 'fresh', zip, 'docs-sample.zip')
    assert.equal(r.status, 200, r.text)
    const report = r.body.report as Record<string, unknown>
    assert.deepEqual([report.kind, report.pages, report.entries], ['docs', 5, 4])
    assert.deepEqual(report.totals, { unresolved: 2, ignored: 7, renamed: 1, recoded: 0 })
    assert.deepEqual(report.recoded, [])
    const b = await w.db.one("SELECT imported_from FROM brains WHERE slug = 'fresh'")
    assert.equal(b?.imported_from, 'docs-sample.zip')
    const audit = await w.db.one("SELECT outcome, actor_id, detail FROM audit WHERE action = 'brain.import'")
    assert.deepEqual([audit?.outcome, audit?.actor_id], ['ok', P('eric').id])
    assert.equal(JSON.parse(String(audit?.detail)).kind, 'docs')
    // The overview's third step is done.
    const ov = await w.callWeb(S('eric'), 'GET', '/v1/brains/fresh/overview')
    assert.equal((ov.body.firstSteps as { imported: boolean }).imported, true)
  })

  it('CA19: a brain with an entry refuses the import and stays as it was', async () => {
    const was = await counts('full')
    const r = await upload(w, { session: S('eric') }, 'full', zip)
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'brain_not_empty')
    assert.deepEqual(await counts('full'), was)
    // A brain filled by an import is not empty either.
    const again = await upload(w, { session: S('eric') }, 'fresh', zip)
    assert.deepEqual([again.status, again.body.error?.code], [409, 'brain_not_empty'])
    assert.equal(
      (
        await w.db.one(
          "SELECT count(*)::int AS n FROM audit WHERE action = 'brain.import' AND outcome = 'ok'",
        )
      )?.n,
      1,
    )
  })

  it('refuses a reader before reading the body, and closes the connection', async () => {
    const r = await trickle(w.base, '/v1/brains/fresh/import', S('rita'))
    assert.equal(r.status, '403', r.text.slice(0, 300))
    assert.equal(r.close, true)
    assert.ok(r.closedMs !== null && r.closedMs < 1500, `closed after ${r.closedMs} ms`)
    // So is a contributor; someone outside, the administration until it joins, does not see the brain; a full brain
    // says so before the body too.
    for (const [who, status] of [
      ['carl', '403'],
      ['out', '404'],
      ['boss', '404'],
    ] as const) {
      const t = await trickle(w.base, '/v1/brains/fresh/import', S(who))
      assert.equal(t.status, status, who)
      assert.ok(t.closedMs !== null && t.closedMs < 1500, `${who}: closed after ${t.closedMs} ms`)
    }
    const full = await trickle(w.base, '/v1/brains/full/import', S('eric'))
    assert.equal(full.status, '409')
    assert.ok(full.closedMs !== null && full.closedMs < 1500)
    const denied = await w.db.one(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'brain.import' AND outcome = 'denied' AND actor_id = $1",
      [P('rita').id],
    )
    assert.equal(denied?.n, 1)
  })

  it('is done in the web only: a key never imports, a curator’s own included', async () => {
    await w.call(P('eric').key, 'POST', '/v1/brains', { slug: 'keyed', name: 'Keyed' })
    for (const key of [P('eric').key, await w.token(P('eric').id, { perm: 'read' })]) {
      const r = await upload(w, { key }, 'keyed', zip)
      assert.deepEqual([r.status, r.body.error?.code], [403, 'web_only'])
    }
    // An archived brain is read-only.
    const a = await upload(w, { session: S('eric') }, 'archived', zip)
    assert.equal(a.status, 403, a.text)
  })

  it('refuses a zip over 50 MB as it arrives, said or not', async () => {
    const said = await trickle(w.base, '/v1/brains/keyed/import', S('eric'), 50 * MB + 1)
    assert.equal(said.status, '413')
    assert.match(said.text, /archive_too_large/)
    assert.equal(said.close, true)
    // Without a length: refused once more than 50 MB came.
    const res = await fetch(`${w.base}/v1/brains/keyed/import?name=big.zip`, {
      method: 'POST',
      headers: { cookie: `rscb_session=${S('eric')}`, 'x-requested-with': WEB_HEADER },
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < 51; i++) c.enqueue(new Uint8Array(MB))
          c.close()
        },
      }),
      duplex: 'half',
    } as RequestInit).catch((e: unknown) => e as Error)
    if (res instanceof Response) {
      assert.equal(res.status, 413)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'archive_too_large')
    }
    assert.deepEqual(await counts('keyed'), { pages: 0, entries: 0, log: 0, imported: null })
  })

  it('the report names a file read as Windows-1252 and a link to a file left out (review of PR32)', async () => {
    await w.call(P('eric').key, 'POST', '/v1/brains', { slug: 'latin', name: 'Latin' })
    const { rawZip } = await import('../helpers/rawzip.ts')
    const z = rawZip([
      { name: 'wiki/caf.md', data: Buffer.from('# Caf\xe9\n\nSee ![d](d.png).\n', 'latin1') },
      { name: 'raw/x.md', data: 'note' },
      { name: 'wiki/d.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]) },
    ])
    const r = await upload(w, { session: S('eric') }, 'latin', z)
    assert.equal(r.status, 200, r.text.slice(0, 300))
    const report = r.body.report as {
      recoded: string[]
      unresolved: Array<{ target: string; why: string }>
      totals: { recoded: number }
    }
    assert.deepEqual([report.recoded, report.totals.recoded], [['wiki/caf.md'], 1])
    assert.deepEqual(
      report.unresolved.map((u) => u.why),
      ['left_out'],
    )
  })

  it('takes a zip of more than 1 MB (the route has its own limit)', async () => {
    await w.call(P('eric').key, 'POST', '/v1/brains', { slug: 'big-ok', name: 'Big ok' })
    const { rawZip } = await import('../helpers/rawzip.ts')
    const { randomBytes } = await import('node:crypto')
    const z = rawZip([
      { name: 'wiki/a.md', data: '# A' },
      { name: 'raw/blob.bin', data: randomBytes(3 * MB), method: 0 },
    ])
    assert.ok(z.length > 3 * MB)
    const r = await upload(w, { session: S('eric') }, 'big-ok', z)
    assert.equal(r.status, 200, r.text.slice(0, 300))
    const report = r.body.report as { pages: number; ignored: unknown[] }
    assert.equal(report.pages, 1)
    assert.deepEqual(report.ignored, [{ path: 'raw/blob.bin', why: 'too_large' }])
  })

  it('one import at a time in the installation: another, into any brain, is told to wait (review of PR32)', async () => {
    for (const slug of ['slow', 'other'])
      await w.call(P('eric').key, 'POST', '/v1/brains', { slug, name: slug })
    const first = await hold(w.base, '/v1/brains/slow/import?name=a.zip', S('eric'))
    try {
      for (const slug of ['other', 'slow']) {
        const r = await upload(w, { session: S('eric') }, slug, zip)
        assert.deepEqual([r.status, r.body.error?.code], [409, 'import_busy'], slug)
        assert.match(r.text, /Another import is running/)
      }
    } finally {
      first.stop()
    }
    // Once the first one is gone, the next goes.
    let r: Answer | null = null
    for (let i = 0; i < 40; i++) {
      r = await upload(w, { session: S('eric') }, 'other', zip)
      if (r.body.error?.code !== 'import_busy') break
      await new Promise((ok) => setTimeout(ok, 50))
    }
    assert.equal(r?.status, 200, r?.text)
  })

  it('a client that leaves does not give back the turn while its import still runs; the import stops (second pass)', async () => {
    const slugs = ['gone-1', 'gone-2', 'gone-3', 'gone-4']
    for (const slug of slugs) await w.call(P('eric').key, 'POST', '/v1/brains', { slug, name: slug })
    let inside = 0
    let peak = 0
    let entered = 0
    let wrote = 0
    IMPORT_HOOKS.writing = () => {
      wrote += 1
    }
    IMPORT_HOOKS.beforeWrite = async () => {
      entered += 1
      inside += 1
      peak = Math.max(peak, inside)
      await new Promise((ok) => setTimeout(ok, 400))
      inside -= 1
    }
    try {
      for (const slug of slugs) {
        await sendAndLeave(w.base, `/v1/brains/${slug}/import?name=a.zip`, S('eric'), zip, 60)
        await new Promise((ok) => setTimeout(ok, 60))
      }
      for (let i = 0; i < 100 && (IMPORT_STATE.running > 0 || inside > 0); i++)
        await new Promise((ok) => setTimeout(ok, 50))
    } finally {
      delete IMPORT_HOOKS.beforeWrite
      delete IMPORT_HOOKS.writing
    }
    assert.ok(entered >= 1)
    // Stopped before its transaction: nothing was even begun.
    assert.equal(wrote, 0)
    assert.equal(peak, 1, 'two imports ran at once')
    assert.equal(IMPORT_STATE.running, 0)
    // Whoever left took nothing with them: no brain was written.
    for (const slug of slugs)
      assert.deepEqual(await counts(slug), { pages: 0, entries: 0, log: 0, imported: null })
  })

  it('a body that stops coming, or takes too long, is answered 408 and gives the turn back (second pass)', async () => {
    await w.call(P('eric').key, 'POST', '/v1/brains', { slug: 'stall', name: 'Stall' })
    const was = { ...IMPORT_LIMITS }
    IMPORT_LIMITS.stallMs = 300
    IMPORT_LIMITS.totalMs = 3000
    try {
      // Nothing more comes: refused after the pause, long before the whole time is up.
      const still = await stalled(w.base, '/v1/brains/stall/import?name=a.zip', S('eric'), 0)
      assert.deepEqual([still.status, still.code], ['408', 'upload_timeout'])
      assert.ok(still.ms >= 250 && still.ms < 1500, String(still.ms))
      // It keeps coming, too slowly: refused once the whole time is up.
      IMPORT_LIMITS.totalMs = 800
      const slow = await stalled(w.base, '/v1/brains/stall/import?name=a.zip', S('eric'), 50)
      assert.deepEqual([slow.status, slow.code], ['408', 'upload_timeout'])
      assert.ok(slow.ms >= 700 && slow.ms < 3000, String(slow.ms))
    } finally {
      Object.assign(IMPORT_LIMITS, was)
    }
    assert.equal(IMPORT_STATE.running, 0)
    const r = await upload(w, { session: S('eric') }, 'stall', zip)
    assert.equal(r.status, 200, r.text)
  })

  it('refuses what is not a zip it can read, and changes nothing', async () => {
    const r = await upload(w, { session: S('eric') }, 'keyed', Buffer.from('not a zip'))
    assert.deepEqual([r.status, r.body.error?.code], [422, 'invalid_archive'])
    const evil = Buffer.from(zip)
    const at = evil.indexOf(Buffer.from('wiki/people/ada.md'))
    evil.write('../../people/ada.md', at, 'latin1')
    const e = await upload(w, { session: S('eric') }, 'keyed', evil)
    assert.deepEqual([e.status, e.body.error?.code], [422, 'invalid_archive'])
    assert.deepEqual(await counts('keyed'), { pages: 0, entries: 0, log: 0, imported: null })
  })

  it('the command line: an administrator who joined and made itself curator imports a folder or a zip', async () => {
    const env = { RSC_BRAIN_DATABASE_URL: w.url }
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [P('boss').id]))?.email)
    // Not joined yet: the brain is not found, and nothing changes.
    const out = await run(['import', '--brain', 'cli', '--from', SAMPLE, '--as', email], env)
    assert.equal(out.code, 1, out.err)
    assert.match(out.err, /not found|no brain/i)
    await w.callWeb(S('boss'), 'POST', '/v1/admin/brains/cli/join')
    const reader = await run(['import', '--brain', 'cli', '--from', SAMPLE, '--as', email], env)
    assert.equal(reader.code, 1)
    assert.match(reader.err, /curator/)
    for (const slug of ['cli', 'cli-zip']) {
      await w.callWeb(S('boss'), 'POST', `/v1/admin/brains/${slug}/join`)
      await w.callWeb(S('boss'), 'POST', `/v1/admin/brains/${slug}/curator`, { account: P('boss').id })
    }
    const ok = await run(['import', '--brain', 'cli', '--from', SAMPLE, '--as', email, '--json'], env)
    assert.equal(ok.code, 0, ok.err)
    const report = JSON.parse(ok.out) as { kind: string; pages: number }
    assert.deepEqual([report.kind, report.pages], ['docs', 5])
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(`${tmpdir()}/rsc-brain-import-cli-`)
    try {
      await writeFile(`${dir}/docs.zip`, zip)
      const z = await run(['import', '--brain', 'cli-zip', '--from', `${dir}/docs.zip`, '--as', email], env)
      assert.equal(z.code, 0, z.err)
      assert.match(z.out, /Imported 5 pages and 4 entries into cli-zip/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    // Who it was, in the log and the audit; the key the command made for it never works.
    // The log names no one in its text (a name there could not be anonymised): who it was is its actor.
    const log = await w.db.one(
      "SELECT summary, actor_id FROM wiki_log l JOIN brains b ON b.id = l.brain_id WHERE b.slug = 'cli'",
    )
    assert.match(String(log?.summary), /^Imported from docs-sample/)
    assert.equal(log?.actor_id, P('boss').id)
    const keys = await w.db.query(
      "SELECT kind, revoked_at FROM credentials WHERE account_id = $1 AND name = 'Command line import'",
      [P('boss').id],
    )
    assert.equal(keys.length, 2)
    for (const k of keys) assert.deepEqual([k.kind, k.revoked_at !== null], ['web', true])
    // Someone who is not an administrator, or no such person: refused.
    const notAdmin = await run(
      [
        'import',
        '--brain',
        'cli',
        '--from',
        SAMPLE,
        '--as',
        String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [P('eric').id]))?.email),
      ],
      env,
    )
    assert.equal(notAdmin.code, 1)
    assert.match(notAdmin.err, /administrator/)
    const usage = await run(['import', '--brain', 'cli'], env)
    assert.equal(usage.code, 2)
  })
})
