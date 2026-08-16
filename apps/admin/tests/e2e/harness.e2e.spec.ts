import { expect, test } from "@playwright/test";

// The harness never boots Next or assumes credentials. CI can opt into a real target
// by providing PLAYWRIGHT_BASE_URL; until then this remains a visible, passing smoke.
test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to run browser assertions.");

test("serves the console document from the configured target", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", /en|es/);
});
