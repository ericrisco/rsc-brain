// Spec amendment 2026-11-09, CA11 (plan canvas-ui S.1, SB2): on every main screen, opened with no saved
// preference, the ground is the dark one, the words are monospaced, and the content sits in panels with
// coloured corners and a numbered chip; the panel's figures and meta take its colour.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const SCREENS = [
  { name: 'home', path: '/', ready: (p: Page) => p.locator('.home-tiles') },
  {
    name: 'overview',
    path: '/b/growth',
    ready: (p: Page) => p.getByRole('heading', { name: "Today's sessions" }),
  },
  { name: 'wiki', path: '/b/growth/wiki', ready: (p: Page) => p.locator('.map') },
  {
    name: 'wiki page',
    path: '/b/growth/pages/audience/retention',
    ready: (p: Page) => p.getByRole('heading', { name: 'Links', exact: true }),
  },
  { name: 'proposals', path: '/b/growth/proposals', ready: (p: Page) => p.locator('ul.list') },
] as const

const FAMILIES = ['orange', 'amber', 'blue', 'cyan', 'pink', 'violet', 'green']

for (const s of SCREENS)
  test(`CA11: ${s.name} is dark, monospaced, and in panels with coloured corners and a number`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(s.path)
    await expect(s.ready(page).first()).toBeVisible()
    const look = await page.evaluate((families) => {
      const root = getComputedStyle(document.documentElement)
      const fam = new Set(families.map((f) => root.getPropertyValue(`--fam-${f}`).trim()))
      const panels = [...document.querySelectorAll<HTMLElement>('main .panel')].filter(
        (p) => p.getBoundingClientRect().height > 0,
      )
      return {
        theme: document.documentElement.dataset.theme,
        ground: getComputedStyle(document.body).backgroundColor,
        expected: (() => {
          const probe = document.createElement('div')
          probe.style.cssText = 'background: var(--ground)'
          document.body.append(probe)
          const c = getComputedStyle(probe).backgroundColor
          probe.remove()
          return c
        })(),
        font: getComputedStyle(document.body).fontFamily,
        heading: getComputedStyle(document.querySelector('main h1') ?? document.body).fontFamily,
        panels: panels.map((p) => {
          const c = getComputedStyle(p).getPropertyValue('--panel-c').trim()
          const num = p.querySelector('.panel-num')
          const meta = p.querySelector<HTMLElement>('.panel-meta, .panel-figure, .tile-n')
          const probe = document.createElement('span')
          probe.style.cssText = 'color: var(--panel-c)'
          p.append(probe)
          const colour = getComputedStyle(probe).color
          probe.remove()
          return {
            colour,
            family: fam.has(c),
            corners: getComputedStyle(p, '::before').backgroundImage.split('linear-gradient').length - 1,
            num: num?.textContent ?? '',
            numInk: num ? getComputedStyle(num).backgroundColor : '',
            meta: meta ? getComputedStyle(meta).color : null,
          }
        }),
      }
    }, FAMILIES)
    expect(look.theme).toBe('dark')
    expect(look.ground).toBe(look.expected)
    expect(look.font).toMatch(/^"?JetBrains Mono"?, ui-monospace/)
    expect(look.heading).toMatch(/^"?JetBrains Mono"?/)
    expect(look.panels.length, 'panels on the screen').toBeGreaterThan(0)
    for (const p of look.panels) {
      expect(p.family, 'the panel takes a family colour').toBe(true)
      expect(p.corners, 'four corners of two strokes each').toBe(8)
      expect(p.num).toMatch(/^\d{2}$/)
    }
    // Panels are numbered in order, from 01.
    expect(look.panels.map((p) => p.num)).toEqual(look.panels.map((_, k) => String(k + 1).padStart(2, '0')))
    // A panel's chip, and its figure or meta where it has one, are in its colour.
    for (const p of look.panels) {
      expect(p.numInk).toBe(p.colour)
      if (p.meta) expect(p.meta).toBe(p.colour)
    }
  })
