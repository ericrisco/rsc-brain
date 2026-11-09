// `npm run test:web` (plan §5.1, CI and local): the built web (dist/web) against the fixture API, in
// Chromium. Run `npm run build` first; verify.sh does.
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.FIXTURE_PORT ?? 4174)

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: 'test-results/web',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // A still picture by default: with motion allowed the graph's cloud turns at rest (spec amendment
    // 2026-11-09, CA12), so checks that read where a page is drawn and then click it run on the still view.
    // The tests of motion (the turn, the pulses, CA5 to CA7) ask for 'no-preference' themselves.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/web/fixture/main.ts',
    url: `http://127.0.0.1:${PORT}/v1/health`,
    env: { FIXTURE_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 20_000,
  },
})
