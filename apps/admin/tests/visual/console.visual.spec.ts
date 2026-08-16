import { expect, test } from "@playwright/test";

import { stabilizeForScreenshot, visualScenario } from "./fixtures";

// A visual baseline is only meaningful against a deliberately supplied, credential-free target.
test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to capture or compare visual baselines.");

test("captures the console frame across the visual matrix", async ({ page }, testInfo) => {
  const scenario = visualScenario(testInfo);

  await page.addInitScript(({ locale, theme }) => {
    window.localStorage.setItem("rsc-brain.locale", locale);
    window.localStorage.setItem("rsc-brain.theme", theme);
  }, scenario);
  await page.goto("/", { waitUntil: "networkidle" });
  await stabilizeForScreenshot(page);

  await expect(page).toHaveScreenshot(`console-${scenario.viewport}-${scenario.theme}-${scenario.locale}.png`, {
    fullPage: true,
  });
});
