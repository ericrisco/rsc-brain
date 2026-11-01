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

// The final review of B6: the web's own edits are not «sessions active now» (they show in the feed); a
// session a key got by writing without opening one is «Unnamed work · <client>» everywhere.
test('Activity lists agents’ sessions only; the web’s edits are not among them', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/activity')
  const sessions = page.locator('.act-sessions')
  await expect(sessions.getByRole('link', { name: 'Narrate the outro of video 42' })).toBeVisible()
  await expect(sessions).not.toContainText('Web edits')
  await expect(sessions).not.toContainText('Work without a session')
  await page.goto('/b/growth/journal')
  await expect(
    page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: 'Web edits · Eric' }),
  ).toBeVisible()
  await page.goto('/b/growth')
  await expect(
    page
      .getByRole('region', { name: "Today's sessions" })
      .getByRole('link', { name: 'Unnamed work · an API client' }),
  ).toBeVisible()
})

// The final review of B6 (CA4 on a proposal too): a change's source opens beside the proposal, named by its
// entry's title, and the proposal stays; Escape closes it and the keyboard returns.
test('a source of a proposed change opens beside the proposal, by its title, without leaving it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/proposals/prp_growth1')
  const source = page.getByRole('button', { name: 'The hook goes first' }).first()
  await expect(source).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('ent_fx_hooks')
  await source.click()
  await expect(page.getByRole('dialog', { name: 'The hook goes first' })).toBeVisible()
  await expect(page).toHaveURL(/\/proposals\/prp_growth1$/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(source).toBeFocused()
})

// The final review of B6: what waits for review is a link wherever it is said.
test('«N proposals to review» on a brain card opens that brain’s inbox', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await page.locator('.cards').getByRole('link', { name: '3 proposals to review' }).click()
  await expect(page).toHaveURL(/\/b\/growth\/proposals$/)
})

// The final review of B6: where only curators or the administration may go, the page names whom to ask, as
// the inbox does for a reader.
test('Settings and Admin name whom to ask', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/admin/people')
  await expect(page.getByRole('alert')).toContainText('Ask an administrator (Eric)')
  await page.goto('/b/support/settings')
  await expect(page.getByRole('alert')).toContainText(/Ask a curator of Support \(.+\) for the curator role/)
})

// The final review of B6: a tab of the administration puts the keyboard on its own section, and the first
// field is the next Tab, not a walk through the page from «Administration».
test('an administration tab lands on its section heading; its first field is one Tab away', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/admin/people')
  await expect(page.getByRole('heading', { name: 'People in this installation' })).toBeVisible()
  const tabs = page.getByRole('navigation', { name: 'Administration' })
  await tabs.getByRole('link', { name: 'Invitations' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Invite people' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Emails')).toBeFocused()
  await tabs.getByRole('link', { name: 'Service accounts' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'New service account' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused()
  await tabs.getByRole('link', { name: 'People' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'People in this installation' })).toBeFocused()
})

// The final review of B6: a token never says more than its owner may do (B4). Ana reads Support only.
test('a reader cannot pick «Read and write» for a token over brains she only reads', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/profile')
  const roles = await page.evaluate(async () => {
    const r = await fetch('/v1/brains', { headers: { 'x-requested-with': 'rsc-brain-web' } })
    return ((await r.json()) as { brains: Array<{ name: string; role: string }> }).brains
  })
  const read = roles.find((b) => b.role === 'reader')
  test.skip(!read, 'the member reads no brain in this fixture')
  await page.getByRole('button', { name: 'Create a token' }).first().click()
  await page.getByRole('radio', { name: 'Only these brains' }).check()
  await page.getByRole('checkbox', { name: read?.name ?? '' }).check()
  await expect(page.getByRole('radio', { name: 'Read and write' })).toBeDisabled()
  await expect(page.getByRole('radio', { name: 'Read only' })).toBeChecked()
  await expect(page.getByText('you are a reader in these brains')).toBeVisible()
})

// The final review of B6: the live check is shown once, after the steps that connect the agent.
test('«Connect your agent» shows its live check once, after the steps', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await expect(page.getByRole('region', { name: 'Live check' })).toHaveCount(1)
  await expect(page.locator('[data-check-mini]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Create a token' }).click()
  await expect(page.getByRole('button', { name: 'Copy the token' })).toBeVisible()
  await expect(page.locator('[data-check-mini]')).toHaveCount(0)
  const after = await page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]') as Element
    const check = document.querySelector('.live-check') as Element
    return Boolean(panel.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(after, 'the check comes after the steps').toBe(true)
})

// The final review of B6: after an edit conflict the page's header says the revision now on the server.
test('after an edit conflict, the header shows the newer revision', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/pages/audience/retention?view=edit')
  const meta = page.locator('.page-meta')
  await expect(meta).toContainText('Revision 3')
  await page.getByLabel('Body', { exact: true }).fill('Mine.')
  await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain: 'growth', address: 'audience/retention', body: 'Theirs.' }),
  })
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('region', { name: 'Eva saved revision 4 while you edited' })).toBeVisible()
  await expect(meta).toContainText('Revision 4')
})

// The final review of B6: each card's «Edit» has its own name.
test('the «Edit» of each proposed change is named by its change', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/proposals/prp_growth1')
  await expect(page.getByRole('button', { name: 'Edit change 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit change 2', exact: true })).toBeVisible()
})

// The final review of B6: in the `[[` list, the first ArrowDown chooses the first page (it was chosen at
// once, for Enter; the arrow does not skip it).
test('in the `[[` list the first ArrowDown stays on the first page', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/pages/audience/retention?view=edit')
  const body = page.getByLabel('Body', { exact: true })
  await body.fill('See [[aud')
  const list = page.getByRole('listbox', { name: 'Pages to link' })
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await body.press('ArrowDown')
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await body.press('ArrowDown')
  await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
})

// Review of PR26 (second pass): a web-edit session has the same name on the journal, on an entry's page
// and beside the entry in a list (its reference carries its client and its author).
test('a session of web edits has one name: the journal, the entry page and the conflicts list', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal')
  await expect(
    page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: 'Web edits · Eric' }),
  ).toBeVisible()
  await page.goto('/b/growth/journal/entries/ent_fx_corr')
  await expect(page.getByRole('main').getByRole('link', { name: 'Web edits · Eric' }).first()).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('Unnamed work · an agent')
  await page.goto('/b/growth/journal/conflicts')
  await expect(page.getByRole('main')).not.toContainText('Unnamed work · an agent')
})

// Review of PR26 (second pass): a proposal names its source entries from its review; looking at it opens
// none of them (opening an entry is a read, in the trail and the live events). Opening one still does.
test('a proposal names its sources without opening them', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  const opened: string[] = []
  page.on('request', (r) => {
    if (/\/v1\/entries\/[^/?]+/.test(new URL(r.url()).pathname)) opened.push(r.url())
  })
  await page.goto('/b/growth/proposals/prp_growth1')
  const source = page.getByRole('button', { name: 'The hook goes first', exact: true })
  await expect(source).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(opened).toEqual([])
  await source.click()
  await expect.poll(() => opened.length).toBeGreaterThan(0)
})

// Review of PR26 (second pass): Activity asks the server for agents' and services' sessions only, so the
// page it gets and the count beside it are those (filtering in the browser after paging could show none).
test('Activity asks the server for the sessions of agents only', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  const asked: URL[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === '/v1/brains/growth/sessions') asked.push(u)
  })
  await page.goto('/b/growth/activity')
  await expect(
    page.locator('.act-sessions').getByRole('link', { name: 'Narrate the outro of video 42' }),
  ).toBeVisible()
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.every((u) => u.searchParams.get('agents') === '1')).toBe(true)
})

// Review of PR26 (second pass): «Read and write» comes back by itself when the scope again takes a brain
// the person writes in, if it was the form that set «Read only» (never over the person's own choice).
test('the token form gives «Read and write» back when a brain she writes in joins the scope', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/profile')
  const roles = await page.evaluate(async () => {
    const r = await fetch('/v1/brains', { headers: { 'x-requested-with': 'rsc-brain-web' } })
    return ((await r.json()) as { brains: Array<{ name: string; role: string }> }).brains
  })
  const read = roles.find((b) => b.role === 'reader')
  const write = roles.find((b) => b.role !== 'reader')
  test.skip(!read || !write, 'the member needs a brain she reads and one she writes in')
  await page.getByRole('button', { name: 'Create a token' }).first().click()
  const both = page.getByRole('radio', { name: 'Read and write' })
  const only = page.getByRole('radio', { name: 'Read only' })
  await expect(both).toBeChecked()
  await page.getByRole('radio', { name: 'Only these brains' }).check()
  await page.getByRole('checkbox', { name: read?.name ?? '' }).check()
  await expect(only).toBeChecked()
  await page.getByRole('checkbox', { name: write?.name ?? '' }).check()
  await expect(both).toBeChecked()
  // Her own «Read only» stays when the scope changes.
  await only.check()
  await page.getByRole('checkbox', { name: write?.name ?? '' }).uncheck()
  await page.getByRole('checkbox', { name: write?.name ?? '' }).check()
  await expect(only).toBeChecked()
})
