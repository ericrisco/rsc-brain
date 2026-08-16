import type { Page, TestInfo } from "@playwright/test";

export type VisualScenario = {
  locale: "en" | "es";
  theme: "system" | "light" | "dark";
  viewport: "360" | "390" | "768" | "1024" | "1440";
};

/** Reads the scenario encoded by playwright.visual.config.ts without environment coupling. */
export function visualScenario(testInfo: TestInfo): VisualScenario {
  return testInfo.project.metadata as VisualScenario;
}

/** Use in future visual specs immediately before a screenshot to remove animation timing noise. */
export async function stabilizeForScreenshot(page: Page) {
  await page.addStyleTag({
    content: "*, *::before, *::after { animation-duration: 0s !important; caret-color: transparent !important; transition-duration: 0s !important; }",
  });
}
