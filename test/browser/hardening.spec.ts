// PR26, the hardening of the web: the items left pending by earlier PRs that are defects or cheap fixes
// (decisions.md, «Triaje de PR26»). Each test here failed before its fix.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

// Pending from PR22: at 375 × 740 the picture ended 20 px under the fold (and further with the lead of a
// wiki drawn by groups).
for (const [w, h] of [
  [375, 740],
  [320, 640],
  [1440, 900],
] as const)
  for (const seeded of [300, 5000] as const)
    test(`the picture ends above the fold at ${w} × ${h}, ${seeded} pages`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded })
      await page.setViewportSize({ width: w, height: h })
      await page.goto(GRAPH)
      await settled(page)
      const bottom = await page.evaluate(
        () => (document.querySelector('canvas.graph-canvas') as HTMLElement).getBoundingClientRect().bottom,
      )
      expect(bottom, 'the bottom of the picture').toBeLessThanOrEqual(h)
    })

// Pending from PR22: the zoom buttons covered the outer ring. With the buttons hidden, nothing is drawn
// where they stood.
for (const [w, h, seeded] of [
  [320, 640, 5000],
  [1024, 768, 5000],
  [1440, 900, 300],
] as const)
  test(`nothing is drawn under the zoom buttons at ${w} px, ${seeded} pages`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded })
    await page.setViewportSize({ width: w, height: h })
    await page.goto(GRAPH)
    await settled(page)
    await page.waitForTimeout(300)
    const tools = page.locator('.graph-tools')
    const r = (await tools.boundingBox()) as { x: number; y: number; width: number; height: number }
    await tools.evaluate((el) => {
      ;(el as HTMLElement).style.visibility = 'hidden'
    })
    const shot = await page.screenshot({
      clip: { x: r.x - 4, y: r.y, width: r.width + 4, height: r.height + 4 },
    })
    // Read the capture in the page: how many pixels differ from the picture's ground (its first pixel).
    const inked = await page.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const x = c.getContext('2d') as CanvasRenderingContext2D
      x.drawImage(img, 0, 0)
      const d = x.getImageData(0, 0, c.width, c.height).data
      const [r0, g0, b0] = [d[0] as number, d[1] as number, d[2] as number]
      let n = 0
      for (let i = 0; i < d.length; i += 4)
        if (
          Math.abs((d[i] as number) - r0) +
            Math.abs((d[i + 1] as number) - g0) +
            Math.abs((d[i + 2] as number) - b0) >
          30
        )
          n += 1
      return n
    }, shot.toString('base64'))
    expect(inked, 'pixels drawn under the zoom buttons').toBe(0)
  })

// Pending from PR22: «Back» after «Leave focus» did nothing visible (leaving replaced the focus in the
// history). Now leaving is a step: Back goes into the focus again, and Back once more to before it.
test('Back after «Leave focus» goes into the focus again', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(`${GRAPH}?view=list`)
  await page
    .getByRole('button', { name: /^Focus: 1 hop, / })
    .first()
    .click()
  await expect(page.getByRole('button', { name: 'Leave focus' })).toBeVisible()
  await page.getByRole('button', { name: 'Leave focus' }).click()
  await expect(page.getByRole('button', { name: 'Leave focus' })).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/focus=/)
  await expect(page.getByRole('button', { name: 'Leave focus' })).toBeVisible()
  await page.goBack()
  await expect(page).not.toHaveURL(/focus=/)
  await expect(page.getByRole('table', { name: /Pages of the wiki/ })).toBeVisible()
})

// Pending from PR22: the tag filter asked the server on every key, so «q4» typed showed «q» first (no
// page) and sent a request per letter. Typing now waits for a pause; a pick or leaving the box applies it.
test('the tag filter waits for a pause in typing: one request for «q4», none for «q»', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(`${GRAPH}?view=list`)
  await expect(page.getByRole('table', { name: /Pages of the wiki/ })).toBeVisible()
  const tags: string[] = []
  page.on('request', (r) => {
    const t = new URL(r.url()).searchParams.get('tag')
    if (t !== null) tags.push(t)
  })
  await page.locator('.graph-filters summary').click()
  await page.getByLabel('Tag', { exact: true }).pressSequentially('q4', { delay: 60 })
  await expect(page).toHaveURL(/tag=q4/)
  await expect.poll(() => tags.includes('q4')).toBe(true)
  expect(
    tags.filter((t) => t === 'q'),
    'no request for the half-typed tag',
  ).toEqual([])
  // Clearing the filters empties the box too.
  await page.getByRole('button', { name: 'Clear filters' }).first().click()
  await expect(page.getByLabel('Tag', { exact: true })).toHaveValue('')
  await expect(page).not.toHaveURL(/tag=/)
})

// The usage pass of PR26: a contributor in a new brain opened «Add a correction»; the form asked for a page
// of a wiki that has none, and sending put the keyboard on an empty picker. It starts on «Nothing in
// particular» there, and the correction is saved.
test('a correction in a brain with no page yet starts on «Nothing in particular» and is saved', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'alone', {}, { mail: false })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create brain' }).first().click()
  await page.getByLabel('Name').fill('Onboarding')
  await page.getByRole('dialog').getByRole('button', { name: 'Create brain' }).click()
  await expect(page.getByRole('region', { name: 'First steps' })).toBeVisible()
  await page.goto('/b/onboarding/journal/correct')
  await expect(page.getByRole('radio', { name: 'Nothing in particular' })).toBeChecked()
  await page.getByLabel('Title', { exact: true }).fill('Long intros lose viewers')
  await page.getByLabel('The correction').fill('Keep intros under ten seconds.')
  await page.getByRole('button', { name: 'Add correction' }).click()
  await expect(page).toHaveURL(/\/journal\/entries\//)
})
