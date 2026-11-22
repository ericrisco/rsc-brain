// What an outside review of the redesign found, one check each (the findings are numbered as in the review):
// the rows of tabs and the tables that slide sideways say so and never start inside a word (4, 2); a phone has a
// menu outside a brain (3); states are told apart (6); the audit's filters sit in the card, not in a card of
// their own (7); fieldsets have no box (8); the steps of a new brain line up (9); a count keeps off its label (12);
// dark controls are drawn to be seen (13); the sidebar does not say the same count twice, and a session or an
// entry still shows where it is (14).
import { expect, scenario, test } from './fixture.ts'

const rect = (page: import('@playwright/test').Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    })

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a row of tabs starts at a tab, not inside a word, and says where more waits (4)', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    for (const path of ['/admin/audit', '/admin/system', '/admin/branding', '/b/growth/settings/archive']) {
      await page.goto(path)
      await expect(page.locator('nav.tabs [aria-current]')).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const nav = document.querySelector('nav.tabs') as HTMLElement
            const box = nav.getBoundingClientRect()
            const cut = [...nav.querySelectorAll('a')].filter((a) => {
              const r = a.getBoundingClientRect()
              return r.left < box.left - 1 && r.right > box.left + 1
            })
            const cur = nav.querySelector('[aria-current]')?.getBoundingClientRect()
            return {
              cut: cut.map((a) => a.textContent),
              inView: cur ? cur.left >= box.left - 1 && cur.right <= box.right + 1 : false,
              moreLeft: nav.scrollLeft > 1,
              // Each edge says so exactly when more waits beyond it.
              leftSaid: nav.hasAttribute('data-more-start') === nav.scrollLeft > 1,
              rightSaid:
                nav.hasAttribute('data-more') === nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1,
            }
          }),
        )
        .toEqual({
          cut: [],
          inView: true,
          moreLeft: true,
          leftSaid: true,
          rightSaid: true,
        })
    }
  })

  test('a table wider than its box says so while columns wait (2)', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/wiki/graph?view=list')
    const wrap = page.locator('.table-wrap').first()
    await expect(wrap).toHaveAttribute('data-more', '')
    expect(await wrap.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('›')
    await wrap.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await expect(wrap).not.toHaveAttribute('data-more', '')
  })

  test('outside a brain the menu is there and leads to All brains, People and Administration (3)', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    for (const path of ['/admin/people', '/people']) {
      await page.goto(path)
      await page.getByRole('button', { name: 'Menu' }).click()
      const menu = page.getByRole('dialog')
      await expect(menu.getByRole('link', { name: 'All brains' })).toBeVisible()
      await expect(menu.getByRole('link', { name: 'People' })).toBeVisible()
      await expect(menu.getByRole('link', { name: 'Administration' })).toBeVisible()
      await menu.getByRole('link', { name: 'All brains' }).click()
      await expect(page).toHaveURL(/\/$/)
    }
  })

  test('the graph on a phone: its strip is off the top bar, Graph | List is above the picture (5)', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto('/b/growth/wiki/graph')
    await expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })
    const strip = await rect(page, '.graph-strip')
    const bar = await rect(page, '.topbar, .rail')
    const views = await rect(page, '.graph-center')
    const communities = await rect(page, '.graph-communities')
    expect(strip.top, 'a gap under the top bar').toBeGreaterThanOrEqual(bar.bottom - 1 + 4 - 4)
    expect(views.top, 'under the strip').toBeGreaterThanOrEqual(strip.bottom)
    expect(views.top, 'above the communities').toBeLessThan(communities.top)
  })
})

test('the tabs of the journal keep a gap before a count, and a session or an entry says where it is (12, 14)', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal/conflicts')
  const tab = page.getByRole('link', { name: /^Conflicts/ })
  await expect(tab.locator('.tag')).toBeVisible()
  const gap = await tab.evaluate((a) => {
    const count = a.querySelector('.tag')?.getBoundingClientRect() as DOMRect
    const range = document.createRange()
    range.selectNodeContents(a.firstChild as Node)
    return count.left - range.getBoundingClientRect().right
  })
  expect(gap, 'the count is not on its label').toBeGreaterThanOrEqual(4)
  await page.goto('/b/growth/journal/sessions/ses_fx_1')
  await expect(page.locator('nav.tabs a[aria-current]')).toHaveText('Sessions')
})

test('states are told apart: waiting, done, wants a look, off (6)', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal')
  await expect(page.getByText('Fix the onboarding emails')).toBeVisible()
  const kinds = await page
    .locator('.list-title .tag')
    .evaluateAll((els) =>
      Object.fromEntries(els.map((e) => [e.textContent, e.className.replace('tag', '').trim()])),
    )
  expect(kinds.Open).toBe('live')
  expect(kinds.Closed).toBe('ok')
  if ('Closed without summary' in kinds) expect(kinds['Closed without summary']).toBe('warn')
  await page.goto('/admin/invitations')
  await page.getByLabel('Show').selectOption('all')
  await expect(page.locator('[data-invitation]').first()).toBeVisible()
  const invites = await page
    .locator('[data-invitation] .list-title .tag')
    .evaluateAll((els) =>
      Object.fromEntries(els.map((e) => [e.textContent, e.className.replace('tag', '').trim()])),
    )
  if ('pending' in invites) expect(invites.pending).toBe('live')
  if ('expired' in invites) expect(invites.expired).toBe('bad')
  if ('accepted' in invites) expect(invites.accepted).toBe('ok')
  // The look of each differs: no two of waiting, done, fault and off share a fill and an edge.
  const looks = await page.evaluate(() => {
    const make = (c: string) => {
      const s = document.createElement('span')
      s.className = `tag ${c}`
      s.textContent = 'x'
      document.body.append(s)
      const css = getComputedStyle(s)
      const out = `${css.backgroundColor}|${css.borderTopColor}`
      s.remove()
      return out
    }
    return ['', 'live', 'ok', 'warn', 'bad'].map(make)
  })
  expect(new Set(looks).size).toBe(looks.length)
})

test('the audit filters are not a card inside a card, and six fields sit in one row (7)', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/admin/audit')
  const form = page.locator('.part-body > form.filter-box')
  await expect(form).toBeVisible()
  expect(await form.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
  const bottoms = await page
    .locator('.audit-filters :is(select, input)')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)))
  expect(bottoms).toHaveLength(6)
  expect(new Set(bottoms).size, 'one row').toBe(1)
})

test('a fieldset has no box and a file field is drawn as the other fields (8)', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal/correct')
  const boxes = await page
    .locator('fieldset')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopWidth))
  expect(boxes.length).toBeGreaterThan(0)
  for (const b of boxes) expect(b).toBe('0px')
  await page.goto('/admin/branding')
  const file = page.locator('input[type="file"]')
  await expect(file).toBeVisible()
  const text = page.locator('input[type="text"]').first()
  const [f, t] = await Promise.all(
    [file, text].map((l) =>
      l.evaluate((el) => {
        const c = getComputedStyle(el)
        return [
          Math.round(el.getBoundingClientRect().height),
          c.borderTopLeftRadius,
          c.borderTopColor,
          c.backgroundColor,
        ]
      }),
    ),
  )
  expect(f).toEqual(t)
})

test('the three first steps line up, heads with heads and bodies with bodies (9)', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await s.state('overview', 'empty')
  await page.goto('/b/growth')
  const steps = page.getByRole('region', { name: 'First steps' })
  await expect(steps).toBeVisible()
  const tops = await steps
    .locator('li')
    .evaluateAll((els) =>
      els.map((li) => [
        Math.round((li.querySelector('.step-head') as HTMLElement).getBoundingClientRect().top),
        Math.round((li.querySelector('.step-body') as HTMLElement).getBoundingClientRect().top),
      ]),
    )
  expect(tops).toHaveLength(3)
  expect(new Set(tops.map((t) => t[0])).size, 'heads').toBe(1)
  expect(new Set(tops.map((t) => t[1])).size, 'bodies').toBe(1)
})

test('the sidebar does not say the same count twice (14)', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('link', { name: /^Proposals/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /proposals to review/ })).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByRole('link', { name: /proposals to review/ }).first()).toBeVisible()
})

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' })

  test('an empty checkbox and radio have an edge that shows, in the chosen and the system dark (13)', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    for (const mode of ['dark', null]) {
      await page.addInitScript(
        (m) => (m ? localStorage.setItem('rscb.theme', m) : localStorage.removeItem('rscb.theme')),
        mode,
      )
      await page.goto('/admin/invitations')
      await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible()
      const boxes = page.locator('input[type="checkbox"], input[type="radio"]')
      await expect(boxes.first()).toBeVisible()
      const looks = await boxes.evaluateAll((els) =>
        els.slice(0, 4).map((e) => {
          const c = getComputedStyle(e)
          return { appearance: c.appearance, edge: c.borderTopColor, width: c.borderTopWidth }
        }),
      )
      for (const l of looks) {
        expect(l.appearance).toBe('none')
        expect(l.width).toBe('1px')
        expect(l.edge).toBe('rgb(134, 138, 144)')
      }
    }
  })
})
