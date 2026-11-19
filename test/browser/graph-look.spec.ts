// CA14 (spec web redesign, «El grafo»): a flat ground with no dots; the pages in neutral tones; the page
// picked (and its links) in the accent, the rest dimmed; in high contrast the pick also has a thicker ring.
// The picture is read from a screenshot of the canvas, pixel by pixel, in the page.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

// How many pixels of the canvas carry a hue (saturation over 35%), and how many are near the accent's hue.
async function hues(page: Page, accentHue: number) {
  const canvas = page.locator('canvas.graph-canvas')
  const shot = (await canvas.screenshot()).toString('base64')
  return page.evaluate(
    async ({ shot, accentHue }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${shot}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let coloured = 0
      let accent = 0
      for (let i = 0; i < d.length; i += 4) {
        const r = (d[i] as number) / 255
        const g = (d[i + 1] as number) / 255
        const b = (d[i + 2] as number) / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const l = (max + min) / 2
        const delta = max - min
        if (delta < 0.12) continue
        const s = delta / (1 - Math.abs(2 * l - 1))
        if (s < 0.35) continue
        coloured += 1
        let h = 0
        if (max === r) h = ((g - b) / delta) % 6
        else if (max === g) h = (b - r) / delta + 2
        else h = (r - g) / delta + 4
        h = (h * 60 + 360) % 360
        if (Math.abs(h - accentHue) < 18) accent += 1
      }
      return { coloured, accent, total: d.length / 4 }
    },
    { shot, accentHue },
  )
}

// The accent's hue (192° for #1b6c80 and its lighter and darker kin).
const ACCENT_HUE = 192

for (const mode of ['light', 'dark', 'contrast'] as const)
  test(`CA14 in ${mode}: flat ground without dots, neutral pages, the pick and its links in the accent`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), mode)
    await page.goto(GRAPH)
    await settled(page)
    const ground = await page.evaluate(() => {
      const box = document.querySelector('.graph-box') as Element
      return { image: getComputedStyle(box).backgroundImage, bg: getComputedStyle(box).backgroundColor }
    })
    expect(ground.image).toBe('none')
    const atRest = await hues(page, ACCENT_HUE)
    // At rest nothing on the canvas carries a hue: the pages are neutral.
    expect(atRest.coloured / atRest.total).toBeLessThan(0.0005)
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const picked = await hues(page, ACCENT_HUE)
    expect(picked.accent).toBeGreaterThan(20)
    // Everything with a hue is the accent: no other colour on the picture.
    expect(picked.accent / picked.coloured).toBeGreaterThan(0.9)
    const rings = (await canvas.getAttribute('data-rings')) ?? ''
    const sel = /selected:solid:[\d.]+:([\d.]+)/.exec(rings)
    expect(sel, rings).not.toBeNull()
    // The ring of the pick is thicker in high contrast: not by colour alone.
    expect(Number(sel?.[1])).toBe(mode === 'contrast' ? 4 : 2.5)
  })

test('CA14: the communities panel names its clusters with no colour dots', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const dots = await page.evaluate(
    () =>
      [...document.querySelectorAll('.graph-communities *')].filter((el) => {
        const c = getComputedStyle(el).backgroundColor
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c)
        if (!m) return false
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
        return Math.max(r, g, b) - Math.min(r, g, b) > 24
      }).length,
  )
  expect(dots).toBe(0)
  expect(await page.locator('.graph-communities .com-dot').count()).toBe(0)
})

test('CA14: a mode change repaints the graph at once, keeping the page picked', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
  const before = await canvas.getAttribute('data-draws')
  await page
    .locator('.rail')
    .getByRole('button', { name: /Account/ })
    .click()
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Dark', exact: true }).click()
  await expect.poll(() => canvas.getAttribute('data-draws')).not.toBe(before)
  await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
})
