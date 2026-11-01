// Spec B6 CA16 (T050): an automatic accessibility audit of every screen of the web map, in the dark theme
// and the light one, on a desktop and on a phone. Serious and critical problems fail. The dialogs, the
// editor, the open source panel and other states are audited in each screen's own spec and in a11y.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'
import { ROWS } from './screens.ts'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 375, height: 740 },
} as const

for (const r of ROWS)
  for (const [theme, size] of [
    ['dark', 'desktop'],
    ['light', 'desktop'],
    ['dark', 'phone'],
    ['light', 'phone'],
  ] as const)
    test(`axe: ${r.name}, ${theme}, ${size}`, async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, r.preset ?? 'signed-in')
      await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
      await page.setViewportSize(SIZES[size])
      await page.goto(r.path)
      await expect(r.ready(page)).toBeVisible()
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
      await audit(page, `${r.name} ${theme} ${size}`)
    })
