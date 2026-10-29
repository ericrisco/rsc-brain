#!/usr/bin/env node
// rsc-brain command line. Each command says what it did, or what to do when it cannot.
import { readConfig } from '../config.ts'
import { openPool } from '../db/db.ts'
import { migrate } from '../db/migrate.ts'

const HELP = `rsc-brain — self-hosted knowledge server for AI agents

Usage:
  rsc-brain migrate     apply pending database migrations
  rsc-brain help        show this help

Environment:
  RSC_BRAIN_DATABASE_URL   PostgreSQL connection URL (required)
`

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? 'help'
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP)
    return 0
  }
  if (cmd === 'migrate') {
    const db = openPool(readConfig().databaseUrl, { max: 1 })
    try {
      const applied = await migrate(db)
      process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is up to date.\n')
      return 0
    } finally {
      await db.close()
    }
  }
  process.stderr.write(`Unknown command "${cmd}". Run "rsc-brain help" to see the commands.\n`)
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
