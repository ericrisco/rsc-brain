// CA18 of spec B3: on a brain with 10 000 pages and 100 000 entries, 95 % of 100 varied searches by words
// answer in under a second. Runs outside CI, against the PostgreSQL in RSC_BRAIN_PG_URL (a throwaway
// database is created and dropped):
//   RSC_BRAIN_PG_URL=postgres://… node scripts/bench-search.ts
import { world } from '../test/helpers/world.ts'

const PAGES = Number(process.env.BENCH_PAGES ?? 10_000)
const ENTRIES = Number(process.env.BENCH_ENTRIES ?? 100_000)
const SEARCHES = 100

const WORDS = `retention audience voice narrator intro hook camera lens light sound music edit cut scene story
script thumbnail title channel video short long render color grade export upload schedule publish comment
reply subscriber growth trend topic idea draft review approve reject budget sponsor brand logo font style
guide rule decision lesson attempt fact preference correction summary note step plan goal metric chart week
month quarter year launch test result error fix bug feature release version update change design layout
page wiki journal search memory agent factory pipeline gate approval email telegram server database query
index vector meaning word phrase spanish english voz público retener claro rápido lento grabar editar
cámara luz sonido música guion miniatura título canal vídeo corto largo color exportar subir programar`
  .split(/\s+/)
  .filter(Boolean)

function rnd(seed: number) {
  let s = seed
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648
    return s / 2_147_483_648
  }
}

async function main() {
  if (!process.env.RSC_BRAIN_PG_URL) throw new Error('Set RSC_BRAIN_PG_URL.')
  const w = await world()
  try {
    const eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'bench', purpose: 'Benchmark.' })
    const first = await w.call(eric.key, 'POST', '/v1/brains/bench/entries', {
      type: 'note',
      title: 'seed',
      content: 'seed',
    })
    const entry = await w.call(
      eric.key,
      'GET',
      `/v1/entries/${(first.body.receipt as { entryId: string }).entryId}`,
    )
    const sessionId = (entry.body.entry as { sessionId: string }).sessionId
    const brain = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'bench'")
    const t0 = Date.now()
    const text = (n: number, salt: string) =>
      `(SELECT string_agg(($1::text[])[1 + abs(hashtext(g::text || '${salt}' || i::text)) % cardinality($1::text[])], ' ')
          FROM generate_series(1, ${n}) i)`
    for (let from = 1; from <= ENTRIES; from += 10_000) {
      const to = Math.min(ENTRIES, from + 9_999)
      await w.db.query(
        `INSERT INTO entries (id, brain_id, session_id, type, title, content, author_id, norm_hash, created_at, updated_at)
         SELECT 'ent_b' || g, $2, $3, 'note', ${text(5, 't')}, ${text(60, 'c')}, $4, md5(g::text),
                $5::timestamptz - (g || ' minutes')::interval, $5
           FROM generate_series(${from}, ${to}) g`,
        [WORDS, brain?.id, sessionId, eric.id, w.now],
      )
    }
    await w.db.query(
      `INSERT INTO pages (id, brain_id, address, type, title, summary, body, status, created_at, updated_at)
       SELECT 'pg_b' || g, $2, 'area-' || (g % 50) || '/page-' || g, 'topic', ${text(4, 'p')}, ${text(15, 's')},
              ${text(400, 'b')}, CASE WHEN g % 10 = 0 THEN 'stale' ELSE 'current' END,
              $3::timestamptz - (g || ' minutes')::interval, $3
         FROM generate_series(1, ${PAGES}) g`,
      [WORDS, brain?.id, w.now],
    )
    await w.db.query(
      `INSERT INTO page_addresses (brain_id, address, page_id, created_at)
       SELECT brain_id, address, id, created_at FROM pages WHERE brain_id = $1`,
      [brain?.id],
    )
    await w.db.query('ANALYZE entries; ANALYZE pages; ANALYZE page_addresses')
    process.stdout.write(`Loaded ${PAGES} pages and ${ENTRIES} entries in ${Date.now() - t0} ms.\n`)
    if (process.env.BENCH_KEEP) {
      process.stdout.write(`Kept: ${w.url}\n`)
      process.exit(0)
    }

    const r = rnd(42)
    const pick = () => WORDS[Math.floor(r() * WORDS.length)] as string
    const shapes = [
      () => pick(),
      () => `${pick()} ${pick()}`,
      () => `${pick()} ${pick()} ${pick()}`,
      () => `"${pick()} ${pick()}"`,
      () => `${pick()} -${pick()}`,
      () => `${pick()} ${pick()}&in=pages`,
      () => `${pick()}&include=stale,superseded`,
      () => `${pick()} ${pick()}&neighbours=1`,
      () => `${pick()}&prefix=area-7`,
      () => `${pick()} ${pick()}&offset=40`,
    ]
    // A running server has its cache warm: ten searches first, not counted.
    const warm = Number(process.env.BENCH_WARMUP ?? 10)
    for (let i = 0; i < warm; i++) await w.call(eric.key, 'GET', `/v1/search?q=${encodeURIComponent(pick())}`)
    const times: number[] = []
    for (let i = 0; i < SEARCHES; i++) {
      const [words, extra] = (shapes[i % shapes.length] as () => string)().split('&', 2)
      const path = `/v1/search?q=${encodeURIComponent(words ?? '')}${extra ? `&${extra}` : ''}`
      const s = performance.now()
      const res = await w.call(eric.key, 'GET', path)
      times.push(performance.now() - s)
      if (process.env.BENCH_VERBOSE)
        process.stdout.write(`${(performance.now() - s).toFixed(0).padStart(6)} ms  ${path}\n`)
      if (res.status !== 200) throw new Error(`${path} → ${res.status} ${res.text}`)
    }
    times.sort((a, b) => a - b)
    const at = (p: number) =>
      times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)] as number
    const p95 = at(95)
    process.stdout.write(
      `${SEARCHES} searches: p50 ${at(50).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${at(100).toFixed(0)} ms.\n`,
    )
    process.stdout.write(p95 < 1000 ? 'CA18: PASS (95 % under 1 s)\n' : 'CA18: FAIL\n')
    process.exitCode = p95 < 1000 ? 0 : 1
  } finally {
    await w.close()
  }
}

await main()
