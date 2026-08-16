import { defineConfig } from "@playwright/test";

/**
 * E2E tests expect an explicitly supplied deployed/base URL. Keeping webServer out
 * of this config makes `--list` deterministic and avoids starting a process in CI.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
});
