// «Review later» in a real browser, against the fixture API (spec learning-memory A2, A4, B2; plan T010): the list
// oldest first with who, which key and which run; j and k through it; a change with its parts and their differences;
// Keep; Undo whole or by parts, where a part another part needs takes it along; a page written again since, undone
// only when the person chooses to overwrite it; the comment that teaches the agent; the Protected switch and the
// Unreviewed mark on a page; the write mode and the lifetimes by type in the brain's settings. Axe on every screen,
// reduced motion and 375 px.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const LIST = '/b/growth/review-later'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const away = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

test.describe('Review later', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the list: oldest first, who, key, run and parts; j and k move; the rail counts it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(LIST)
    await expect(page.getByRole('heading', { level: 1, name: 'Review later' })).toBeVisible()
    const rows = page.locator('[data-review-list] a[data-row]')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Retention: the October numbers')
    const items = page.locator('[data-review-list] > li')
    await expect(items.nth(0)).toContainText('Factory compiler')
    await expect(items.nth(0)).toContainText('run_118')
    await expect(rows.nth(1)).toContainText('Who writes the intros')
    await expect(items.nth(1)).toContainText('2 parts')
    await expect(page.locator('nav a', { hasText: 'Review later' }).first()).toContainText('2')
    await audit(page, 'list')
    await away(page)
    await page.keyboard.press('j')
    await expect(rows.nth(0)).toBeFocused()
    await page.keyboard.press('j')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('k')
    await expect(rows.nth(0)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/review-later\/chg_fx_numbers$/)
    // The kept ones are a tab away.
    await page.goto(`${LIST}?state=kept`)
    await expect(page.locator('[data-review-list] a[data-row]')).toHaveCount(1)
    await expect(page.locator('[data-review-list]')).toContainText('Annual plans')
  })

  test('Keep: the change leaves the list and its pages count as reviewed', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/people/ana')
    await expect(page.locator('[data-mark="unreviewed"]')).toBeVisible()
    await page.goto(`${LIST}/chg_fx_intros`)
    await expect(page.locator('[data-part]')).toHaveCount(2)
    await expect(page.locator('[data-part="1"]')).toContainText('goes with part 1')
    await audit(page, 'change')
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(page.getByText('Kept. Its pages count as reviewed.')).toBeVisible()
    await page.goto(LIST)
    await expect(page.locator('[data-review-list] a[data-row]')).toHaveCount(1)
    await page.goto('/b/growth/pages/people/ana')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('[data-mark="unreviewed"]')).toHaveCount(0)
  })

  test('Undo by parts: a part another needs takes it along; the comment goes with it', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await scenario(context, baseURL as string, 'signed-in')
    const undos: unknown[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/undo')) undos.push(r.postDataJSON())
    })
    await page.goto(`${LIST}/chg_fx_intros`)
    await page.getByRole('button', { name: 'Undo…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Undo this change' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Only some parts').check()
    await dialog.getByLabel('Part 1: people/ana').check()
    const needer = dialog.getByLabel('Part 2: audience/retention')
    await expect(needer).toBeChecked()
    await expect(needer).toBeDisabled()
    await expect(dialog).toContainText('Comes with part 1, which needs it.')
    await dialog.getByLabel('Comment (optional)').fill('Ana does not write intros; she writes scripts.')
    await audit(page, 'undo dialog')
    await noSideScroll(page)
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Undone: 2 pages back as they were.')).toBeVisible()
    expect(undos).toEqual([{ parts: [0, 1], comment: 'Ana does not write intros; she writes scripts.' }])
    await expect(page.locator('[data-part="0"]')).toContainText('undone')
  })

  test('Undo over a page written again since: a conflict until the person chooses to overwrite', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${LIST}/chg_fx_numbers`)
    await page.getByRole('button', { name: 'Undo…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Undo this change' })
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    const alert = dialog.locator('[data-state="undo-conflict"]')
    await expect(alert).toContainText('Some pages changed after this change')
    await expect(alert).toContainText('Eric edited audience/retention after this change')
    await audit(page, 'undo conflict')
    await dialog.getByLabel('Undo over the later changes of audience/retention').check()
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Undone: 1 page back as they were.')).toBeVisible()
  })

  test('a page: the Unreviewed mark and the Protected switch', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/audience/retention')
    await expect(page.locator('[data-mark="unreviewed"]')).toBeVisible()
    await expect(page.locator('[data-mark="protected"]')).toHaveCount(0)
    const sw = page.getByRole('switch', { name: 'Protected' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await audit(page, 'page')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-mark="protected"]')).toBeVisible()
    await expect(page.getByText('Protected. Agents’ changes to it now wait for a curator.')).toBeVisible()
    await sw.press('Space')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    // A reader sees the marks, never the switch.
  })

  test('a member who is no curator sees no switch and no Review later', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/b/growth/pages/product/pricing')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('switch')).toHaveCount(0)
    await expect(page.locator('nav a', { hasText: 'Review later' })).toHaveCount(0)
  })

  test('settings: the write mode and the lifetimes by type, saved', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    const saves: Array<Record<string, unknown>> = []
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/wiki/settings')) saves.push(r.postDataJSON())
    })
    await page.goto('/b/growth/settings/memory')
    const mode = page.getByRole('region', { name: 'When agents change the wiki' })
    await expect(mode.getByLabel('Apply automatically')).toBeChecked()
    await mode.getByLabel('Ask first').check()
    await mode.getByRole('button', { name: 'Save' }).click()
    await expect(mode.locator('#write-mode-said')).not.toBeEmpty()
    expect(saves.at(-1)).toMatchObject({ writeMode: 'ask_first', base: { writeMode: 'auto' } })
    const life = page.getByRole('region', { name: 'How long entries last without use' })
    await expect(life.getByLabel('Days for notes')).toHaveValue('30')
    await life.getByLabel('Days for notes').fill('0')
    await life.getByRole('button', { name: 'Save' }).click()
    await expect(life).toContainText('Write whole days from 1 to 3650')
    await expect(life.getByLabel('Days for notes')).toBeFocused()
    await life.getByLabel('Days for notes').fill('')
    await life.getByRole('button', { name: 'Save' }).click()
    await expect(life.locator('#lifetimes-said')).not.toBeEmpty()
    expect(saves.at(-1)).toMatchObject({ entryLifetimes: { note: null } })
    await audit(page, 'settings agents')
  })
})
