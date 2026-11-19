// The three modes (spec web redesign, «Los tres modos»; CA10, CA10b–CA10e): light, dark and high contrast.
// With no choice stored the web follows the system from its first frame; the mode picker in the account menu
// changes it without a reload and it is remembered; an older stored light or dark is kept.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'
import { contrast, DARK, LIGHT, luminance, parseRgb } from './look.ts'

const READY = (p: Page) => p.getByRole('region', { name: "Today's sessions" })

// The colour of the window's ground in the first frame the browser draws, recorded before any script of
// the page runs.
async function firstFrame(page: Page) {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      ;(window as unknown as { __first: string }).__first =
        `${document.documentElement.dataset.theme ?? ''}|${getComputedStyle(document.documentElement).backgroundColor}`
    })
  })
}

async function pick(page: Page, name: 'System' | 'Light' | 'Dark' | 'High contrast') {
  await page
    .locator('.rail')
    .getByRole('button', { name: /Account/ })
    .click()
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name, exact: true }).click()
}

test.describe('CA10: the first visit follows the system, with no flash of the wrong mode', () => {
  for (const [scheme, contrastPref, mode, ground] of [
    ['light', null, 'light', LIGHT.ground],
    ['dark', null, 'dark', DARK.ground],
    ['light', 'more', 'contrast', 'rgb(255, 255, 255)'],
  ] as const)
    test(`a system asking ${scheme}${contrastPref ? ' with more contrast' : ''} gets ${mode}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.emulateMedia({ colorScheme: scheme, contrast: contrastPref })
      await firstFrame(page)
      await page.goto('/b/growth')
      await expect(READY(page)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(mode)
      const first = await page.evaluate(() => (window as unknown as { __first: string }).__first)
      expect(first.split('|')[1]).toBe(ground)
    })
})

test('CA10: the picker changes the mode without a reload; it stays; System follows the system again', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/b/growth')
  await expect(READY(page)).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as { __same: boolean }).__same = true
  })
  await pick(page, 'Dark')
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)
  await expect(
    page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Dark' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(READY(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await pick(page, 'High contrast')
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('contrast')
  await pick(page, 'System')
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
})

for (const stored of ['light', 'dark'] as const)
  test(`CA10: a ${stored} choice stored by an earlier version is kept, whatever the system`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.emulateMedia({ colorScheme: stored === 'light' ? 'dark' : 'light' })
    await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), stored)
    await firstFrame(page)
    await page.goto('/b/growth')
    await expect(READY(page)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(stored)
    const first = await page.evaluate(() => (window as unknown as { __first: string }).__first)
    expect(first.split('|')[1]).toBe(stored === 'light' ? LIGHT.ground : DARK.ground)
  })

test('Annex C 18: changing the mode keeps what was being typed', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal/correct')
  const box = page.getByRole('textbox').first()
  await box.fill('Half a sentence')
  await pick(page, 'Dark')
  await page.keyboard.press('Escape')
  await expect(box).toHaveValue('Half a sentence')
})

// The geometry and the type of a screen: every box of the rail, the top bar and the sheet's first levels.
async function shape(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.rail *, .topbar *, main#main, main#main > * *')]
      .slice(0, 400)
      .map((el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)} ${cs.fontFamily} ${cs.fontSize} ${cs.fontWeight}`
      }),
  )
}

for (const [name, path, ready] of [
  ['overview', '/b/growth', READY],
  [
    'page',
    '/b/growth/pages/audience/retention',
    (p: Page) => p.getByRole('heading', { name: 'What keeps viewers' }),
  ],
  ['proposal', '/b/growth/proposals/prp_growth1', (p: Page) => p.getByRole('heading', { level: 1 })],
] as const)
  test(`CA10b: ${name} has the same boxes and type in the three modes`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    const shapes: string[][] = []
    for (const mode of ['light', 'dark', 'contrast']) {
      await page.evaluate((m) => localStorage.setItem('rscb.theme', m), mode).catch(() => {})
      await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), mode)
      await page.goto(path)
      await expect(ready(page)).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(mode)
      shapes.push(await shape(page))
    }
    expect(shapes[1]).toEqual(shapes[0])
    expect(shapes[2]).toEqual(shapes[0])
  })

test('CA10c: dark — the sheet a step lighter than the frame, no blue tint, the main button light', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.addInitScript(() => localStorage.setItem('rscb.theme', 'dark'))
  await page.goto('/b/growth')
  await expect(READY(page)).toBeVisible()
  const v = await page.evaluate(() => ({
    frame: getComputedStyle(document.querySelector('.rail') as Element).backgroundColor,
    sheet: getComputedStyle(document.querySelector('main#main') as Element).backgroundColor,
    sheetShadow: getComputedStyle(document.querySelector('main#main') as Element).boxShadow,
    grounds: [...document.querySelectorAll('body *')]
      .map((el) => getComputedStyle(el).backgroundColor)
      .filter((c) => c !== 'rgba(0, 0, 0, 0)'),
    primary: (() => {
      const b = document.querySelector('main .button.primary')
      return b ? [getComputedStyle(b).backgroundColor, getComputedStyle(b).color] : null
    })(),
  }))
  expect(v.frame).toBe(DARK.ground)
  expect(v.sheet).toBe(DARK.surface)
  expect(luminance(v.sheet)).toBeGreaterThan(luminance(v.frame))
  expect(v.sheetShadow).toBe('none')
  // A neutral dark: blue never more than a hair above red on a ground darker than mid grey.
  for (const g of new Set(v.grounds)) {
    const [r, , b] = parseRgb(g)
    if (luminance(g) < 0.2) expect(b - r, `${g} has a blue tint`).toBeLessThanOrEqual(6)
  }
  if (v.primary) {
    expect(luminance(v.primary[0] as string)).toBeGreaterThan(0.7)
    expect(luminance(v.primary[1] as string)).toBeLessThan(0.05)
  }
})

test('CA10d: high contrast — every word at 7:1, every control edged at 4.5:1, a 3px focus', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.addInitScript(() => localStorage.setItem('rscb.theme', 'contrast'))
  await page.goto('/admin/limits')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const v = await page.evaluate(() => {
    const groundOf = (el: Element | null): string => {
      for (let p = el; p; p = p.parentElement) {
        const c = getComputedStyle(p).backgroundColor
        if (c !== 'rgba(0, 0, 0, 0)') return c
      }
      return 'rgb(255, 255, 255)'
    }
    const words = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return (
          r.width > 0 &&
          !el.closest('.sr-only') &&
          [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())
        )
      })
      .map((el) => [getComputedStyle(el).color, groundOf(el), (el.textContent ?? '').trim().slice(0, 20)])
    const controls = [
      ...document.querySelectorAll('main input, main select, main textarea, main .button.secondary'),
    ]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => [
        getComputedStyle(el).borderTopColor,
        groundOf(el.parentElement),
        getComputedStyle(el).borderTopWidth,
      ])
    return { words, controls }
  })
  for (const [ink, ground, what] of v.words)
    expect(contrast(ink as string, ground as string), `«${what}» ${ink} on ${ground}`).toBeGreaterThanOrEqual(
      7,
    )
  expect(v.controls.length).toBeGreaterThan(0)
  for (const [edge, ground, width] of v.controls) {
    expect(width).not.toBe('0px')
    expect(contrast(edge as string, ground as string)).toBeGreaterThanOrEqual(4.5)
  }
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineWidth)
  expect(outline).toBe('3px')
})

test('CA10e: with forced colours, buttons and fields keep their outline', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.emulateMedia({ forcedColors: 'active' })
  await page.goto('/admin/limits')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const styles = await page.evaluate(() =>
    [...document.querySelectorAll('main .button, main input, .rail-item[aria-current]')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const cs = getComputedStyle(el)
        return `${cs.borderTopStyle}/${cs.borderTopWidth}`
      }),
  )
  expect(styles.length).toBeGreaterThan(0)
  for (const s of styles) expect(s).not.toMatch(/^none|\/0px$/)
})
