// The real Brain for `npm run test:e2e` (plan §5.1, local lane): the handler of `rsc-brain serve` with the
// built web, on a fresh PostgreSQL database that is not set up yet, with mail captured instead of sent.
// A test reads the captured mail at /__e2e/mail (test-only; never part of the product).

import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { silentLog } from '../../src/core/log.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createHandler } from '../../src/http/app.ts'
import type { Message } from '../../src/mail/mail.ts'
import { freshDatabase } from '../helpers/pg.ts'
import { DIST_WEB } from '../web/fixture/fixture.ts'
import { DB_FILE } from './teardown.ts'

const port = Number(process.env.E2E_PORT ?? 4175)
const t = await freshDatabase()
// Playwright may stop this process before it can drop its database; the teardown drops it by name.
mkdirSync(dirname(DB_FILE), { recursive: true })
writeFileSync(DB_FILE, new URL(t.url).pathname.slice(1))
await migrate(t.db)
// Mail settings only; the first-time setup is left to the web.
await t.db.query('UPDATE installation SET mail = $1 WHERE id = 1', [
  JSON.stringify({
    host: 'smtp.test',
    port: 587,
    secure: false,
    user: null,
    password: null,
    from: { name: 'Brain', address: 'brain@example.test' },
  }),
])
const mails: Message[] = []
const handler = createHandler({
  db: t.db,
  clock: () => new Date(),
  secret: 'e2e-secret-of-at-least-thirty-two-characters',
  web: DIST_WEB,
  // A mail server that cannot be reached is one whose name starts with "down." (the failures of Admin › Email).
  mailTransport: (settings) => ({
    async send(m) {
      if (settings.host.startsWith('down.')) throw new Error(`getaddrinfo ENOTFOUND ${settings.host}`)
      mails.push(m)
    },
  }),
  log: silentLog,
})
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/__e2e/mail') {
    const to = url.searchParams.get('to')
    const m = [...mails].reverse().find((x) => x.to === to)
    res.writeHead(m ? 200 : 404, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(m ?? {}))
  }
  void handler(req, res)
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`e2e Brain on http://127.0.0.1:${port}\n`))
const stop = () => {
  server.closeAllConnections()
  server.close(() => void t.drop().then(() => process.exit(0)))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
