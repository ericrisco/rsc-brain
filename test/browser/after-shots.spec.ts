// Pictures of the screens, set beside the reference for a person to judge. Not a check: it runs only with
// SHOTS_DIR set, e.g. `SHOTS_DIR=… SHOTS_MODES=light,dark SHOTS_SIZES=1440x900 npx playwright test after-shots`.
// Each screen of the matrix (or those in SHOTS_ROWS, comma separated) is written as
// <screen>-<mode>-<width>.png; the graph adds its canvas, the inspector open and the list.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'
import { ROWS } from './screens.ts'

const DIR = process.env.SHOTS_DIR ?? ''
const MODES = (process.env.SHOTS_MODES ?? 'light').split(',').filter(Boolean)
const SIZES = (process.env.SHOTS_SIZES ?? '1440x900').split(',').map((s) => {
  const [width, height] = s.split('x').map(Number)
  return { width: width as number, height: height as number }
})
const PICKED = (process.env.SHOTS_ROWS ?? '').split(',').filter(Boolean)
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
const file = (name: string, mode: string, width: number) => join(DIR, `${slug(name)}-${mode}-${width}.png`)
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

// A mode as the person chooses it (stored), or the system's (no choice stored, the browser's preference).
async function useMode(page: Page, mode: string) {
  if (mode.startsWith('system-')) {
    const scheme = mode === 'system-dark' ? 'dark' : 'light'
    await page.emulateMedia({ colorScheme: scheme, contrast: mode === 'system-contrast' ? 'more' : null })
    return
  }
  await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), mode)
}

test.describe('after shots', () => {
  test.skip(!DIR, 'only with SHOTS_DIR')

  for (const mode of MODES)
    for (const size of SIZES) {
      test(`the screens in ${mode} at ${size.width}×${size.height}`, async ({ page, context, baseURL }) => {
        test.setTimeout(600_000)
        const s = await scenario(context, baseURL as string, 'signed-in')
        await useMode(page, mode)
        await page.setViewportSize(size)
        const rows = ROWS.filter((r) => !PICKED.length || PICKED.includes(r.name))
        for (const row of rows) {
          if (row.preset && row.preset !== 'signed-in') continue
          await page.goto(row.path)
          if (row.seed) await row.seed(s)
          await expect(row.ready(page)).toBeVisible()
          await page.waitForLoadState('networkidle')
          await page.screenshot({ path: file(row.name, mode, size.width) })
        }
      })

      test(`the doors in ${mode} at ${size.width}×${size.height}`, async ({ page, context, baseURL }) => {
        test.setTimeout(300_000)
        await scenario(context, baseURL as string, 'signed-out')
        await useMode(page, mode)
        await page.setViewportSize(size)
        for (const row of ROWS.filter((r) => r.preset === 'signed-out' || r.preset === 'fresh')) {
          if (PICKED.length && !PICKED.includes(row.name)) continue
          if (row.preset === 'fresh') await scenario(context, baseURL as string, 'fresh')
          else await scenario(context, baseURL as string, 'signed-out')
          await page.goto(row.path)
          await expect(row.ready(page)).toBeVisible()
          await page.waitForLoadState('networkidle')
          await page.screenshot({ path: file(row.name, mode, size.width) })
        }
      })

      test(`the graph in ${mode} at ${size.width}×${size.height}`, async ({ page, context, baseURL }) => {
        test.setTimeout(120_000)
        if (PICKED.length && !PICKED.includes('graph')) return
        await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
        await useMode(page, mode)
        await page.setViewportSize(size)
        await page.goto('/b/growth/wiki/graph')
        await settled(page)
        await page.screenshot({ path: file('graph-canvas', mode, size.width) })
        const canvas = page.locator('canvas.graph-canvas')
        await canvas.focus()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
        await page.mouse.move(0, 0)
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        await page.screenshot({ path: file('graph-inspector', mode, size.width) })
      })
    }
})
