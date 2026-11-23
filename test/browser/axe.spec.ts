// Spec B6 CA16 (T050), and the web redesign's CA19: an automatic accessibility audit of every screen of the
// web map, in the three modes (light, dark, high contrast), on a desktop and on a phone. Serious and critical problems fail. The dialogs, the
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

// canvas-ui B18: on a desktop the rail is audited open (its names shown, the first time) and folded (its
// names as tooltips).
const SIZES = {
  desktop: { width: 1440, height: 900 },
  'desktop, rail folded': { width: 1440, height: 900 },
  phone: { width: 375, height: 740 },
} as const

for (const r of ROWS)
  for (const [theme, size] of [
    ['light', 'desktop'],
    ['dark', 'desktop'],
    ['contrast', 'desktop'],
    ['light', 'desktop, rail folded'],
    ['dark', 'desktop, rail folded'],
    ['contrast', 'desktop, rail folded'],
    ['light', 'phone'],
    ['dark', 'phone'],
    ['contrast', 'phone'],
  ] as const)
    test(`axe: ${r.name}, ${theme}, ${size}`, async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, r.preset ?? 'signed-in')
      await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
      if (size === 'desktop, rail folded')
        await page.addInitScript(() => localStorage.setItem('rscb.rail', 'folded'))
      await page.setViewportSize(SIZES[size])
      await page.goto(r.path)
      await expect(r.ready(page)).toBeVisible()
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
      await audit(page, `${r.name} ${theme} ${size}`)
    })
