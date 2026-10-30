// Runs the fixture API on a fixed port: Playwright starts it for `npm run test:web`, and a person can walk
// the web against it (open /__fixture/use?preset=signed-in, or fresh, signed-out, insecure).
import { startFixture } from './fixture.ts'

const port = Number(process.env.FIXTURE_PORT ?? 4173)
const fx = await startFixture({ port })
process.stdout.write(`fixture API and web on ${fx.url}\n`)
const stop = () => void fx.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
