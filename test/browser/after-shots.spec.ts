// Spec canvas-ui CA10 (plan B19): the "after" pictures, set beside the reference ones for a person to judge.
// Not a check: it runs only with SHOTS_DIR set (`SHOTS_DIR=… npx playwright test after-shots`), and writes
// each screen at 1920×1080 and 1366×768 into that folder, named brain-<screen>-<width>.png.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'
import { ROWS } from './screens.ts'

const DIR = process.env.SHOTS_DIR ?? ''
const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
] as const
const PICKED = ['home', 'overview', 'wiki map', 'proposals', 'proposal', 'activity', 'health', 'page']
const file = (name: string, width: number) =>
  join(DIR, `brain-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${width}.png`)
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

test.describe('after shots', () => {
  test.skip(!DIR, 'only with SHOTS_DIR')

  for (const size of SIZES) {
    test(`the screens at ${size.width}×${size.height}`, async ({ page, context, baseURL }) => {
      test.slow()
      const s = await scenario(context, baseURL as string, 'signed-in')
      await page.addInitScript(() => localStorage.setItem('rscb.theme', 'light'))
      await page.setViewportSize(size)
      for (const row of ROWS.filter((r) => PICKED.includes(r.name))) {
        await page.goto(row.path)
        if (row.seed) await row.seed(s)
        await expect(row.ready(page)).toBeVisible()
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: file(row.name, size.width) })
      }
    })

    test(`the graph at ${size.width}×${size.height}`, async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
      await page.addInitScript(() => localStorage.setItem('rscb.theme', 'light'))
      await page.setViewportSize(size)
      await page.goto('/b/growth/wiki/graph')
      await settled(page)
      await page.screenshot({ path: file('graph', size.width) })
      // Zoomed in on a page, picked: its cards readable and the inspector open at the right.
      const canvas = page.locator('canvas.graph-canvas')
      await canvas.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await page.mouse.move(0, 0)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await page.screenshot({ path: file('graph-inspector', size.width) })
      await page.keyboard.press('Escape')
      await page.goto('/b/growth/wiki/graph?view=list')
      await expect(page.getByRole('table', { name: /Pages of the wiki/ })).toBeVisible()
      await page.screenshot({ path: file('graph-list', size.width) })
    })
  }
})
