// Review of PR18: on a long page inside a brain, the line between the side bar and the content runs the
// whole height of the page, not only the first screen.
import { expect, scenario, test } from './fixture.ts'

test('the side bar line runs to the bottom of a long page', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', { overview: 'much-data' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/growth')
  await expect(page.getByRole('region', { name: "Today's sessions" }).getByRole('listitem')).toHaveCount(20)
  const tall = await page.evaluate(() => document.documentElement.scrollHeight)
  expect(tall, 'a long page').toBeGreaterThan(1800)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  // Just right of the side bar, at the bottom of the window: the line is drawn there.
  const drawn = await page.evaluate(() => {
    const side = document.querySelector('.sidebar') as HTMLElement
    const x = side.getBoundingClientRect().right
    const y = window.innerHeight - 4
    // The element whose edge is the line: the side bar's right border or the content's left border.
    for (const el of document.elementsFromPoint(x - 0.5, y).concat(document.elementsFromPoint(x + 0.5, y))) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (
        cs.borderRightStyle !== 'none' &&
        Math.abs(r.right - x) < 2 &&
        Number.parseFloat(cs.borderRightWidth) > 0
      )
        return true
      if (
        cs.borderLeftStyle !== 'none' &&
        Math.abs(r.left - x) < 2 &&
        Number.parseFloat(cs.borderLeftWidth) > 0
      )
        return true
    }
    return false
  })
  expect(drawn, 'the line is drawn at the bottom of the window').toBe(true)
})

test('the line between side bar and content is as tall as the page (a full-page capture too)', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', { overview: 'much-data' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/growth')
  await expect(page.getByRole('region', { name: "Today's sessions" }).getByRole('listitem')).toHaveCount(20)
  const spans = await page.evaluate(() => {
    const x = (document.querySelector('.sidebar') as HTMLElement).getBoundingClientRect().right
    const bottom = document.documentElement.scrollHeight
    return [...document.querySelectorAll<HTMLElement>('.body, .body > *')].some((el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const right = Number.parseFloat(cs.borderRightWidth) > 0 && Math.abs(r.right - x) < 2
      const left = Number.parseFloat(cs.borderLeftWidth) > 0 && Math.abs(r.left - x) < 2
      return (right || left) && r.bottom + window.scrollY >= bottom - 1
    })
  })
  expect(spans, 'a rule from the top bar to the bottom of the page').toBe(true)
})
