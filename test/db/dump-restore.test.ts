// Spec v0.6 CA16: a copy made with the standard PostgreSQL tools restores whole into a new database — the
// search functions call each other with their schema, so the generated search columns of pages and entries
// are filled again under the empty search path pg_restore runs with — and searching works there.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import pg from 'pg'
import { PG_URL, skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const run = promisify(execFile)

// pg_dump refuses a server of a newer major version: then the test cannot run here, and says so.
async function toolsFor(url: string): Promise<string | null> {
  try {
    const { stdout } = await run('pg_dump', ['--version'])
    const tool = Number(/(\d+)\./.exec(stdout)?.[1])
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    const server = Math.floor(
      Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000,
    )
    await c.end()
    return tool >= server ? null : `pg_dump ${tool} cannot copy a PostgreSQL ${server} server`
  } catch {
    return 'pg_dump is not installed'
  }
}

describe('a pg_dump copy restores into a new database (CA16)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let target = ''
  let dir = ''
  let why: string | null = null

  before(async () => {
    w = await world()
    why = await toolsFor(w.url)
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    const web = await w.web(eric.id)
    for (const i of [1, 2, 3]) {
      const r = await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
        type: 'fact',
        title: `Fact ${i}`,
        content: `The canción number ${i} uses Louvain communities.`,
      })
      assert.equal(r.status, 201, r.text)
      const p = await w.callWeb(web, 'POST', '/v1/brains/yt/wiki/changes', {
        op: 'create',
        address: `songs/song-${i}`,
        type: 'topic',
        title: `Song ${i}`,
        summary: 'A song.',
        body: `Canción ${i}: about Louvain.`,
      })
      assert.equal(p.status, 201, p.text)
    }
    dir = await mkdtemp(join(tmpdir(), 'rscb-dump-'))
  })
  after(async () => {
    if (target) {
      const a = new pg.Client({ connectionString: PG_URL })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`)
      await a.end()
    }
    if (dir) await rm(dir, { recursive: true, force: true })
    await w.close()
  })

  it('the same pages and entries, and search finds them', async (t) => {
    if (why) return t.skip(why)
    const file = join(dir, 'brain.dump')
    await run('pg_dump', ['-Fc', '--no-owner', '-f', file, w.url])
    target = `brain_r_${randomBytes(6).toString('hex')}`
    const a = new pg.Client({ connectionString: PG_URL })
    await a.connect()
    await a.query(`CREATE DATABASE ${target} TEMPLATE template0`)
    await a.end()
    const u = new URL(w.url)
    u.pathname = `/${target}`
    // --exit-on-error: any table that does not load fails the test, not just a warning at the end.
    await run('pg_restore', ['--no-owner', '--exit-on-error', '-d', u.toString(), file])
    const c = new pg.Client({ connectionString: u.toString() })
    await c.connect()
    try {
      const count = async (url: string, table: string) => {
        const x = new pg.Client({ connectionString: url })
        await x.connect()
        const n = Number((await x.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
        await x.end()
        return n
      }
      for (const table of ['pages', 'entries', 'page_revisions']) {
        assert.equal(await count(u.toString(), table), await count(w.url, table), table)
      }
      const found = await c.query(
        "SELECT count(*)::int AS n FROM pages WHERE search @@ brain_query(ARRAY['cancion'], '{}', '{}')",
      )
      assert.equal(found.rows[0].n, 3)
      const entries = await c.query(
        "SELECT count(*)::int AS n FROM entries WHERE search @@ brain_query(ARRAY['louvain'], '{}', '{}')",
      )
      assert.equal(entries.rows[0].n, 3)
    } finally {
      await c.end()
    }
  })
})
