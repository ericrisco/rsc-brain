// `npm run test:e2e` (plan §5.1, local lane only): the built web against the real server and a real
// PostgreSQL (RSC_BRAIN_PG_URL). verify.sh runs it when PostgreSQL is reachable and says why when not.
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4175)

export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/e2e',
  globalTeardown: './test/e2e/teardown.ts',
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: {
    command: 'node test/e2e/server.ts',
    url: `http://127.0.0.1:${PORT}/v1/health`,
    env: { E2E_PORT: String(PORT), RSC_BRAIN_PG_URL: process.env.RSC_BRAIN_PG_URL ?? '' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
