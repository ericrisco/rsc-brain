// Review of PR18, as the web redesign leaves it («Casos límite»: a very long page reads without the frame
// moving with it): on a long page inside a brain the sheet scrolls; the rail and the top bar stay where they
// are, and the sheet's edge beside the rail runs to the bottom of the window.
import { expect, scenario, test } from './fixture.ts'

test('a long page scrolls inside the sheet; the frame stays', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', { overview: 'much-data' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/growth')
  await expect(page.getByRole('region', { name: "Today's sessions" }).getByRole('listitem')).toHaveCount(20)
  const tall = await page.locator('main#main').evaluate((m) => m.scrollHeight)
  expect(tall, 'a long page').toBeGreaterThan(1800)
  // The window itself does not scroll.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900)
  await page.locator('main#main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  const after = await page.evaluate(() => ({
    rail: (document.querySelector('.rail') as HTMLElement).getBoundingClientRect().top,
    top: (document.querySelector('.topbar') as HTMLElement).getBoundingClientRect().top,
    scrolled: (document.querySelector('main#main') as HTMLElement).scrollTop,
  }))
  expect(after.scrolled).toBeGreaterThan(800)
  expect(after.rail).toBe(0)
  expect(after.top).toBe(0)
})

test("the sheet's edge beside the rail runs from the top bar to 8px above the window's bottom", async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', { overview: 'much-data' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/growth')
  await expect(page.getByRole('region', { name: "Today's sessions" }).getByRole('listitem')).toHaveCount(20)
  await page.locator('main#main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  const edge = await page.evaluate(() => {
    const rail = (document.querySelector('.rail') as HTMLElement).getBoundingClientRect()
    const sheet = document.querySelector('main#main') as HTMLElement
    const r = sheet.getBoundingClientRect()
    const cs = getComputedStyle(sheet)
    return {
      left: Math.round(r.left - rail.right),
      top: Math.round(r.top),
      bottom: Math.round(window.innerHeight - r.bottom),
      line: cs.borderLeftStyle !== 'none' && Number.parseFloat(cs.borderLeftWidth) > 0,
    }
  })
  expect(edge).toEqual({ left: 0, top: 48, bottom: 8, line: true })
})
