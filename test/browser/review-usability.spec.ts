// The usability audit of «Review later», task by task (usability-t1.md; T010 «Uso real»): B1 the unreviewed mark where
// curators look (the wiki map with a filter, search results, «Review it» opening the change); B2 a partly undone change
// still awaiting review; B3 a radio's hint beside it, never under the radio; M1 what awaits review on the overview and
// home, and a tray row that names the pages, the operations and when, with a «since» filter; M2 the agent's reason and
// each operation in words, a new page shown as added; M3 after Keep or Undo, the status takes the keyboard and «Next
// change» opens the next; M4 who wrote after the agent, and what an overwrite replaced; M5 an undone change's comment
// and the correction it made, and a correction note that is not an error.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const LIST = '/b/growth/review-later'
const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Search' })

test.describe('Review later, as people use it', () => {
  test('B1: the wiki map marks and filters unreviewed pages; search marks them; «Review it» opens the change', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/wiki')
    const row = page.locator('.map-pages li', { hasText: 'audience/retention' })
    await expect(row.locator('[data-mark="unreviewed"]')).toBeVisible()
    await expect(
      page.locator('.map-pages li', { hasText: 'audience/intros' }).locator('[data-mark="unreviewed"]'),
    ).toHaveCount(0)
    await page.getByLabel('Unreviewed only').check()
    await expect(page.locator('.map-pages li')).toHaveCount(2)
    await page.keyboard.press('Control+k')
    const d = searchDialog(page)
    await d.getByLabel('Search for').fill('retention')
    await d.getByLabel('Search for').press('Enter')
    const hit = d
      .getByRole('list', { name: 'Results' })
      .getByRole('listitem')
      .filter({ hasText: 'Retention' })
      .first()
    await expect(hit.locator('[data-mark="unreviewed"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/b/growth/pages/audience/retention')
    await expect(page.getByRole('link', { name: 'Review it' })).toHaveAttribute(
      'href',
      `${LIST}/chg_fx_intros`,
    )
  })

  test('B2: a partly undone change still awaits review, and the rail still counts it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${LIST}/chg_fx_intros`)
    await page.getByRole('button', { name: 'Undo…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Undo this change' })
    await dialog.getByLabel('Only some parts').check()
    await dialog.getByLabel(/^Part 2:/).check()
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Undone' })).toBeVisible()
    await page.goto(LIST)
    const rows = page.locator('[data-review-list] > li')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(1)).toContainText('Partly undone')
    await expect(
      page
        .getByRole('navigation', { name: 'Sections of this brain' })
        .getByRole('link', { name: /^Review later/ }),
    ).toContainText('2')
  })

  test('B3: at 375 and 320 px a radio keeps its words and its hint beside it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    for (const width of [375, 320, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/b/growth/settings/memory')
      const radio = page.locator('#write-mode-auto')
      const label = page.locator('label[for="write-mode-auto"]')
      const hint = page.locator('#write-mode-auto-hint')
      await expect(label).toBeVisible()
      const r = await radio.boundingBox()
      const l = await label.boundingBox()
      const h = await hint.boundingBox()
      expect(l && l.height < 40, `${width}: the label is on one or two lines`).toBe(true)
      expect(h && r && h.x >= r.x + r.width, `${width}: the hint starts after the radio`).toBe(true)
      expect(l && r && l.x - (r.x + r.width) < 24, `${width}: the label sits by its radio`).toBe(true)
    }
  })

  test('M1: the overview and home say what awaits review; a tray row names pages, operations and when; since filters', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await expect(page.getByRole('link', { name: /2 changes awaiting review/ })).toHaveAttribute('href', LIST)
    await page.goto('/')
    await expect(page.getByRole('link', { name: /2 changes awaiting review/ }).first()).toHaveAttribute(
      'href',
      LIST,
    )
    await page.goto(LIST)
    const second = page.locator('[data-review-list] > li').nth(1)
    await expect(second).toContainText('New page people/ana')
    await expect(second).toContainText('Link audience/retention')
    await expect(second.locator('time')).toHaveAttribute('datetime', '2026-10-22T10:00:00.000Z')
    await page.getByLabel('Since').selectOption('today')
    await expect(page).toHaveURL(/since=today/)
    await expect(page.locator('[data-review-list] > li')).toHaveCount(0)
    await page.getByLabel('Since').selectOption('all')
    await expect(page.locator('[data-review-list] > li')).toHaveCount(2)
  })

  test('M2: a part gives the agent’s reason and says what its operation did; a new page shows as added', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${LIST}/chg_fx_intros`)
    const created = page.locator('[data-part="0"]')
    const linked = page.locator('[data-part="1"]')
    await expect(created).toContainText('Why: She writes the intros.')
    await expect(created.locator('del')).toHaveCount(0)
    await expect(created.locator('ins').first()).toBeVisible()
    await expect(linked).toContainText('Why: Who to ask.')
    await expect(linked).toContainText('Linked to people/ana (related)')
  })

  test('M3: after Keep the status takes the keyboard, and «Next change» opens the next awaiting one', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${LIST}/chg_fx_numbers`)
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    const said = page.getByRole('status').filter({ hasText: 'Kept' })
    await expect(said).toBeFocused()
    await page.getByRole('link', { name: 'Next change →' }).click()
    await expect(page).toHaveURL(`${LIST}/chg_fx_intros`)
  })

  test('M4 and M5: who wrote after the agent; what an overwrite replaced; the comment and its correction', async ({
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
    await expect(alert).toContainText('Eric edited audience/retention after this change, on')
    await expect(alert).toContainText('Undoing replaces that edit; it stays in the page history.')
    await dialog.getByLabel('Undo over the later changes of audience/retention').check()
    await dialog.getByLabel('Comment (optional)').fill('The October numbers were wrong.')
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    const said = page.getByRole('status').filter({ hasText: 'Undone' })
    await expect(said).toContainText('Replaced revision 3 of audience/retention (by Eric).')
    await expect(said.getByRole('link', { name: 'Page history' })).toHaveAttribute(
      'href',
      /audience\/retention.*history/,
    )
    await page.reload()
    await expect(page.getByText('Why it was undone: The October numbers were wrong.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'View the correction' })).toHaveAttribute(
      'href',
      /entries\/ent_fx_hooks/,
    )
  })

  test('M5: the note on a correction is a note, not an error', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/journal/entries/ent_fx_corr')
    const note = page.getByRole('note').filter({ hasText: 'A person’s correction' })
    await expect(note).toBeVisible()
    await expect(note).not.toHaveClass(/(^| )alert( |$)/)
  })
})
