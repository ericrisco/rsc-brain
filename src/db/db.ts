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

// `session` hands one connection of its own to `fn`, outside any transaction (its tx() runs on that same
// connection), for work that holds a session-level lock across several transactions. The connection is closed
// afterwards, never given back to the pool, so whatever it held (an advisory lock) ends with it.
export type Pool = Db & { close(): Promise<void>; session<T>(fn: (db: Db) => Promise<T>): Promise<T> }

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
  const txOn = async <T>(client: pg.PoolClient, fn: (db: Db) => Promise<T>): Promise<T> => {
    try {
      await client.query('BEGIN')
      const inner: Db = over(client, (f) => f(inner))
      const out = await fn(inner)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  }
  const tx = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      return await txOn(client, fn)
    } finally {
      client.release()
    }
  }
  const session = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      return await fn(over(client, (f) => txOn(client, f)))
    } finally {
      // Closed, not reused: a lock it may still hold goes with it.
      client.release(true)
    }
  }
  return { ...over(pool, tx), close: () => pool.end(), session }
}
