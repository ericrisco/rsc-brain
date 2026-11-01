// Spec B6 CA14 and CA15 (T049): every screen of the web map × every state of «Estados en todas las
// pantallas», at 320 px. A state a screen cannot have says why in the table, so the matrix is complete by
// construction: a route of the web with no row, or a row without a cell or a reason for a state, fails.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, type States, scenario, test } from './fixture.ts'
import { isNa, REDIRECTS, ROWS, type Row } from './screens.ts'

test('the matrix holds every route of the web, and every state of every row has a check or a reason', () => {
  const app = readFileSync(new URL('../../web/src/app.tsx', import.meta.url), 'utf8')
  const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1] as string)
  const doors = [...app.matchAll(/DOORS = \[([^\]]+)\]/g)].flatMap((m) =>
    [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string),
  )
  const covered = new Set(ROWS.map((r) => r.route))
  const missing = [...routes, ...doors].filter((r) => !covered.has(r) && !REDIRECTS.has(r))
  expect(missing, 'routes of the web without a row in the matrix').toEqual([])
  for (const r of ROWS) {
    for (const [state, cell] of Object.entries({ empty: r.empty, filtered: r.filtered, much: r.much })) {
      if (isNa(cell)) expect(cell.na.length, `${r.name} · ${state}: a reason`).toBeGreaterThan(10)
    }
  }
})

// Nothing is cut off: no element (outside a scrolling table or the graph) ends past the window's right
// edge, and nothing that hides its overflow hides text (an ellipsis or a screen-reader-only text is fine).
async function nothingCut(page: Page, where: string) {
  await noSideScroll(page)
  const cut = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const bad: string[] = []
    const scrolls = (el: Element | null): boolean => {
      for (let p = el?.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX
        if (o === 'auto' || o === 'scroll') return true
      }
      return false
    }
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('svg, canvas, dialog:not([open])')) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      // Visually hidden on purpose (screen-reader text): 1 px with its overflow hidden.
      if (r.width <= 1 && r.height <= 1) continue
      if (r.width > 0 && r.right > vw + 1 && !scrolls(el))
        bad.push(`past the edge: ${el.tagName} ${el.className}`)
      if (
        (cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
        cs.textOverflow !== 'ellipsis' &&
        el.clientWidth > 1 &&
        el.scrollWidth > el.clientWidth + 1
      )
        bad.push(`clipped: ${el.tagName} ${el.className}`)
    }
    return [...new Set(bad)].slice(0, 5)
  })
  expect(cut, `${where}: nothing cut off at 320 px`).toEqual([])
}

async function open(
  page: Page,
  context: Parameters<typeof scenario>[0],
  baseURL: string,
  r: Row,
  states: States = {},
  path = r.path,
) {
  const s = await scenario(context, baseURL, r.preset ?? 'signed-in', states)
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto(path)
  return s
}

// What leads to the rest of a long list: the row's own, or a «more», «show all» or «next» control.
const muchOf = (r: Row, page: Page) =>
  r.muchShows
    ? r.muchShows(page)
    : page
        .getByRole('main')
        .getByRole('button', { name: /more|show all|next/i })
        .or(page.getByRole('main').getByRole('link', { name: /more|show all|next/i }))

const keyOf = (r: Row) => (isNa(r.key) ? null : r.key)

for (const r of ROWS) {
  test.describe(`${r.name} at 320 px`, () => {
    test('default: its content, nothing scrolls sideways or is cut off', async ({
      page,
      context,
      baseURL,
    }) => {
      const s = await open(page, context, baseURL as string, r)
      if (r.seed) {
        await r.seed(s)
        await page.reload()
      }
      await expect(r.ready(page)).toBeVisible()
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
      // What only the other states show is not here: each of those cells proves its state.
      if (r.empty === true)
        await expect(
          r.emptyShows ? r.emptyShows(page) : page.locator('[data-state="empty"]'),
          'not empty by default',
        ).toHaveCount(0)
      if (r.much === true) await expect(muchOf(r, page), 'no paging by default').toHaveCount(0)
      await nothingCut(page, r.name)
    })

    test('offline: a strip says so, what is shown stays, and writes are off with the reason', async ({
      page,
      context,
      baseURL,
    }) => {
      await open(page, context, baseURL as string, r)
      await expect(r.ready(page)).toBeVisible()
      await context.setOffline(true)
      await expect(page.locator('[data-state="offline"]').first()).toBeVisible()
      await expect(r.ready(page)).toBeVisible()
      if (r.write) {
        const w = r.write(page)
        await expect(w).toHaveAttribute('aria-disabled', 'true')
        const why = await w.getAttribute('aria-describedby')
        expect(why, 'the button names its reason').toBeTruthy()
        await expect(page.locator(`[id="${why}"]`)).toContainText('offline')
      }
      await nothingCut(page, `${r.name} offline`)
      await context.setOffline(false)
    })

    const key = keyOf(r)
    if (key === null) return

    test('loading: the shape of the content, no box to type over, then the content', async ({
      page,
      context,
      baseURL,
    }) => {
      const s = await open(page, context, baseURL as string, r, { [key]: 'loading' })
      await expect(page.locator('[data-state="loading"]').first()).toBeVisible()
      // Still loading well after an ordinary answer would have come: the state, not a quick load.
      await page.waitForTimeout(1200)
      await expect(page.locator('[data-state="loading"]').first()).toBeVisible()
      // No editable box with nothing in it where a saved value is about to land.
      if (!r.typing)
        await expect(page.getByRole('main').locator('textarea:not([readonly]):not([disabled])')).toHaveCount(
          0,
        )
      await s.state(key, 'normal')
      await expect(r.ready(page)).toBeVisible({ timeout: 10_000 })
    })

    test('error: what happened, «Try again» that recovers, and nothing left loading', async ({
      page,
      context,
      baseURL,
    }) => {
      const s = await open(page, context, baseURL as string, r, { [key]: 'error' })
      const alert = page.locator('[role="alert"][data-state="error"]').first()
      await expect(alert).toContainText('This did not load')
      await expect(alert).toContainText('reference fx')
      // Every part that failed says so: no skeleton waits forever beside the error.
      await page.waitForTimeout(300)
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
      await nothingCut(page, `${r.name} error`)
      await s.state(key, 'normal')
      await alert.getByRole('button', { name: 'Try again' }).click()
      await expect(r.ready(page)).toBeVisible()
    })

    if (!r.forbidden)
      test('no access: why and whom to ask, never a blank page', async ({ page, context, baseURL }) => {
        await open(page, context, baseURL as string, r, { [key]: 'forbidden' })
        const alert = page.locator('[role="alert"][data-state="forbidden"]').first()
        await expect(alert).toContainText('You cannot open this')
        await expect(alert).toContainText(/ask|curator|administrator/i)
        await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0)
        // The web's words, with a way out: never an API route.
        await expect(alert.getByRole('link', { name: 'Go to your brains' })).toBeVisible()
        await expect(alert).not.toContainText(/\/v1|GET \/|\bAPI\b/)
        await nothingCut(page, `${r.name} no access`)
      })

    if (r.empty === true)
      test('empty: what this is and the first thing to do', async ({ page, context, baseURL }) => {
        await open(page, context, baseURL as string, r, { [key]: 'empty' })
        const empty = r.emptyShows ? r.emptyShows(page) : page.locator('[data-state="empty"]').first()
        await expect(empty).toBeVisible()
        expect(((await empty.textContent()) ?? '').trim().length, 'it says something').toBeGreaterThan(15)
        await nothingCut(page, `${r.name} empty`)
      })

    const filtered = r.filtered
    if (!isNa(filtered))
      test('filtered empty: says so and clears the filters', async ({ page, context, baseURL }) => {
        await open(page, context, baseURL as string, r, {}, filtered.path)
        if (filtered.act) {
          await expect(r.ready(page)).toBeVisible()
          await filtered.act(page)
        }
        const none = page.locator('[data-state="filtered-empty"]').first()
        await expect(none).toBeVisible()
        await nothingCut(page, `${r.name} filtered empty`)
        await none.getByRole('button', { name: /clear|show all/i }).click()
        await expect(r.ready(page)).toBeVisible()
      })

    if (r.much === true)
      test('a lot of data: by pages or groups, never all at once; nothing scrolls sideways', async ({
        page,
        context,
        baseURL,
      }) => {
        await open(page, context, baseURL as string, r, { [r.muchKey ?? key]: 'much-data' })
        await expect(page.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 10_000 })
        await expect(muchOf(r, page).first()).toBeVisible()
        await nothingCut(page, `${r.name} a lot of data`)
      })
  })
}
