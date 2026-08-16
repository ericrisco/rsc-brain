import { expect, test } from "@playwright/test";

test("serves the console document with hardened response headers", async ({ page }) => {
  const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", /en|es/);
  expect(response?.headers()["content-security-policy"]).toContain("script-src");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
});

test("reflows at 320 CSS pixels without horizontal document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/login", { waitUntil: "networkidle" });

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
