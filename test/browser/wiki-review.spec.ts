// Review of PR19 (spec B6 «Wiki», CA10, CA20): what a person met using the wiki. One «Save changes» for
// every part of a page; Enter in a source field adds the source; a source found by its words; every page
// on the map whatever its status; saving over someone else's revision shows the result first and keeps
// both when it can; who read a page, grouped, and one visit is one read; history by part and by line;
// drafts that never outlive the session. Against the fixture API.
import type { BrowserContext, Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const RETENTION = '/b/growth/pages/audience/retention'
const EDIT = `${RETENTION}?view=edit`
const body = (page: Page) => page.getByLabel('Body', { exact: true })
const said = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

async function behind(baseURL: string, id: string, change: Record<string, unknown>) {
  await fetch(`${baseURL}/__fixture/scenarios/${id}/wiki-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain: 'growth', address: 'audience/retention', ...change }),
  })
}
const drafts = (page: Page) =>
  page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('rscb.draft.')))

test.describe('drafts of an edit', () => {
  test('signing out forgets them: signing in again shows the page as it is', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Title', { exact: true }).fill('Retention, private draft')
    expect(await drafts(page)).toHaveLength(1)
    await page.getByRole('button', { name: /Account/ }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/sign-in$/)
    expect(await drafts(page)).toEqual([])
  })

  test('a session that ends forgets them too', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Title', { exact: true }).fill('Retention, private draft')
    await s.endSessions()
    await page.getByRole('link', { name: 'Back to the page' }).click()
    await expect(page).toHaveURL(/\/sign-in/)
    expect(await drafts(page)).toEqual([])
  })

  test('a draft belongs to its page: another page does not show it', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Title', { exact: true }).fill('Retention, mine')
    await page.goto('/b/growth/pages/audience/intros?view=edit')
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Writing intros')
    await expect(page.getByText('Your unsaved changes in this tab are back.')).toHaveCount(0)
  })
})

test.describe('sources in the editor', () => {
  test('B1: Enter in a source field adds the source and never saves the page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const sources = page.getByRole('group', { name: 'Sources' })
    await sources.getByLabel('Or a link').fill('https://example.test/notes')
    await sources.getByLabel('Or a link').press('Enter')
    await expect(
      sources.getByRole('listitem').filter({ hasText: 'https://example.test/notes' }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\?view=edit$/)
    await expect(said(page, /Saved as revision/)).toHaveCount(0)
    await sources.getByLabel('Journal entry').fill('ent_fx_hooks')
    await sources.getByLabel('Journal entry').press('Enter')
    await expect(sources.getByRole('listitem').filter({ hasText: 'The hook goes first' })).toBeVisible()
    await expect(page).toHaveURL(/\?view=edit$/)
  })

  test('M2: an entry is found by its words, keyboard only, and shown by its title and date', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const sources = page.getByRole('group', { name: 'Sources' })
    // The sources the page has are named by their titles, not their ids.
    await expect(sources.getByRole('listitem').filter({ hasText: 'Short intros keep viewers' })).toBeVisible()
    await sources.getByRole('button', { name: 'Remove The hook goes first' }).click()
    const field = sources.getByLabel('Journal entry')
    await field.fill('greeting')
    const list = page.getByRole('listbox', { name: 'Journal entries' })
    const option = list.getByRole('option', { name: /The hook goes first/ })
    await expect(option).toBeVisible()
    await expect(option).toContainText('Oct')
    await expect(option).toHaveAttribute('aria-selected', 'true')
    await field.press('Enter')
    await expect(sources.getByRole('listitem').filter({ hasText: 'The hook goes first' })).toBeVisible()
    await expect(field).toHaveValue('')
    await expect(page).toHaveURL(/\?view=edit$/)
  })
})

test.describe('one Save for the whole page (M1)', () => {
  test('a status chosen, then ⌘ Enter in the body: saved with the rest', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Status', { exact: true }).selectOption('stale')
    await body(page).fill('Kept short.')
    await body(page).press('ControlOrMeta+Enter')
    await expect(page).toHaveURL(new RegExp(`${RETENTION}$`))
    await expect(said(page, 'Saved as revision 5. The page is stale now.')).toBeVisible()
    await expect(page.locator('.page-meta')).toContainText('Stale')
    await expect(page.locator('.prose')).toContainText('Kept short.')
  })

  test('only a status, ⌘ Enter from its own field', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const status = page.getByLabel('Status', { exact: true })
    await status.selectOption('retired')
    await status.press('ControlOrMeta+Enter')
    await expect(said(page, 'Saved as revision 4. The page is retired now.')).toBeVisible()
  })

  test('leaving with a status not saved: the page says so, and the edit still has it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Status', { exact: true }).selectOption('stale')
    await expect(page.getByText('Not saved yet')).toBeVisible()
    await page.getByRole('link', { name: 'Back to the page' }).click()
    await expect(
      page.getByRole('note').filter({ hasText: 'Your changes to this page are not saved yet.' }),
    ).toBeVisible()
    await expect(page.locator('.page-meta')).toContainText('Current')
    await page.getByRole('link', { name: 'Go back to the edit' }).click()
    await expect(page.getByLabel('Status', { exact: true })).toHaveValue('stale')
  })

  test('choosing the status the page has is no change', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const status = page.getByLabel('Status', { exact: true })
    await status.selectOption('stale')
    await status.selectOption('current')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(said(page, 'Nothing changed: there is nothing to save.')).toBeVisible()
  })

  test('content, status and address in one Save; the old address still leads there', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Summary').fill('Still what keeps viewers.')
    await page.getByLabel('Status', { exact: true }).selectOption('stale')
    await page.getByLabel('Address', { exact: true }).fill('audience/what-keeps-viewers')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(/\/pages\/audience\/what-keeps-viewers$/)
    await expect(
      said(
        page,
        'Saved as revision 6. The page is stale now. The page lives at audience/what-keeps-viewers now',
      ),
    ).toBeVisible()
  })
})

// A second person (the same curator in another browser) saves the page meanwhile.
async function other(context: BrowserContext, baseURL: string, id: string) {
  const b = context.browser()
  if (!b) throw new Error('no browser')
  const c = await b.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
  await c.setExtraHTTPHeaders({ 'x-fixture-scenario': id })
  await c.addCookies([
    { name: 'rscb_session', value: 'fx.acc_eric', url: baseURL, httpOnly: true, sameSite: 'Lax' },
  ])
  return c
}

test.describe('saving over a newer revision (M4, CA10)', () => {
  test('both added a paragraph: the result keeps both and is shown before saving', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    const c2 = await other(context, baseURL as string, s.id)
    const p2 = await c2.newPage()
    await page.goto(EDIT)
    await p2.goto(EDIT)
    const start = await body(page).inputValue()
    await body(p2).fill(`${start}\n\nTheirs: hooks matter.`)
    await p2.getByRole('button', { name: 'Save changes' }).click()
    await expect(said(p2, 'Saved as revision 4.')).toBeVisible()
    await body(page).fill(`${start}\n\nMine: thumbnails matter.`)
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: 'Eric saved revision 4 while you edited' })
    await expect(conflict).toBeVisible()
    await expect(conflict.getByRole('radio', { name: 'Keep both' })).toBeChecked()
    const result = conflict.locator('[data-part="result-body"]')
    await expect(result).toContainText('Theirs: hooks matter.')
    await expect(result).toContainText('Mine: thumbnails matter.')
    await conflict.getByRole('button', { name: 'Save this result' }).click()
    await expect(said(page, 'Saved as revision 5.')).toBeVisible()
    await expect(page.locator('.prose')).toContainText('Theirs: hooks matter.')
    await expect(page.locator('.prose')).toContainText('Mine: thumbnails matter.')
    await c2.close()
  })

  test('names who saved; the same line changed two ways asks which to keep', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await body(page).fill('Mine, all of it.')
    await behind(baseURL as string, s.id, { body: 'Eva says: intros of 5 seconds.' })
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: 'Eva saved revision 4 while you edited' })
    await expect(conflict).toContainText('It is at revision 4 now.')
    await expect(conflict.getByRole('radio', { name: 'Keep both' })).toHaveCount(0)
    const save = conflict.getByRole('button', { name: 'Save this result' })
    await expect(save).toHaveAttribute('aria-disabled', 'true')
    await conflict.getByRole('radio', { name: 'Keep theirs' }).check()
    await expect(save).not.toHaveAttribute('aria-disabled', 'true')
    await expect(conflict.getByRole('region', { name: 'What will be saved' })).toContainText(
      'Their revision as it is',
    )
    await conflict.getByRole('radio', { name: 'Keep mine' }).check()
    await save.click()
    await expect(said(page, 'Saved as revision 5.')).toBeVisible()
    await expect(page.locator('.prose')).toContainText('Mine, all of it.')
  })

  test('C2: their tags are shown and kept when I changed the body', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Tags').fill('metric, q4, mine')
    await behind(baseURL as string, s.id, { tags: ['metric', 'q4', 'theirs'] })
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: /saved revision 4 while you edited/ })
    const theirs = conflict.getByRole('region', { name: 'What Eva changed' })
    await expect(theirs.locator('ins').filter({ hasText: 'theirs' })).toBeVisible()
    await conflict.getByRole('button', { name: 'Save this result' }).click()
    await expect(page.locator('.page-main .tags')).toContainText('theirs')
    await expect(page.locator('.page-main .tags')).toContainText('mine')
  })
})

test.describe('a conflict on a long body (CA6)', () => {
  test('choosing a version does not work the conflict out again: no click blocks the page', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    let seed = 11
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const text = () =>
      Array.from({ length: 6000 }, () => ['- a', '- b', '', '- c'][Math.floor(rnd() * 4)]).join('\n')
    // Typing thousands of lines key by key takes the test runner minutes: the text is put in at once.
    const put = (v: string) =>
      body(page).evaluate((el: HTMLTextAreaElement, v) => {
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, v)
    // The page holds 6000 short lines; both sides rewrite all of them.
    await page.goto(EDIT)
    await put(text())
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(said(page, 'Saved as revision 4.')).toBeVisible()
    await page.goto(EDIT)
    await put(text())
    await behind(baseURL as string, s.id, { body: text() })
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: /saved revision 5 while you edited/ })
    await expect(conflict).toBeVisible()
    // The conflict is worked out once (a performance measure each time), well under 200 ms.
    const worked = () =>
      page.evaluate(() => performance.getEntriesByName('wiki: conflict worked out').map((e) => e.duration))
    await expect.poll(async () => (await worked()).length).toBeGreaterThan(0)
    const first = await worked()
    for (const c of ['Keep mine', 'Keep theirs', 'Keep mine', 'Keep theirs']) {
      await conflict.getByRole('radio', { name: c }).check()
      await expect(conflict.getByRole('radio', { name: c })).toBeChecked()
    }
    const after = await worked()
    expect(after, 'choosing a version works nothing out again').toEqual(first)
    for (const ms of after) expect(ms, 'the conflict, in ms').toBeLessThan(200)
  })
})

test.describe('a save that is partly refused', () => {
  test('says what was not saved and why; a second Save sends only what is left', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    // The server keeps the content redacted: what it saved is not what was typed.
    await page.route('**/v1/brains/growth/**', async (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      const r = await route.fetch()
      const text = (await r.text()).replaceAll('Partial summary.', 'Partial [redacted].')
      await route.fulfill({ response: r, body: text })
    })
    const sent: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/v1/brains/'))
        sent.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ''}`)
    })
    await page.goto(EDIT)
    await page.getByLabel('Summary').fill('Partial summary.')
    await page.getByLabel('Status', { exact: true }).selectOption('stale')
    await page.getByLabel('Address', { exact: true }).fill('audience/intros')
    await page.getByRole('button', { name: 'Save changes' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText(
      'The move was not saved: the address "audience/intros" is taken or reserved by another page. Your other changes are saved as revision 5.',
    )
    await expect(page.getByText(/nothing was saved/i)).toHaveCount(0)
    await expect(page.getByText(/Part of it was saved/)).toHaveCount(0)
    await expect(page.getByLabel('Summary')).toHaveValue('Partial [redacted].')
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue('audience/intros')
    expect(sent).toHaveLength(3)
    sent.length = 0
    await page.getByLabel('Address', { exact: true }).fill('audience/free-one')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(said(page, 'Saved as revision 6.')).toBeVisible()
    await expect(page).toHaveURL(/\/b\/growth\/pages\/audience\/free-one$/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^POST \/v1\/brains\/growth\/wiki\/changes /)
    expect(JSON.parse((sent[0] as string).split(' ').slice(2).join(' '))).toMatchObject({
      op: 'move',
      address: 'audience/retention',
      to: 'audience/free-one',
    })
  })
})

test.describe('the map (M3)', () => {
  test('every page whatever its status, with its status in words; a status filter, all by default', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/wiki')
    const status = page.getByLabel('Status')
    await expect(status).toHaveValue('')
    await expect(status.locator('option:checked')).toHaveText('All statuses')
    const weekly = page.getByRole('listitem').filter({ hasText: 'Weekly review' })
    await expect(weekly.locator('.tag')).toHaveText('Stale')
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Consent in 2024' }).locator('.tag'),
    ).toHaveText('Retired')
    await status.selectOption('stale')
    await expect(page).toHaveURL(/status=stale/)
    await expect(page.getByRole('link', { name: 'Weekly review' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Retention' })).toHaveCount(0)
    await status.selectOption('')
    await page.getByLabel('Filter by words').fill('consent')
    await expect(page.getByRole('link', { name: 'Consent in 2024' })).toBeVisible()
  })

  test('no tag in the wiki: no tag filter', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.route('**/v1/brains/growth/wiki/map*', async (route) => {
      const r = await route.fetch()
      const j = (await r.json()) as { groups: { pages: { tags: string[] }[] }[] }
      for (const g of j.groups) for (const p of g.pages) p.tags = []
      await route.fulfill({ response: r, json: j })
    })
    await page.goto('/b/growth/wiki')
    await expect(page.getByLabel('Type')).toBeVisible()
    await expect(page.getByLabel('Tag', { exact: true })).toHaveCount(0)
  })
})

test.describe('a page', () => {
  test('M5: who read it, one line a person or agent, with how many times and when last', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    const readers = page.getByRole('region', { name: 'Who read this' })
    await expect(readers.getByRole('listitem')).toHaveCount(3)
    await expect(readers.getByRole('listitem').filter({ hasText: 'Ana' })).toContainText('with Claude Code')
    await expect(readers.getByRole('listitem').filter({ hasText: 'Ana' })).toContainText('2 times')
  })

  test('M5: one visit asks for the page once (one read)', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    const asked: string[] = []
    page.on('request', (r) => {
      if (/\/v1\/brains\/growth\/pages\/audience\/retention/.test(r.url())) asked.push(r.url())
    })
    await page.goto(RETENTION)
    await expect(page.getByRole('region', { name: 'Recent changes' }).getByRole('listitem')).toHaveCount(3)
    await expect(page.getByRole('region', { name: 'Who read this' }).getByRole('listitem')).toHaveCount(3)
    await page.waitForTimeout(300)
    expect(asked).toHaveLength(1)
  })

  test('[[links]] show the title of their page, the address on hover; a stale page says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/audience/intros')
    const prose = page.locator('.prose')
    await expect(prose.getByRole('link', { name: 'Retention' })).toHaveAttribute(
      'title',
      'audience/retention',
    )
    await expect(prose.getByRole('link', { name: 'Weekly review (stale)' })).toBeVisible()
    const out = page.getByRole('group', { name: 'From this page' })
    await expect(out.getByRole('listitem').filter({ hasText: 'Weekly review' })).toContainText('stale')
  })

  test('N2: a source opened and closed leaves no extra step: Back leaves the page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/wiki')
    await page.getByRole('link', { name: 'Retention' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await page.getByRole('button', { name: 'Short intros keep viewers' }).click()
    await expect(page).toHaveURL(/\?source=ent_fx_intros$/)
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(page).toHaveURL(new RegExp(`${RETENTION}$`))
    await page.goBack()
    await expect(page).toHaveURL(/\/b\/growth\/wiki$/)
  })
})

test.describe('history (M6 and the kinds of change)', () => {
  test('each revision says what it changed and why', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await page.getByLabel('Status', { exact: true }).selectOption('stale')
    await page.getByLabel('Why (shown in the log)').fill('The numbers are from October.')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(said(page, /Saved as revision 4/)).toBeVisible()
    await page.goto(`${RETENTION}?view=history`)
    const revisions = page.getByRole('region', { name: 'Revisions' })
    const four = revisions.getByRole('listitem').filter({ hasText: 'Revision 4' })
    await expect(four).toContainText('Revision 4 · status → stale by Eric')
    await expect(four).toContainText('Why: The numbers are from October.')
    await expect(revisions.getByRole('listitem').filter({ hasText: 'Revision 1' })).toContainText(
      'Revision 1 · created by Eric',
    )
    await page.goto('/b/growth/wiki/log')
    const line = page.getByRole('list', { name: 'Changes' }).getByRole('listitem').first()
    await expect(line).toContainText('Direct status → stale: audience/retention')
    await expect(line).toContainText('Why: The numbers are from October.')
    // The status part of the difference, on its own.
    await page.goto(`${RETENTION}?view=history&compare=3,4`)
    const diff = page.getByRole('region', { name: 'Changes from revision 3 to 4' })
    const status = diff.locator('.diff-part').filter({ has: page.getByRole('heading', { name: 'Status' }) })
    await expect(status.locator('del')).toContainText('Current')
    await expect(status.locator('ins')).toContainText('Stale')
  })

  test('a sentence rewritten shows the old line and the new line whole', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${RETENTION}?view=history&compare=1,2`)
    const diff = page.getByRole('region', { name: 'Changes from revision 1 to 2' })
    await expect(diff.locator('del').filter({ hasText: 'Long intros lose viewers.' })).toHaveCount(1)
    await expect(
      diff.locator('ins').filter({
        hasText:
          'Intros under ten seconds keep viewers past the first minute. Long intros lose a third of them before the hook.',
      }),
    ).toHaveCount(1)
  })
})

test.describe('the [[ of the body', () => {
  test('the first page found is chosen: Enter takes it', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    await body(page).fill('See [[pric')
    const option = page.getByRole('listbox', { name: 'Pages to link' }).getByRole('option').first()
    await expect(option).toHaveAttribute('aria-selected', 'true')
    await body(page).press('Enter')
    await expect(body(page)).toHaveValue('See [[product/pricing]]')
  })

  test('C3: completing inside a link already there replaces it whole', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(EDIT)
    const field = body(page)
    await field.fill('See [[audience/intros]] now.')
    await field.focus()
    await field.evaluate((el: HTMLTextAreaElement) => {
      const at = el.value.indexOf('aud') + 3
      el.setSelectionRange(at, at)
      el.dispatchEvent(new Event('click'))
    })
    const list = page.getByRole('listbox', { name: 'Pages to link' })
    await list.getByRole('option', { name: /audience\/intros/ }).click()
    await expect(field).toHaveValue('See [[audience/intros]] now.')
  })

  test('an answer to an older question never replaces the newer one', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.route('**/v1/brains/growth/wiki/pages?q=pro*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('q') !== 'pro') return route.fallback()
      await new Promise((r) => setTimeout(r, 900))
      await route.fulfill({
        json: { items: [{ address: 'zzz/late', title: 'Late', status: 'current' }], next: null, total: 1 },
      })
    })
    await page.goto(EDIT)
    await body(page).fill('[[pro')
    await page.waitForTimeout(250)
    await body(page).fill('[[product/m')
    const list = page.getByRole('listbox', { name: 'Pages to link' })
    await expect(list.getByRole('option', { name: /product\/monthly-only/ })).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(list.getByRole('option', { name: /zzz\/late/ })).toHaveCount(0)
  })

  test('keeps the first page chosen when an answer to an older question arrives late', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    let late = () => {}
    const arrived = new Promise<void>((r) => {
      late = r
    })
    await page.route('**/v1/brains/growth/wiki/pages?q=pro*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('q') !== 'pro') return route.fallback()
      await new Promise((r) => setTimeout(r, 900))
      await route.fulfill({
        json: { items: [{ address: 'zzz/late', title: 'Late', status: 'current' }], next: null, total: 1 },
      })
      late()
    })
    await page.goto(EDIT)
    await body(page).fill('[[pro')
    await page.waitForTimeout(250)
    await body(page).fill('[[product/m')
    const first = page.getByRole('listbox', { name: 'Pages to link' }).getByRole('option').first()
    await expect(first).toContainText('product/monthly-only')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await arrived
    await page.waitForTimeout(100)
    await expect(first).toContainText('product/monthly-only')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await body(page).press('Enter')
    await expect(body(page)).toHaveValue('[[product/monthly-only]]')
  })
})

test.describe('the log', () => {
  test('N1: «Show more» for an old filter does not add its lines under a new one', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { log: 'much-data' })
    let slow = true
    await page.route('**/v1/brains/growth/wiki/log?*cursor=*', async (route) => {
      if (slow) await new Promise((r) => setTimeout(r, 800))
      await route.fallback()
    })
    await page.goto('/b/growth/wiki/log')
    const list = page.getByRole('list', { name: 'Changes' })
    await expect(list.getByRole('listitem')).toHaveCount(50)
    await page.getByRole('button', { name: 'Show more' }).click()
    await page.getByLabel('Kind of change').selectOption('direct')
    slow = false
    await page.waitForTimeout(1200)
    await expect(list.getByRole('listitem').filter({ hasText: 'Approved:' })).toHaveCount(0)
  })
})

test.describe('search', () => {
  test('a result shows plain text, not markdown', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await page
      .getByRole('button', { name: /Search/ })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: 'Search' })
    await dialog.getByLabel('Search for').fill('retention')
    await dialog.getByLabel('Search for').press('Enter')
    const snippet = dialog.locator('.snippet').first()
    await expect(snippet).toContainText('What keeps viewers')
    await expect(snippet).not.toContainText('##')
    await expect(snippet).not.toContainText('[[')
  })
})

test.describe('shortcuts (CA20)', () => {
  test('e edits the page, g d goes to the decisions, g l to the log; ? lists them', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(RETENTION)
    await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    for (const id of ['edit', 'go-decisions', 'go-log'])
      await expect(help.locator(`[data-shortcut="${id}"]`)).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('e')
    await expect(page).toHaveURL(/\?view=edit$/)
    await page.locator('main h1').focus()
    await page.keyboard.press('g')
    await page.keyboard.press('d')
    await expect(page).toHaveURL(/\/wiki\/decisions$/)
    await page.keyboard.press('g')
    await page.keyboard.press('l')
    await expect(page).toHaveURL(/\/wiki\/log$/)
  })
})

// The design gate of the changed screens at the three widths the web is checked at: nothing scrolls
// sideways, and the editor, its conflict with both versions and the result, the map and the history fit.
for (const width of [1440, 768, 390]) {
  test(`at ${width} px the editor, a conflict, the map and the history fit`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width, height: 900 })
    await page.goto(EDIT)
    await expect(body(page)).toBeVisible()
    await noSideScroll(page)
    await body(page).fill(
      'Mine, all of it, a long line that has to wrap at the narrow width of a phone screen.',
    )
    await page.getByLabel('Title', { exact: true }).fill('Retention, mine')
    await behind(baseURL as string, s.id, { body: 'Theirs, all of it.', tags: ['metric', 'theirs'] })
    await page.getByRole('button', { name: 'Save changes' }).click()
    const conflict = page.getByRole('region', { name: /saved revision 4 while you edited/ })
    await conflict.getByRole('radio', { name: 'Keep mine' }).check()
    await expect(conflict.locator('[data-part="result-body"]')).toBeVisible()
    await noSideScroll(page)
    await page.screenshot({ path: test.info().outputPath(`conflict-${width}.png`), fullPage: true })
    await page.goto('/b/growth/wiki')
    await expect(page.getByLabel('Status')).toBeVisible()
    await noSideScroll(page)
    await page.goto(`${RETENTION}?view=history&compare=1,3`)
    await expect(page.getByRole('region', { name: 'Changes from revision 1 to 3' })).toBeVisible()
    await noSideScroll(page)
  })
}
