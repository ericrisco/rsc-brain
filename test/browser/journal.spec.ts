// The journal in a real browser, against the fixture API (spec B6 «Journal», CA14–CA16; T022–T024): the
// sessions with their filters and every state; a session and its entries; an entry with what it can do by
// role (a reader nothing, a contributor their own, a curator everything); correcting with a conflict that
// keeps the text; forgetting with a reason; relating by picking an entry by its words; adding a correction
// from a wiki page; deciding a conflict; forgotten and to review; search and a page's sources open entries.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const J = '/b/growth/journal'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

test.describe('Sessions', () => {
  test('the side bar leads to it: newest first, with client, author, status, entries and summary', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page.locator('aside').getByRole('link', { name: 'Journal' }).click()
    await expect(page).toHaveURL(new RegExp(`${J}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeFocused()
    await expect(page).toHaveTitle(/^Sessions · /)
    const list = page.getByRole('list', { name: 'Sessions' })
    const items = list.getByRole('listitem')
    await expect(items.first()).toContainText('Work without a session on 29 Oct 2026')
    await expect(items.first()).toContainText('Eric, in the web')
    const intros = items.filter({ hasText: 'Review the intros of October' })
    await expect(intros).toContainText('Claude Code of Eric')
    await expect(intros).toContainText('Closed')
    await expect(intros).toContainText('2 entries')
    await expect(intros).toContainText('Short intros keep viewers past 30 seconds')
    await expect(items.filter({ hasText: 'Narrate the intro' })).toContainText('Closed without summary')
    await expect(items.filter({ hasText: 'Narrate the intro' })).toContainText('run r_77, step 3')
    await expect(page.locator('aside').getByRole('link', { name: 'Journal' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await audit(page, 'sessions')
  })

  test('filters picked from what the brain holds, applied together and kept in the address', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(J)
    await page.getByText('Filter the sessions').click()
    await page.getByLabel('Client').selectOption('Codex')
    await page.getByLabel('Author').selectOption({ label: 'Ana' })
    // Nothing applies until the button says so.
    await expect(page.getByRole('list', { name: 'Sessions' }).getByRole('listitem')).toHaveCount(4)
    await page.getByRole('button', { name: 'Apply filters' }).click()
    await expect(page).toHaveURL(/client=Codex/)
    await expect(page).toHaveURL(/author=acc_ana/)
    const items = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem')
    await expect(items).toHaveCount(1)
    await expect(items).toContainText('Fix the onboarding emails')
    await page.reload()
    await expect(items).toHaveCount(1)
    await expect(page.getByLabel('Client')).toHaveValue('Codex')
    // A reference: part of it; Enter in its field applies.
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await page.getByText('Filter the sessions').click()
    await page.getByLabel('External reference').fill('r_77')
    await page.getByLabel('External reference').press('Enter')
    await expect(items).toHaveCount(1)
    await expect(items).toContainText('Narrate the intro')
    await page.getByLabel('Has an entry of type').selectOption('decision')
    await page.getByRole('button', { name: 'Apply filters' }).click()
    await expect(page.getByRole('heading', { name: 'No results for these filters' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).first().click()
    await expect(items).toHaveCount(4)
  })

  test('empty says how entries arrive; loading has its shape; an error recovers', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { sessions: 'empty' })
    await page.goto(J)
    await expect(page.getByRole('heading', { name: 'Nothing written in this journal yet' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to the overview' })).toBeVisible()
    await s.state('sessions', 'error')
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('This did not load')
    await s.state('sessions', 'normal')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('list', { name: 'Sessions' })).toBeVisible()
    await s.state('sessions', 'loading')
    await page.goto(`${J}?status=open`)
    await expect(page.locator('[data-state="loading"]')).toBeVisible()
  })

  test('a lot of sessions come by pages; nothing scrolls sideways at 320 px; offline keeps what it has', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { sessions: 'much-data' })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(J)
    const items = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem')
    await expect(items).toHaveCount(50)
    await expect(page.getByText('504 sessions')).toBeVisible()
    await noSideScroll(page)
    await page.getByRole('button', { name: 'Show more' }).click()
    await expect(items).toHaveCount(100)
    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(page.getByText('Offline: more loads when the connection is back.')).toBeVisible()
    await expect(items).toHaveCount(100)
    await context.setOffline(false)
  })

  test('a brain the person is not in says so', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/nowhere/journal')
    await expect(page.locator('[data-state="forbidden"]')).toContainText('ask a curator')
  })
})

test.describe('A session', () => {
  test('its facts, its summary in plain text and its entries in order, each opening', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(J)
    await page.getByRole('link', { name: 'Review the intros of October' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Review the intros of October' })).toBeFocused()
    await expect(page.locator('.facts')).toContainText('Claude Code of Eric')
    await expect(page.getByRole('link', { name: 'Read the whole summary' })).toBeVisible()
    const entries = page.locator('#session-entries ~ ol > li')
    // In the order written, the summary last.
    await expect(entries).toHaveCount(3)
    await expect(entries.first()).toContainText('Short intros keep viewers')
    await page.getByRole('link', { name: 'The hook goes first' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'The hook goes first' })).toBeVisible()
    await audit(page, 'entry')
  })
})

test.describe('An entry', () => {
  test('a reader sees what it says and who wrote it, no action, and whom to ask', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/b/support/journal/entries/ent_fx_take_support')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Narrated the intro of video 41' }),
    ).toBeVisible()
    await expect(page.locator('.page-meta')).toContainText('RSC Factory (run r_77, step 3) on behalf of Eric')
    await expect(page.locator('[data-state="no-actions"]')).toContainText(
      'ask a curator of Support (Eric) for the contributor role',
    )
    await expect(page.getByRole('button', { name: /Correct|Forget|Pin|Relate/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Add a correction/ })).toHaveCount(0)
  })

  test('a contributor corrects their own entry: a new revision, said aloud, in its history', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto(`${J}/entries/ent_fx_30s`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Thirty-second intros work best' }),
    ).toBeVisible()
    // Not hers: she relates it, but neither corrects nor forgets it.
    await page.goto(`${J}/entries/ent_fx_intros`)
    await expect(page.getByRole('button', { name: 'Relate to another entry…' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit this entry' })).toHaveCount(0)
    await page.goto(`${J}/entries/ent_fx_30s`)
    await page.getByRole('button', { name: 'Edit this entry' }).click()
    await page
      .getByLabel('Text')
      .fill('In the support videos, intros of about twenty seconds kept the most viewers.')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 2.' })).toBeVisible()
    await expect(page.locator('.prose')).toContainText('twenty seconds')
    await expect(page.locator('#entry-history ~ ol li')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Pin' })).toHaveCount(0)
  })

  test('someone corrected it meanwhile: nothing saved, their version shown, mine kept and can still win', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/entries/ent_fx_hooks`)
    await page.getByRole('button', { name: 'Edit this entry' }).click()
    await page.getByLabel('Text').fill('Mine: start with the question, always.')
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/entry-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth', id: 'ent_fx_hooks', content: 'Theirs: the hook goes first.' }),
    })
    // A reload loses nothing: the draft brings the form back.
    await page.reload()
    await expect(page.getByLabel('Text')).toHaveValue('Mine: start with the question, always.')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('alert')).toContainText('Someone changed this entry while you corrected it')
    await expect(page.getByRole('alert')).toContainText('Theirs: the hook goes first.')
    await expect(page.getByLabel('Your text')).toHaveValue('Mine: start with the question, always.')
    await page.getByRole('button', { name: 'Save mine over theirs' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 3.' })).toBeVisible()
    await expect(page.locator('.prose')).toContainText('Mine: start with the question')
  })

  test('forgetting asks why and says what happens; a curator recovers it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/entries/ent_fx_plain`)
    await page.getByRole('button', { name: 'Forget…' }).click()
    const d = page.getByRole('dialog', { name: 'Forget this entry?' })
    await expect(d).toContainText('It leaves search, the agents’ context')
    // The reason is what the dialog asks: the keyboard starts there.
    await expect(d.getByLabel('Why (required)')).toBeFocused()
    await d.getByRole('button', { name: 'Forget entry' }).click()
    await expect(d.getByText('Say why it is forgotten.')).toBeVisible()
    await expect(d.getByLabel('Why (required)')).toBeFocused()
    await d.getByLabel('Why (required)').fill('Plain text was a dead end.')
    await d.getByRole('button', { name: 'Forget entry' }).click()
    await expect(d).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Forgotten.' })).toBeVisible()
    await expect(page.locator('.page-main')).toContainText('Forgotten by Eric')
    // «Forget…» is gone: the keyboard goes to the heading, not to the page's body.
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
    await page.getByRole('button', { name: 'Recover' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Recovered' })).toBeVisible()
  })

  test('relating: the other entry is picked by its words, Enter picks and never sends', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/entries/ent_fx_hooks`)
    await page.getByRole('button', { name: 'Relate to another entry…' }).click()
    const d = page.getByRole('dialog', { name: 'Relate to another entry' })
    await d.getByLabel('is replaced by the other one', { exact: false }).check()
    await d.getByRole('button', { name: 'Save relation' }).click()
    await expect(d.getByText('Pick the other entry from the list.')).toBeVisible()
    await expect(d.getByLabel('The other entry')).toBeFocused()
    await d.getByLabel('The other entry').fill('thirty')
    await expect(d.getByRole('option', { name: /Thirty-second intros/ })).toBeVisible()
    await d.getByLabel('The other entry').press('Enter')
    await expect(d.getByText('Picked: Thirty-second intros work best')).toBeVisible()
    await expect(d).toBeVisible()
    await d.getByRole('button', { name: 'Save relation' }).click()
    await expect(d).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Relation saved.' })).toBeVisible()
    await expect(page.locator('#entry-relations ~ ul')).toContainText(
      'Superseded by Thirty-second intros work best',
    )
    await expect(page.locator('.page-main')).toContainText('Superseded')
  })

  test('a curator pins and dates it; the markdown is safe; an entry that does not exist says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/entries/ent_fx_plain`)
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    await page.getByRole('button', { name: 'Pin' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Pinned' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unpin' })).toHaveAttribute('aria-pressed', 'true')
    // Its dates are shown open: it has one already.
    await expect(page.getByLabel('Review after')).toHaveValue('2026-10-20')
    await page.getByLabel('Review after').fill('2026-12-01')
    await page.getByRole('button', { name: 'Save dates' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Dates saved.' })).toBeVisible()
    await page.goto(`${J}/entries/ent_nope`)
    await expect(
      page.getByRole('heading', { name: 'No entry with that id is available to you' }),
    ).toBeVisible()
  })

  test('at 320 px the entry, its actions and its aside fit', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(`${J}/entries/ent_fx_take`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await noSideScroll(page)
    await page.getByRole('button', { name: 'Edit this entry' }).click()
    await noSideScroll(page)
    // Without a date, the dates are folded; opened, they fit too.
    await page.getByText('Review and expiry dates').click()
    await expect(page.getByLabel('Review after')).toBeVisible()
    await noSideScroll(page)
    for (const path of ['', '/conflicts', '/to-review', '/forgotten', '/correct', '/sessions/ses_fx_3']) {
      await page.goto(`${J}${path}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await noSideScroll(page)
    }
  })
})

test.describe('Add a correction', () => {
  test('CA12 in the web: from a wiki page, about that page, for one agent; it opens as the new entry', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/audience/intros')
    await page.getByRole('link', { name: 'Add a correction' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Add a correction' })).toBeVisible()
    await expect(page.getByLabel('A page of the wiki')).toBeChecked()
    await expect(page.getByText('Picked: Writing intros')).toBeVisible()
    // A way back to where the person came from.
    await expect(page.getByRole('link', { name: 'Cancel' })).toHaveAttribute(
      'href',
      '/b/growth/pages/audience/intros',
    )
    await page.getByRole('button', { name: 'Add correction' }).click()
    await expect(page.getByText('Give it a one-line title.')).toBeVisible()
    await expect(page.getByLabel('Title')).toBeFocused()
    await page.getByLabel('Title').fill('The long intro loses viewers')
    await page.getByLabel('The correction').fill('Open with the question of the video; no greeting.')
    await page.getByLabel('Applies to (optional)').fill('narrator')
    await page.getByRole('button', { name: 'Add correction' }).click()
    await expect(page).toHaveURL(/\/journal\/entries\/ent_fx_new/)
    await expect(page.getByRole('status').filter({ hasText: 'Correction added' })).toBeVisible()
    await expect(page.locator('.page-main')).toContainText('the page audience/intros')
    await expect(page.locator('.facts')).toContainText('narrator')
  })

  test('about an entry picked by its words; what is typed survives a reload', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/correct`)
    await page.getByLabel('An entry of the journal').check()
    await page.getByLabel('Title').fill('Keep it')
    await page.getByLabel('The correction').fill('Keep the HTML emails.')
    await page.reload()
    await expect(page.getByLabel('The correction')).toHaveValue('Keep the HTML emails.')
    await page.getByLabel('The other entry').fill('plain')
    await expect(page.getByRole('option', { name: /Plain-text onboarding emails/ })).toBeVisible()
    await page.getByLabel('The other entry').press('ArrowDown')
    await page.getByLabel('The other entry').press('Enter')
    await expect(page.getByText('Picked: Plain-text onboarding emails')).toBeVisible()
    await page.getByRole('button', { name: 'Add correction' }).click()
    await expect(page.locator('.page-main')).toContainText('the entry')
    await audit(page, 'new correction')
  })

  test('a reader cannot, and is told whom to ask', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/b/support/journal/correct')
    await expect(page.locator('[data-state="forbidden"]')).toContainText('Support (Eric)')
    await expect(page.getByRole('button', { name: 'Add correction' })).toHaveCount(0)
  })
})

test.describe('Conflicts, forgotten, to review', () => {
  test('CA11 in the web: a conflict side by side; «A replaces B» confirmed, it leaves the list', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/conflicts`)
    await expect(page.getByText('2 conflicts')).toBeVisible()
    const tab = page
      .getByRole('navigation', { name: 'Journal sections' })
      .getByRole('link', { name: /Conflicts/ })
    await expect(tab).toHaveText('Conflicts 2')
    const first = page.locator('.conflict-item').filter({ hasText: 'These two contradict each other' })
    await expect(first).toContainText('Thirty-second intros work best')
    await expect(first).toContainText('Short intros keep viewers')
    await expect(page.locator('.conflict-item').filter({ hasText: 'An agent asked' })).toContainText(
      '“Greetings help the narrator” replaces “No greeting before the hook”',
    )
    await first
      .getByRole('button', { name: '“Short intros keep viewers” replaces “Thirty-second intros work best”' })
      .click()
    const d = page.getByRole('dialog', { name: 'Decide this conflict?' })
    await expect(d).toContainText('leaves the agents’ context')
    await d.getByRole('button', { name: 'Decide' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Decided.' })).toBeVisible()
    await expect(page.getByText('1 conflict', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
    await audit(page, 'conflicts')
  })

  test('a reader reads conflicts without buttons; empty says what shows here', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'member')
    await page.goto('/b/support/journal/conflicts')
    await expect(page.locator('[data-state="read-only"]')).toContainText('Support (Eric)')
    await expect(page.locator('.conflict-item').first()).toBeVisible()
    await expect(page.locator('.conflict-item').getByRole('button')).toHaveCount(0)
    await s.state('conflicts', 'empty')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'No conflicts' })).toBeVisible()
  })

  test('forgotten: for curators, with who and why, and recover; others are told whom to ask', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/forgotten`)
    const item = page.getByRole('listitem').filter({ hasText: 'Old pricing note' })
    await expect(item).toContainText('Forgotten by Eric')
    await expect(item).toContainText('Replaced by the annual plans decision.')
    await item.getByRole('button', { name: 'Recover: Old pricing note' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Recovered' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Nothing forgotten' })).toBeVisible()
    await context.clearCookies()
    await scenario(context, baseURL as string, 'member')
    await page.goto('/b/support/journal/forgotten')
    await expect(page.locator('[data-state="forbidden"]')).toContainText(
      'Only curators see forgotten entries',
    )
    await expect(
      page.getByRole('navigation', { name: 'Journal sections' }).getByRole('link', { name: 'Forgotten' }),
    ).toHaveCount(0)
  })

  test('to review: past their date; «Mark reviewed» clears it', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/to-review`)
    const item = page.getByRole('listitem').filter({ hasText: 'Plain-text onboarding emails' })
    await expect(item).toContainText('review was due 20 Oct 2026')
    await item.getByRole('button', { name: 'Mark reviewed: Plain-text onboarding emails' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Marked reviewed' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Nothing to review' })).toBeVisible()
  })

  test('long lists go by pages; errors recover', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', {
      conflicts: 'much-data',
      forgotten: 'much-data',
    })
    await page.goto(`${J}/conflicts`)
    await expect(page.locator('.conflict-item')).toHaveCount(10)
    await page.getByRole('button', { name: 'Show more' }).click()
    await expect(page.locator('.conflict-item')).toHaveCount(20)
    await page.goto(`${J}/forgotten`)
    await expect(page.locator('main ul.list > li')).toHaveCount(50)
    await s.state('to-review', 'error')
    await page.goto(`${J}/to-review`)
    await expect(page.getByRole('alert')).toContainText('This did not load')
  })
})

test.describe('Entries open from elsewhere', () => {
  test('a search result that is an entry opens it', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page
      .locator('header')
      .getByRole('button', { name: /Search/ })
      .click()
    await page.getByLabel('Search all your brains').fill('thirty')
    await page.keyboard.press('Enter')
    const hit = page
      .getByRole('dialog', { name: 'Search' })
      .getByRole('link', { name: 'Thirty-second intros work best' })
    await expect(hit).toBeVisible()
    await hit.click()
    await expect(page).toHaveURL(new RegExp(`${J}/entries/ent_fx_30s$`))
    await expect(
      page.getByRole('heading', { level: 1, name: 'Thirty-second intros work best' }),
    ).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden()
  })

  test('a page’s source panel opens the entry in the journal', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/audience/retention')
    await page.getByRole('button', { name: 'The hook goes first' }).click()
    const panel = page.getByRole('dialog', { name: 'The hook goes first' })
    await panel.getByRole('link', { name: 'Open in the journal' }).click()
    await expect(page).toHaveURL(new RegExp(`${J}/entries/ent_fx_hooks$`))
    await expect(page.getByRole('heading', { level: 1, name: 'The hook goes first' })).toBeVisible()
  })
})
