import { defineConfig } from "@playwright/test";

const viewports = [
  { name: "360", viewport: { width: 360, height: 800 } },
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "768", viewport: { width: 768, height: 1024 } },
  { name: "1024", viewport: { width: 1024, height: 768 } },
  { name: "1440", viewport: { width: 1440, height: 900 } },
] as const;

const themes = ["system", "light", "dark"] as const;
const locales = ["en", "es"] as const;

/**
 * A visual spec runs once per viewport/theme/locale project. Specs can read
 * `testInfo.project.metadata` and set the corresponding UI preference before
 * navigation; screenshots never update implicitly, preventing baseline drift.
 */
export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "**/*.visual.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: viewports.flatMap(({ name: viewportName, viewport }) =>
    themes.flatMap((theme) =>
      locales.map((locale) => ({
        name: `${viewportName}-${theme}-${locale}`,
        metadata: { viewport: viewportName, theme, locale },
        use: {
          browserName: "chromium" as const,
          viewport,
          locale,
          colorScheme: theme === "system" ? "no-preference" : theme,
          reducedMotion: "reduce" as const,
        },
      })),
    ),
  ),
});
