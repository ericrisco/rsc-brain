// Rows read by pieces inside the export's snapshot: a cursor fetched a batch at a time, so a big brain never
// sits whole in memory (plan §3.5: the export is streamed).
import type { Db, Params, Row } from '../../db/db.ts'

const BATCH = 500
let n = 0

export async function* rowsOf<T extends Row = Row>(db: Db, sql: string, params: Params): AsyncGenerator<T> {
  n = (n + 1) % 1_000_000
  const name = `export_rows_${n}`
  await db.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params)
  try {
    for (;;) {
      const rows = await db.query<T>(`FETCH ${BATCH} FROM ${name}`)
      for (const r of rows) yield r
      if (rows.length < BATCH) break
    }
  } finally {
    // After a failure the transaction is over anyway; its own error is the one that counts.
    await db.query(`CLOSE ${name}`).catch(() => {})
  }
}
