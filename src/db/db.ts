// The one way the server talks to PostgreSQL: parameterised queries ($1, $2…) and transactions.
// A transaction hands its callback a Db bound to one connection; nested tx() calls reuse it.
import pg from 'pg'

export type Params = readonly unknown[]
export type Row = Record<string, unknown>

export type Db = {
  query<T extends Row = Row>(text: string, params?: Params): Promise<T[]>
  one<T extends Row = Row>(text: string, params?: Params): Promise<T | undefined>
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
}

export type Pool = Db & { close(): Promise<void> }

type Queryable = { query(text: string, params?: unknown[]): Promise<pg.QueryResult> }

function over(q: Queryable, tx: Db['tx']): Db {
  return {
    async query<T extends Row>(text: string, params: Params = []) {
      const res = await q.query(text, [...params])
      return res.rows as T[]
    },
    async one<T extends Row>(text: string, params: Params = []) {
      const res = await q.query(text, [...params])
      return res.rows[0] as T | undefined
    },
    tx,
  }
}

export function openPool(url: string, o: { max?: number } = {}): Pool {
  const pool = new pg.Pool({ connectionString: url, max: o.max ?? 10 })
  // An idle client that errors (server restart) must not crash the process; the next query retries.
  pool.on('error', () => {})
  const tx = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inner: Db = over(client, (f) => f(inner))
      const out = await fn(inner)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
  return { ...over(pool, tx), close: () => pool.end() }
}
