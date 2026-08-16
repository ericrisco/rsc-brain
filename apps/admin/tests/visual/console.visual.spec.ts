import { expect, test } from "@playwright/test";

import { stabilizeForScreenshot, visualScenario } from "./fixtures";

test("captures the console frame across the visual matrix", async ({ page }, testInfo) => {
  const scenario = visualScenario(testInfo);

  await page.context().addCookies([
    {
      name: "rsc-brain.locale",
      value: scenario.locale,
      url: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3102",
      sameSite: "Lax",
    },
  ]);

  await page.addInitScript(({ theme }) => {
    window.localStorage.setItem("rsc-brain.theme", theme);
  }, scenario);
  const response = await page.goto("/login", { waitUntil: "networkidle" });
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("heading")).toBeVisible();
  await expect(page.locator("input[type='email']")).toBeVisible();
  await expect(page.locator("input[type='password']")).toBeVisible();
  await expect(page.getByRole("button")).toBeVisible();
  await stabilizeForScreenshot(page);

  await expect(page).toHaveScreenshot(`console-${scenario.viewport}-${scenario.theme}-${scenario.locale}.png`, {
    fullPage: true,
  });
});
