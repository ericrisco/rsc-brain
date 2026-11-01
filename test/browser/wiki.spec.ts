// Spec B6 «Wiki» (PR19, T017): the map with its filters, and a page — its body formatted (never run), its
// type and status in words, links by kind, a broken link that says the page does not exist, and its
// sources opening beside it without leaving it (CA4). Against the fixture API, in CI.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const RETENTION = '/b/growth/pages/audience/retention'

test.describe('the map', () => {
  test('the side bar leads to it: intro, pages by type, each with its summary', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page
      .getByRole('navigation', { name: 'Sections of this brain' })
      .getByRole('link', { name: 'Wiki' })
      .click()
    await expect(page).toHaveURL(/\/b\/growth\/wiki$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Wiki' })).toBeFocused()
    await expect(page).toHaveTitle(/^Wiki · /)
    await expect(page.getByText('The audience, the product and how we decide.')).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Topics' })).toBeVisible()
    const retention = page.getByRole('link', { name: 'Retention', exact: true })
    await expect(retention).toBeVisible()
    await expect(page.getByText('What keeps viewers watching.')).toBeVisible()
    // Superseded and retired pages are on the map too (review of PR19), and say so in words.
    await expect(page.getByRole('listitem').filter({ hasText: 'Old intros' }).locator('.tag')).toHaveText(
      'Superseded',
    )
    await retention.click()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeFocused()
  })

  test('filters by type, tag and words, kept in the address; nothing left says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/wiki')
    await page.getByLabel('Type').selectOption('decision')
    await expect(page).toHaveURL(/\?type=decision$/)
    await expect(page.getByRole('link', { name: 'Annual plans' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Retention', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByLabel('Type')).toHaveValue('decision')
    await expect(page.getByRole('link', { name: 'Annual plans' })).toBeVisible()
    await page.getByLabel('Type').selectOption('')
    await page.getByLabel('Tag').selectOption('metric')
    await expect(page.getByRole('link', { name: 'Retention', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Annual plans' })).toHaveCount(0)
    await page.getByLabel('Tag').selectOption('')
    await page.getByLabel('Filter by words').fill('no page says this')
    await expect(page.getByText('No results for these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(page.getByRole('link', { name: 'Retention', exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/wiki$/)
  })

  test('empty: says how pages arrive', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { map: 'empty' })
    await page.goto('/b/growth/wiki')
    await expect(page.getByRole('heading', { name: 'This wiki has no pages yet' })).toBeVisible()
    await expect(page.getByText('Pages arrive when a curator approves a proposal')).toBeVisible()
  })

  test('loading shows its shape; an error says what happened and recovers', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { map: 'loading' })
    await page.goto('/b/growth/wiki')
    await expect(page.locator('[data-state="loading"]')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Retention', exact: true })).toBeVisible({ timeout: 10_000 })
    await s.state('map', 'error')
    await page.reload()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Something went wrong on the server')
    await s.state('map', 'normal')
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('link', { name: 'Retention', exact: true })).toBeVisible()
  })

  test('a lot of pages: each group shows a few and opens whole; nothing scrolls sideways at 320 px', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { map: 'much-data' })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/b/growth/wiki')
    const first = page.getByRole('button', { name: /^Show all \d+$/ }).first()
    await expect(first).toBeVisible()
    // The group of that button, pinned by its heading (the button's name changes once open).
    const id = await first
      .locator('xpath=ancestor::div[contains(@class, "map-group")][1]')
      .getAttribute('data-group')
    const group = page.locator(`.map-group[data-group="${id}"]`)
    await expect(group.getByRole('listitem')).toHaveCount(12)
    await group.getByRole('button', { name: /^Show all \d+$/ }).click()
    await expect.poll(() => group.getByRole('listitem').count()).toBeGreaterThan(12)
    await expect(group.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true')
    await noSideScroll(page)
  })

  test('a brain the person cannot read says so and who to ask', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { brain: 'forbidden' })
    await page.goto('/b/growth/wiki')
    await expect(page.getByRole('alert')).toContainText('ask a curator of that brain to add you')
  })
})

test.describe('a page', () => {
  test('its body is formatted, with its type and status in words and links that work', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await expect(page).toHaveTitle(/^Retention · /)
    const head = page.locator('.page-meta')
    await expect(head).toContainText('Topic')
    await expect(head).toContainText('Current')
    await expect(head).toContainText('audience/retention')
    await expect(head).toContainText('Revision 3')
    const body = page.locator('.prose')
    await expect(body.getByRole('heading', { level: 2, name: 'What keeps viewers' })).toBeVisible()
    await expect(body.getByRole('listitem').first()).toContainText('Start with the question')
    const external = body.getByRole('link', { name: 'retention report' })
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(external).toHaveAttribute('target', '_blank')
    // A mention of a page still to write looks different and says it in words.
    const broken = body.getByRole('link', { name: /drafts\/hooks-that-work/ })
    await expect(broken).toContainText('(no page yet)')
    await expect(broken).toHaveClass(/broken/)
    await expect(body.getByRole('link', { name: /Consent in 2024/ })).toContainText('(retired)')
  })

  test('links from and to it, grouped by kind, each saying the state of the other page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    const links = page.getByRole('region', { name: 'Links' })
    const from = links.getByRole('group', { name: 'From this page' })
    await expect(from.getByRole('heading', { name: 'Mentions' })).toBeVisible()
    await expect(from.getByRole('heading', { name: 'Related' })).toBeVisible()
    await expect(from.getByRole('heading', { name: 'Depends on' })).toBeVisible()
    await expect(from.getByRole('listitem').filter({ hasText: 'drafts/hooks-that-work' })).toContainText(
      'no page yet',
    )
    const to = links.getByRole('group', { name: 'To this page' })
    await expect(to.getByRole('link', { name: 'Writing intros' })).toBeVisible()
  })

  test('a link to a page that does not exist leads to a page that says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    await page
      .locator('.prose')
      .getByRole('link', { name: /drafts\/hooks-that-work/ })
      .click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'No page at drafts/hooks-that-work' }),
    ).toBeVisible()
    await expect(page.getByText('A link to it is kept as a reminder')).toBeVisible()
    await page.getByRole('link', { name: 'Back to the wiki' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Wiki' })).toBeVisible()
  })

  test('superseded leads to its replacement; retired and stale say what they mean', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/audience/old-intros')
    const note = page.getByRole('note')
    await expect(note).toContainText('Superseded')
    await note.getByRole('link', { name: 'audience/intros' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Writing intros' })).toBeVisible()
    await page.goto('/b/growth/pages/legal/consent-2024')
    await expect(page.getByRole('note')).toContainText('Retired: kept for its history only.')
    await page.goto('/b/growth/pages/guides/weekly-review')
    await expect(page.getByRole('note')).toContainText('Stale: this page may be out of date')
  })

  test('CA4: a source opens beside the page, which stays; Esc closes it and the keyboard returns', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    const sources = page.getByRole('region', { name: 'Sources' })
    // A forgotten source keeps its place, says so, and opens nothing.
    await expect(sources).toContainText('forgotten since')
    const open = sources.getByRole('button', { name: 'Short intros keep viewers' })
    await open.click()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}\\?source=ent_fx_intros$`))
    const panel = page.getByRole('dialog', { name: 'Short intros keep viewers' })
    await expect(panel).toContainText('Intros under ten seconds kept 70% of viewers')
    await expect(page.locator('.prose')).toContainText('What keeps viewers')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(open).toBeFocused()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}$`))
    // The address with ?source= opens it straight away (a link shared or a reload).
    await page.goto(`${RETENTION}?source=ent_fx_hooks`)
    await expect(page.getByRole('dialog', { name: 'The hook goes first' })).toBeVisible()
    // A link source leaves the web in a new tab.
    await page.keyboard.press('Escape')
    await expect(sources.getByRole('link', { name: 'October retention report' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    )
  })

  test('nothing an agent wrote runs: raw HTML shows as text, a script link is no link', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/notes/raw-html')
    const body = page.locator('.prose')
    await expect(body).toContainText('<script>window.__pwned = 1</script>')
    await expect(body).toContainText('<img src="x" onerror')
    await expect(body.getByRole('link', { name: 'click me' })).toHaveCount(0)
    await expect(body.getByText('click me')).toBeVisible()
    await expect(body.getByRole('link', { name: 'Image: a chart' })).toBeVisible()
    await expect(body.locator('img, script')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  })

  test('loading, an error with try again, and offline after loading', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { page: 'error' })
    await page.goto(RETENTION)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Something went wrong on the server')
    await s.state('page', 'normal')
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByText('You are offline.')).toBeVisible()
    await expect(page.locator('.prose')).toContainText('What keeps viewers')
    await context.setOffline(false)
  })

  test('at 320 px nothing scrolls sideways, sources and links under the body', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(RETENTION)
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await noSideScroll(page)
    await page
      .getByRole('region', { name: 'Sources' })
      .getByRole('button', { name: 'Short intros keep viewers' })
      .click()
    await expect(page.getByRole('dialog', { name: 'Short intros keep viewers' })).toBeVisible()
    await noSideScroll(page)
  })
})

// T018: the history of a page with the differences between any two revisions; a curator restores one; who
// read the page is for curators only (pack rule 7).
test.describe('the history of a page', () => {
  test('the last changes beside the page, and every revision with who made it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    const recent = page.getByRole('region', { name: 'Recent changes' })
    await expect(recent.getByRole('listitem')).toHaveCount(3)
    await expect(recent.getByRole('listitem').first()).toContainText('Revision 3')
    await recent.getByRole('link', { name: 'All 3 revisions and their differences' }).click()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}\\?view=history$`))
    const list = page.getByRole('region', { name: 'Revisions' })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect(list.getByRole('listitem').nth(0)).toContainText('Revision 3 · edited by Eric')
    await expect(list.getByRole('listitem').nth(1)).toContainText('Revision 2 · edited by Ana')
    await expect(list.getByRole('listitem').nth(2)).toContainText('Revision 1 · created by Eric')
  })

  test('the differences between any two revisions, word by word, kept in the address', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${RETENTION}?view=history`)
    // The last two by default.
    await expect(page.getByRole('heading', { name: 'Changes from revision 2 to 3' })).toBeVisible()
    await page.getByLabel('From', { exact: true }).selectOption('1')
    await page.getByLabel('To', { exact: true }).selectOption('3')
    await page.getByRole('button', { name: 'Show the differences' }).click()
    await expect(page).toHaveURL(/compare=1%2C3|compare=1,3/)
    const diff = page.getByRole('region', { name: 'Changes from revision 1 to 3' })
    // Revision 1 said "Long intros lose viewers."; revision 3 adds a line about the greeting.
    await expect(diff.locator('del').filter({ hasText: 'viewers' })).not.toHaveCount(0)
    await expect(diff.locator('ins').filter({ hasText: 'greeting' })).not.toHaveCount(0)
    await expect(diff.getByRole('heading', { name: 'Body' })).toBeVisible()
    await expect(diff.getByRole('heading', { name: 'Title' })).toHaveCount(0)
    // Added and removed say so in words too, for those who do not see the colour.
    await expect(diff.locator('ins').first().locator('.sr-only')).toHaveText('added:')
    await page.reload()
    await expect(page.getByRole('region', { name: 'Changes from revision 1 to 3' })).toBeVisible()
    await noSideScroll(page)
  })

  test('a curator restores an old revision as a new one; nothing is deleted', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${RETENTION}?view=history`)
    const list = page.getByRole('region', { name: 'Revisions' })
    // The current one has nothing to restore.
    await expect(list.getByRole('listitem').nth(0).getByRole('button')).toHaveCount(0)
    await list.getByRole('button', { name: 'Restore revision 1' }).click()
    const ask = page.getByRole('dialog', { name: 'Restore revision 1?' })
    await expect(ask).toContainText('Nothing is deleted')
    await ask.getByRole('button', { name: 'Restore revision 1' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Restored revision 1 as revision 4.' }),
    ).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveCount(4)
    await expect(list.getByRole('listitem').nth(0)).toContainText('Revision 4 · restored revision 1 by Eric')
    await expect(page.locator('.page-meta')).toContainText('Revision 4')
  })

  test('who read the page: a curator sees it; anyone else sees neither it nor the restore', async ({
    browser,
    baseURL,
  }) => {
    const curator = await browser.newContext()
    await scenario(curator, baseURL as string, 'signed-in')
    const c = await curator.newPage()
    await c.goto(RETENTION)
    const readers = c.getByRole('region', { name: 'Who read this' })
    await expect(readers).toContainText('Ana')
    await expect(readers).toContainText('with Claude Code')
    await curator.close()
    const member = await browser.newContext()
    await scenario(member, baseURL as string, 'member')
    const m = await member.newPage()
    await m.goto(RETENTION)
    await expect(m.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await expect(m.getByRole('region', { name: 'Sources' })).toBeVisible()
    await expect(m.getByRole('region', { name: 'Who read this' })).toHaveCount(0)
    await m.goto(`${RETENTION}?view=history`)
    await expect(m.getByRole('region', { name: 'Revisions' }).getByRole('listitem')).toHaveCount(3)
    await expect(m.getByRole('button', { name: /^Restore/ })).toHaveCount(0)
    await member.close()
  })

  test('a history that does not load says so and recovers', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { trail: 'error' })
    await page.goto(RETENTION)
    await expect(page.getByRole('region', { name: 'Who read this' }).getByRole('alert')).toContainText(
      'Something went wrong',
    )
    // The page itself is still there.
    await expect(page.locator('.prose')).toContainText('What keeps viewers')
  })
})

// T019: a curator edits a page by hand — markdown with a preview, `[[` completing addresses, typed links,
// sources, status and address — and an edit on a page someone saved meanwhile loses nothing (CA10).
test.describe('editing a page', () => {
  const EDIT = `${RETENTION}?view=edit`
  const bodyField = (page: import('@playwright/test').Page) => page.getByLabel('Body', { exact: true })

  test('write, preview, complete a [[link]], save: a new revision says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    await page
      .getByRole('navigation', { name: 'Views of this page' })
      .getByRole('link', { name: 'Edit' })
      .click()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}\\?view=edit$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Edit Retention' })).toBeVisible()
    const body = bodyField(page)
    await expect(body).toHaveValue(/What keeps viewers/)
    await body.fill('Short intros win. See [[aud')
    const list = page.getByRole('listbox', { name: 'Pages to link' })
    await expect(list.getByRole('option', { name: /audience\/intros/ })).toBeVisible()
    await expect(body).toHaveAttribute('aria-expanded', 'true')
    // Next to the line being typed, even at the end of a long body (walk of PR19: under the field it was
    // out of sight).
    await expect(list).toBeInViewport()
    await body.fill(`${'A line.\n'.repeat(14)}See [[aud`)
    await expect(list).toBeInViewport()
    await body.fill('Short intros win. See [[aud')
    // The first page found is chosen already: Enter takes it.
    await body.press('Enter')
    await expect(body).toHaveValue('Short intros win. See [[audience/intros]]')
    await expect(list).toHaveCount(0)
    await page.getByRole('button', { name: 'Preview' }).click()
    const preview = page.locator('.preview.prose')
    await expect(preview.getByRole('link', { name: 'Writing intros' })).toHaveAttribute(
      'title',
      'audience/intros',
    )
    await page.getByRole('button', { name: 'Write' }).click()
    await page.getByLabel('Summary').fill('Short intros keep viewers.')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}$`))
    await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 4.' })).toBeVisible()
    await expect(page.locator('.prose')).toContainText('Short intros win.')
    await expect(page.locator('.page-meta')).toContainText('Revision 4')
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeFocused()
  })

  test('CA10: someone saved meanwhile — nothing is lost, what changed is shown, mine can still win', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await bodyField(page).fill('My careful rewrite of the retention page.')
    // Eva saves the same page in the meantime.
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brain: 'growth',
        address: 'audience/retention',
        body: 'Eva says: intros of 5 seconds.',
      }),
    })
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: 'Eva saved revision 4 while you edited' })
    await expect(conflict).toBeVisible()
    await expect(conflict).toContainText('It is at revision 4 now. Nothing of yours was saved')
    const theirs = conflict.getByRole('region', { name: 'What Eva changed' })
    await expect(theirs.locator('ins').filter({ hasText: 'Eva' })).not.toHaveCount(0)
    await expect(conflict.getByLabel('Your text')).toHaveValue('My careful rewrite of the retention page.')
    await expect(bodyField(page)).toHaveValue('My careful rewrite of the retention page.')
    // A reload keeps it too.
    await page.reload()
    await expect(page.getByText('Your unsaved changes in this tab are back.')).toBeVisible()
    await expect(bodyField(page)).toHaveValue('My careful rewrite of the retention page.')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(conflict).toBeVisible()
    await conflict.getByRole('radio', { name: 'Keep mine' }).check()
    await conflict.getByRole('button', { name: 'Save this result' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 5.' })).toBeVisible()
    await expect(page.locator('.prose')).toContainText('My careful rewrite')
  })

  test('CA10: or start again from theirs, with my text kept beside to copy from', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await bodyField(page).fill('Mine.')
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth', address: 'audience/retention', body: 'Theirs.' }),
    })
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: 'Eva saved revision 4 while you edited' })
    await conflict.getByRole('button', { name: 'Start again from theirs' }).click()
    await expect(bodyField(page)).toHaveValue('Theirs.')
    await expect(page.getByLabel('Your text')).toHaveValue('Mine.')
    await bodyField(page).fill('Theirs. And mine.')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 5.' })).toBeVisible()
  })

  test('a draft survives a reload and can be discarded', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Title', { exact: true }).fill('Retention, again')
    await page.reload()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retention, again')
    await page.getByRole('button', { name: 'Discard my changes' }).click()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retention')
    await page.reload()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retention')
  })

  test('problems the server finds are listed, the text stays; offline, saving says why it cannot', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Title', { exact: true }).fill('x'.repeat(201))
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('alert')).toContainText('"title" is longer than 200 characters.')
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('x'.repeat(201))
    await context.setOffline(true)
    await expect(page.getByText('You are offline.').first()).toBeVisible()
    const save = page.getByRole('button', { name: 'Save changes' })
    await expect(save).toHaveAttribute('aria-disabled', 'true')
    await context.setOffline(false)
  })

  test('sources: remove one, add a link; the page lists them after saving', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const sources = page.getByRole('group', { name: 'Sources' })
    await sources
      .getByRole('listitem')
      .filter({ hasText: 'ent_fx_gone' })
      .getByRole('button', { name: 'Remove' })
      .click()
    await sources.getByLabel('Or a link').fill('https://example.test/notes')
    await sources.getByLabel('Its title').fill('Team notes')
    await sources.getByRole('button', { name: 'Add source' }).click()
    await expect(sources.getByRole('listitem').filter({ hasText: 'Team notes' })).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()
    const read = page.getByRole('region', { name: 'Sources' })
    await expect(read.getByRole('link', { name: 'Team notes' })).toBeVisible()
    await expect(read).not.toContainText('forgotten since')
  })

  test('typed links, status and address change at once, each saying what it did', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const links = page.getByRole('region', { name: 'Typed links' })
    await links.getByLabel('Kind').selectOption('example-of')
    const to = links.getByLabel('To page')
    await to.fill('pricing')
    await links.getByRole('option', { name: /product\/pricing/ }).click()
    await expect(to).toHaveValue('product/pricing')
    await links.getByRole('button', { name: 'Add link' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Linked: Example of product/pricing.' }),
    ).toBeVisible()
    const added = links
      .getByRole('listitem')
      .filter({ hasText: 'product/pricing' })
      .filter({ hasText: 'Example of' })
    await added.getByRole('button', { name: 'Remove' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Removed the link: Example of product/pricing.' }),
    ).toBeVisible()
    // The form moved on to the new revision: saving it does not conflict. Status and address are part
    // of the same Save (review of PR19).
    await page.getByLabel('Summary').fill('Still what keeps viewers.')
    const status = page.getByRole('group', { name: 'Status and address' })
    await status.getByLabel('Status').selectOption('stale')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The page is stale now.' })).toBeVisible()
    await page.goto(EDIT)
    await status.getByLabel('Address', { exact: true }).fill('audience/what-keeps-viewers')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(/\/pages\/audience\/what-keeps-viewers$/)
    await expect(
      page.getByRole('status').filter({ hasText: 'The page lives at audience/what-keeps-viewers now' }),
    ).toBeVisible()
    // Its old address still leads to it.
    await page.goto(RETENTION)
    await expect(page).toHaveURL(/\/pages\/audience\/what-keeps-viewers$/)
    await expect(page.getByText('You followed an old address (audience/retention)')).toBeVisible()
  })

  test('someone who is not a curator has no edit, and the address says who may', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto(RETENTION)
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Views of this page' }).getByRole('link', { name: 'Edit' }),
    ).toHaveCount(0)
    await page.goto(EDIT)
    await expect(page.getByText('Only curators of this brain edit its pages by hand.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
  })

  test('at 320 px the editor fits', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(EDIT)
    await expect(bodyField(page)).toBeVisible()
    await noSideScroll(page)
  })
})

// T020: the decisions and the log of the wiki, filterable, in every state.
test.describe('decisions', () => {
  test('newest first with their status in words; filters by status and words', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page
      .getByRole('navigation', { name: 'Sections of this brain' })
      .getByRole('link', { name: 'Decisions' })
      .click()
    await expect(page.getByRole('heading', { level: 1, name: 'Decisions' })).toBeFocused()
    const list = page.getByRole('list', { name: 'Decisions' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByRole('listitem').filter({ hasText: 'Monthly only' })).toContainText('Superseded')
    await page.getByLabel('Status').selectOption('superseded')
    await expect(page).toHaveURL(/status=superseded/)
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await page.getByLabel('Status').selectOption('')
    await page.getByLabel('Filter by words').fill('two months')
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await list.getByRole('link', { name: 'Annual plans' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Annual plans' })).toBeVisible()
    await page.goBack()
    await page.getByLabel('Filter by words').fill('nothing like this')
    await expect(page.getByText('No results for these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(list.getByRole('listitem')).toHaveCount(2)
  })

  test('empty, loading, an error, a lot of them', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { decisions: 'empty' })
    await page.goto('/b/growth/wiki/decisions')
    await expect(page.getByRole('heading', { name: 'No decisions yet' })).toBeVisible()
    await s.state('decisions', 'error')
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('Something went wrong')
    await s.state('decisions', 'much-data')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect
      .poll(() => page.getByRole('list', { name: 'Decisions' }).getByRole('listitem').count())
      .toBeGreaterThan(20)
    await page.setViewportSize({ width: 320, height: 640 })
    await noSideScroll(page)
    await s.state('decisions', 'loading')
    await page.reload()
    await expect(page.locator('[data-state="loading"]')).toBeVisible()
  })
})

test.describe('the log', () => {
  test('one line a change, by whom, with the pages it touched; filters by kind and page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page
      .getByRole('navigation', { name: 'Sections of this brain' })
      .getByRole('link', { name: 'Log' })
      .click()
    await expect(page.getByRole('heading', { level: 1, name: 'Log' })).toBeFocused()
    const list = page.getByRole('list', { name: 'Changes' })
    const first = list.getByRole('listitem').first()
    await expect(first).toContainText('by ')
    await page.getByLabel('Kind of change').selectOption('direct')
    await expect(page).toHaveURL(/kind=direct/)
    await expect(list.getByRole('listitem').first()).toContainText('Direct edit')
    await expect(list.getByRole('listitem').filter({ hasNotText: 'Direct edit' })).toHaveCount(0)
    await page.getByLabel('Kind of change').selectOption('')
    await page.getByLabel('Page', { exact: true }).fill('product/pricing')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(/page=product%2Fpricing/)
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await list.getByRole('link', { name: 'product/pricing' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Annual plans' })).toBeVisible()
    await page.goBack()
    await page.getByLabel('Kind of change').selectOption('purge')
    await expect(page.getByText('No results for these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(page).toHaveURL(/\/wiki\/log$/)
  })

  test('a long log goes by pages, «Show more» adds the next', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { log: 'much-data' })
    await page.goto('/b/growth/wiki/log')
    const list = page.getByRole('list', { name: 'Changes' })
    await expect(list.getByRole('listitem')).toHaveCount(50)
    await page.getByRole('button', { name: 'Show more' }).click()
    await expect(list.getByRole('listitem')).toHaveCount(100)
    await page.setViewportSize({ width: 320, height: 640 })
    await noSideScroll(page)
  })

  test('empty and an error', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { log: 'empty' })
    await page.goto('/b/growth/wiki/log')
    await expect(page.getByRole('heading', { name: 'Nothing has changed in this wiki yet' })).toBeVisible()
    await s.state('log', 'error')
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('Something went wrong')
  })
})

// Search found wiki pages before this screen existed; now a page found opens (nothing leads nowhere).
test('a wiki page found by search opens, and the search closes', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'Search' })
  await dialog.getByLabel('Search for').fill('retention')
  await dialog.getByLabel('Search for').press('Enter')
  await dialog.getByRole('link', { name: 'Retention' }).first().click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
})

// Walk of PR19: "Save mine over theirs" puts my changes on top of theirs; a part only they changed keeps
// their words (it used to put back the old summary they had just fixed).
test('saving mine over theirs keeps what only they changed', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/pages/audience/retention?view=edit')
  await page.getByLabel('Title', { exact: true }).fill('Retention, by Eric')
  await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain: 'growth', address: 'audience/retention', body: 'Eva rewrote the body.' }),
  })
  await page.getByRole('button', { name: 'Save changes' }).click()
  const conflict = page.getByRole('region', { name: 'Eva saved revision 4 while you edited' })
  await conflict.getByRole('button', { name: 'Save this result' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 5.' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Retention, by Eric' })).toBeVisible()
  await expect(page.locator('.prose')).toContainText('Eva rewrote the body.')
})

// Walk of PR19: from the body, Ctrl+Enter (⌘ Enter) saves without walking past every source field; the
// page being edited is not offered as a link to itself.
test('the body saves with Ctrl+Enter, and never suggests the page itself', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/pages/audience/retention?view=edit')
  const body = page.getByLabel('Body', { exact: true })
  await expect(body).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  await body.fill('Kept short. [[audience/')
  const list = page.getByRole('listbox', { name: 'Pages to link' })
  await expect(list.getByRole('option', { name: /audience\/intros/ })).toBeVisible()
  await expect(list.getByRole('option', { name: /audience\/retention/ })).toHaveCount(0)
  await body.press('Escape')
  await body.fill('Kept short.')
  await body.press('Control+Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 4.' })).toBeVisible()
})
