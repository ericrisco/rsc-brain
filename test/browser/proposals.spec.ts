// The proposals inbox in a real browser, against the fixture API (spec B6 «Proposals: la bandeja»; T026–T028):
// the list by status with «old»; a reader's read-only inbox with whom to ask (CA17); the detail with a card
// per change, the changes that go together and why, and an old base in three versions; approving all,
// part with a comment (CA2) and returning (CA2b) at 375 px; the keyboard all the way (CA3) with `a` and `r`,
// which never fire while typing; a proposal changed or decided meanwhile (409 keeps the person's choices;
// «approved by X just now» from the live feed); the top-bar counter and the overview lead to the inbox;
// every state of the screens.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const INBOX = '/b/growth/proposals'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

async function behind(
  baseURL: string,
  id: string,
  what: 'decided' | 'changed',
  body: Record<string, unknown>,
) {
  await fetch(`${baseURL}/__fixture/scenarios/${id}/proposal-${what}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// The keyboard leaves any field (a heading opened by a link is not focusable on a first load).
const away = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

const card = (page: Page, n: number) => page.getByRole('article', { name: new RegExp(`^Change ${n}:`) })

test.describe('the list', () => {
  test('the side bar, the top bar and the overview lead to it; pending first, the old ones marked', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    // The counter of the top bar is back, and leads to the inbox of the one brain waiting for me.
    const counter = page.getByRole('banner').getByRole('link', { name: '3 proposals to review' })
    await expect(counter).toBeVisible()
    await counter.click()
    await expect(page).toHaveURL(new RegExp(`${INBOX}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Proposals' })).toBeFocused()
    await expect(page).toHaveTitle(/^Proposals · /)
    await expect(page.locator('aside').getByRole('link', { name: /Proposals/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    const items = page.getByRole('list', { name: 'Pending proposals' }).getByRole('listitem')
    await expect(items).toHaveCount(3)
    // Oldest first: what has waited longest is reviewed first.
    await expect(items.first()).toContainText('New page: hooks that work')
    const old = items.filter({ hasText: 'New page: hooks that work' })
    await expect(old).toContainText('old')
    await expect(old).toContainText('RSC Factory')
    await expect(items.filter({ hasText: 'Intros: keep them under 10 seconds' })).toContainText('3 changes')
    await audit(page, 'inbox')
    // The other statuses, each a tab with its count, kept in the address.
    const tabs = page.getByRole('navigation', { name: 'Proposals by status' })
    await tabs.getByRole('link', { name: /Partly approved/ }).click()
    await expect(page).toHaveURL(/status=partially_approved/)
    const part = page.getByRole('list', { name: 'Partly approved proposals' }).getByRole('listitem')
    await expect(part).toHaveCount(1)
    await expect(part).toContainText('Partly approved by Eric')
    await tabs.getByRole('link', { name: /Replaced/ }).click()
    await expect(page.getByRole('list', { name: 'Replaced proposals' })).toContainText('New page: hooks')
    await page.goto('/b/growth')
    await page.getByRole('link', { name: /3 waiting for review/ }).click()
    await expect(page).toHaveURL(new RegExp(`${INBOX}$`))
  })

  test('CA17: a reader sees it read-only, with whom to ask for the curator role', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/b/support/proposals')
    await expect(page.getByRole('heading', { level: 1, name: 'Proposals' })).toBeVisible()
    await expect(page.getByText('ask a curator of Support (Eric) for the curator role')).toBeVisible()
    await page.getByRole('link', { name: 'Refunds: answer within a day' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Refunds: answer within a day' })).toBeVisible()
    await expect(card(page, 1)).toContainText('New page support/refunds')
    await expect(page.getByText('ask a curator of Support (Eric) for the curator role')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve all' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Return' })).toHaveCount(0)
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    // `a` does nothing where there is nothing to approve.
    await page.keyboard.press('a')
    await expect(page).toHaveURL(/prp_support1$/)
    await audit(page, 'reader proposal')
  })

  test('every state: loading, empty, error, and much data by pages', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { proposals: 'loading' })
    await page.goto(INBOX)
    await expect(page.locator('[data-state="loading"]').first()).toBeVisible()
    await s.state('proposals', 'empty')
    await page.goto(INBOX)
    await expect(page.getByRole('heading', { name: 'Nothing waits for review' })).toBeVisible()
    await s.state('proposals', 'error')
    await page.goto(INBOX)
    await expect(page.locator('[data-state="error"]')).toBeVisible()
    await s.state('proposals', 'much-data')
    await page.goto(INBOX)
    const items = page.getByRole('list', { name: 'Pending proposals' }).getByRole('listitem')
    await expect(items).toHaveCount(20)
    await page.getByRole('button', { name: 'Show more' }).click()
    await expect(items).toHaveCount(40)
    await s.state('proposal', 'error')
    await page.goto(`${INBOX}/prp_growth1`)
    await expect(page.locator('[data-state="error"]')).toBeVisible()
    await s.state('proposal', 'normal')
    await page.goto(`${INBOX}/prp_nope`)
    await expect(page.locator('[data-state="forbidden"]')).toBeVisible()
  })
})

test.describe('a proposal', () => {
  test('a card per change; changes that go together say why; an old base shows three versions', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth2`)
    await expect(page.getByRole('heading', { level: 1, name: 'Merge the two retention pages' })).toBeVisible()
    await expect(page.getByText('Codex of Eric')).toBeVisible()
    const group = page.getByRole('group', { name: 'These go together' })
    await expect(group).toContainText('Change 2 needs change 1.')
    await expect(group.getByRole('article')).toHaveCount(2)
    await expect(card(page, 3)).toContainText('Move people/ana to people/ana-ruiz')
    // Choosing change 2 brings change 1 (it needs it), and says so.
    await page.getByRole('checkbox', { name: 'Approve change 2' }).check()
    await expect(page.getByRole('checkbox', { name: 'Approve change 1' })).toBeChecked()
    await expect(page.getByText('Also chose change 1, which change 2 needs.')).toBeVisible()
    await page.getByRole('checkbox', { name: 'Approve change 1' }).uncheck()
    await expect(page.getByRole('checkbox', { name: 'Approve change 2' })).not.toBeChecked()
    await expect(page.getByText('Also left out change 2, which needs change 1.')).toBeVisible()
    await audit(page, 'proposal with a group')

    await page.goto(`${INBOX}/prp_growth3`)
    const stale = card(page, 1)
    await expect(stale).toContainText('Written on an older version')
    await expect(
      stale.getByRole('heading', { name: /Changed since it was written \(revision 2 → 3\)/ }),
    ).toBeVisible()
    await expect(
      stale.getByRole('heading', { name: /What the proposal changes \(from revision 2\)/ }),
    ).toBeVisible()
    const all = page.getByRole('button', { name: 'Approve all' })
    await expect(all).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByText('Change 1 was written on an older version of its page')).toBeVisible()
    // What the page will be: the colleague's newer lines that approving drops show as removed.
    const will = stale.getByRole('region', { name: 'What the page will be after approval' })
    await expect(will.locator('del').filter({ hasText: 'Cut the greeting.' })).toBeVisible()
    const replace = stale.getByRole('button', { name: 'I’ve checked — replace the newer changes' })
    await replace.click()
    await expect(replace).toHaveAttribute('aria-pressed', 'true')
    await expect(all).not.toHaveAttribute('aria-disabled', 'true')
    await audit(page, 'proposal with an old base')
    await all.click()
    const done = page.getByRole('status').filter({ hasText: 'Approved. These pages changed:' })
    await expect(done).toBeVisible()
    await expect(page.getByRole('link', { name: '← All proposals' })).toHaveAttribute('href', INBOX)
    await expect(done.getByRole('link', { name: 'audience/retention' })).toHaveAttribute(
      'href',
      '/b/growth/pages/audience/retention',
    )
    await expect(page.getByRole('button', { name: 'Approve all' })).toHaveCount(0)
    // On to the next one waiting.
    await done.getByRole('link', { name: 'Next pending proposal →' }).click()
    await expect(page).toHaveURL(/\/proposals\/prp_growth1$/)
  })

  test('CA2: at 375 px a curator approves two changes and returns the third with a comment', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`${INBOX}/prp_growth1`)
    await expect(card(page, 1)).toContainText('Edit audience/intros')
    await noSideScroll(page)
    await page.getByRole('checkbox', { name: 'Approve change 1' }).check()
    await page.getByRole('checkbox', { name: 'Approve change 2' }).check()
    await expect(page.getByText('2 of 3 chosen')).toBeVisible()
    const some = page.getByRole('button', { name: 'Approve selected & return the rest' })
    await expect(some).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByText('Write why the rest goes back, in the comment.')).toBeVisible()
    await page.getByLabel('Comment for the agent').fill('Pricing is not stale yet.')
    const sent = page.waitForRequest((r) => r.url().endsWith('/approve') && r.method() === 'POST')
    await some.click()
    expect((await sent).postDataJSON()).toEqual({
      fingerprint: 'fp_prp_growth1_1',
      approve: [0, 1],
      comment: 'Pricing is not stale yet.',
    })
    const done = page.getByRole('status').filter({ hasText: 'Approved in part' })
    await expect(done).toBeVisible()
    await expect(done.getByRole('link', { name: 'audience/intros' })).toBeVisible()
    await expect(done.getByRole('link', { name: 'audience/hooks' })).toBeVisible()
    await expect(page.getByText('partly approved', { exact: true }).first()).toBeVisible()
    await expect(card(page, 3)).toContainText('returned')
    await noSideScroll(page)
  })

  test('CA2b: at 375 px a curator returns a proposal with a comment; nothing applies', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`${INBOX}/prp_growth2`)
    const back = page.getByRole('button', { name: 'Return', exact: true })
    await expect(back).toHaveAttribute('aria-disabled', 'true')
    await page.getByLabel('Comment for the agent').fill('One page is enough.')
    await back.click()
    await expect(page.getByRole('status').filter({ hasText: 'Returned with your comment' })).toBeVisible()
    await page.goto(`${INBOX}?status=returned`)
    await expect(page.getByRole('list', { name: 'Returned proposals' })).toContainText(
      'Merge the two retention pages',
    )
  })

  test('at 320 px the detail is one column and its actions fit', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto(`${INBOX}/prp_growth3`)
    await expect(card(page, 1)).toContainText('Written on an older version')
    await noSideScroll(page)
    await page.goto(INBOX)
    await expect(page.getByRole('list', { name: 'Pending proposals' })).toBeVisible()
    await noSideScroll(page)
  })

  test('CA3: by keyboard alone, with the focus visible; `a` and `r` never fire while typing', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth2`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // `r` with no comment: the keyboard goes to the comment; typing `a` and `r` there writes them.
    await page.keyboard.press('r')
    const comment = page.getByLabel('Comment for the agent')
    await expect(comment).toBeFocused()
    await page.keyboard.type('a rare case')
    await expect(comment).toHaveValue('a rare case')
    await expect(page.getByRole('heading', { level: 1, name: 'Merge the two retention pages' })).toBeVisible()
    await comment.fill('')
    // On a change's checkbox (it takes no text) `r` is the shortcut: the keyboard goes to the comment.
    await page.getByRole('checkbox', { name: 'Approve change 3' }).focus()
    await page.keyboard.press('r')
    await expect(comment).toBeFocused()
    // With a comment, `r` goes to «Return» and never sends by itself: Enter or a click sends.
    await comment.fill('Not now.')
    await away(page)
    await page.keyboard.press('r')
    const back = page.getByRole('button', { name: 'Return', exact: true })
    await expect(back).toBeFocused()
    await page.waitForTimeout(200)
    await expect(page.getByRole('status').filter({ hasText: 'Returned' })).toHaveCount(0)
    await comment.fill('')
    // Tab reaches the choices and the buttons, each with a visible focus.
    await page.locator('main h1').focus()
    let reached = false
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab')
      const el = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement
        const s = getComputedStyle(a)
        return { text: a.textContent ?? '', outline: s.outlineStyle !== 'none' || s.boxShadow !== 'none' }
      })
      expect(el.outline, `focus is visible on "${el.text}"`).toBe(true)
      reached = el.text === 'Approve all'
    }
    expect(reached).toBe(true)
    // `a` approves: what the visible button does.
    await page.keyboard.press('Escape')
    await page.locator('main h1').focus()
    await page.keyboard.press('a')
    await expect(page.getByRole('status').filter({ hasText: 'Approved. These pages changed:' })).toBeVisible()
  })

  test('a change edited before approving: the request carries the person’s version', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth3`)
    const stale = card(page, 1)
    await stale.getByRole('button', { name: 'Edit', exact: true }).click()
    const text = stale.getByLabel('Text')
    await expect(text).toBeFocused()
    await text.fill('The hook goes first. Short intros keep viewers.')
    await stale.getByRole('button', { name: 'Use my version' }).click()
    await expect(stale).toContainText('edited by you, not sent yet')
    await expect(stale.getByRole('button', { name: 'Edit', exact: true })).toBeFocused()
    // A reload keeps it (the draft is the person's, for this proposal).
    await page.reload()
    await expect(card(page, 1)).toContainText('edited by you, not sent yet')
    const sent = page.waitForRequest((r) => r.url().endsWith('/approve'))
    await page.getByRole('button', { name: 'Approve all' }).click()
    const body = (await sent).postDataJSON() as { corrections: Record<string, unknown> }
    // Only what the person edited, and the revision of the page they saw: never a copy of the page.
    expect(body.corrections['0']).toEqual({
      body: 'The hook goes first. Short intros keep viewers.',
      revision: 3,
      purges: 0,
    })
    await expect(page.getByRole('status').filter({ hasText: 'Approved.' })).toBeVisible()
  })
})

test.describe('others meanwhile', () => {
  test('the proposal changed: nothing applies, the new version shows, the choices and the comment stay', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth1`)
    await page.getByRole('checkbox', { name: 'Approve change 2' }).check()
    await page.getByLabel('Comment for the agent').fill('Only the hooks page.')
    await behind(baseURL as string, s.id, 'changed', { id: 'prp_growth1' })
    await page.getByRole('button', { name: 'Approve selected & return the rest' }).click()
    await expect(page.getByText('The proposal changed while you were looking at it')).toBeVisible()
    await expect(page.getByText('Your edit was written on an older version — check it.')).toHaveCount(0)
    await expect(page.getByText('(revised)')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Approve change 2' })).toBeChecked()
    await expect(page.getByLabel('Comment for the agent')).toHaveValue('Only the hooks page.')
    // Sending again sends the new version's fingerprint.
    const sent = page.waitForRequest((r) => r.url().endsWith('/approve'))
    await page.getByRole('button', { name: 'Approve selected & return the rest' }).click()
    expect(((await sent).postDataJSON() as { fingerprint: string }).fingerprint).toBe('fp_prp_growth1_2')
    await expect(page.getByRole('status').filter({ hasText: 'Approved in part' })).toBeVisible()
  })

  test('another curator decides it: «approved by Eva just now» and the view turns read-only', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth2`)
    await page.getByLabel('Comment for the agent').fill('Kept while Eva decides.')
    await expect(page.getByRole('button', { name: 'Approve all' })).toBeVisible()
    // The live stream is open before another curator decides.
    await page.waitForTimeout(300)
    await behind(baseURL as string, s.id, 'decided', { id: 'prp_growth2', by: 'Eva' })
    await expect(page.getByText('Approved by Eva just now. This proposal is read-only now.')).toBeVisible({
      timeout: 3_000,
    })
    await expect(page.getByText('Your comment was not sent: “Kept while Eva decides.”')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve all' })).toHaveCount(0)
    await expect(page.getByRole('checkbox')).toHaveCount(0)
  })

  test('decided by someone else before the click: the server says who, nothing applies', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    // No live stream: the tab was hidden, so only the server's answer tells.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'EventSource', { value: undefined })
    })
    await page.goto(`${INBOX}/prp_growth2`)
    await page.getByLabel('Comment for the agent').fill('My words for the agent.')
    await behind(baseURL as string, s.id, 'decided', { id: 'prp_growth2', by: 'Eva', status: 'returned' })
    await page.getByRole('button', { name: /^Approve all/ }).click()
    await expect(page.getByText('Your comment was not sent: “My words for the agent.”')).toBeVisible()
    await expect(page.getByText(/Returned by Eva on \d{1,2} \w{3} \d{4}/)).toBeVisible()
    await expect(page.getByText(/T\d\d:\d\d/)).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'brain log' })).toHaveAttribute('href', '/b/growth/wiki/log')
    await expect(page.getByRole('button', { name: 'Approve all' })).toHaveCount(0)
  })
})

test.describe('the review of PR21', () => {
  test('`a` never approves past a choice or a comment: it says why and goes to the buttons', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    let approved = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/approve')) approved += 1
    })
    await page.goto(`${INBOX}/prp_growth1`)
    await page.getByRole('checkbox', { name: 'Approve change 1' }).check()
    // With a choice, «Approve selected» is the main button and «Approve all» says it ignores the choice.
    const some = page.getByRole('button', { name: 'Approve selected & return the rest' })
    await expect(some).toHaveClass(/primary/)
    const all = page.getByRole('button', { name: 'Approve all 3 (ignore my selection)' })
    await expect(all).toHaveClass(/secondary/)
    await away(page)
    await page.keyboard.press('a')
    await expect(page.getByText('You chose some changes: “a” does not approve them all.')).toBeVisible()
    await expect(some).toBeFocused()
    await page.getByRole('checkbox', { name: 'Approve change 1' }).uncheck()
    await page.getByLabel('Comment for the agent').fill('Half of it.')
    await away(page)
    await page.keyboard.press('a')
    await expect(page.getByText('You wrote a comment: “a” does not approve it all.')).toBeVisible()
    await expect(page.getByLabel('Comment for the agent')).toBeFocused()
    expect(approved).toBe(0)
  })

  test('a page that moved on after the review: 409 stale_base reloads, the stale card takes the keyboard', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth1`)
    await page.getByLabel('Comment for the agent').fill('Kept through the reload.')
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brain: 'growth',
        address: 'audience/intros',
        body: 'A colleague’s newer intro.',
      }),
    })
    await page.getByLabel('Comment for the agent').fill('')
    await page.getByRole('button', { name: 'Approve all' }).click()
    const stale = card(page, 1)
    await expect(stale).toContainText('Written on an older version')
    await expect(stale).toBeFocused()
    await expect(
      stale.getByRole('button', { name: 'I’ve checked — replace the newer changes' }),
    ).toBeVisible()
  })

  test('an edit kept through a new version says to check it', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth1`)
    const first = card(page, 2)
    await first.getByRole('button', { name: 'Edit', exact: true }).click()
    await first.getByLabel('Title').fill('Hooks that hold')
    await first.getByRole('button', { name: 'Use my version' }).click()
    await behind(baseURL as string, s.id, 'changed', { id: 'prp_growth1' })
    await page.getByRole('button', { name: 'Approve all' }).click()
    await expect(page.getByText('Your edit was written on an older version — check it.')).toBeVisible()
    await expect(card(page, 2)).toContainText('edited by you, not sent yet')
  })

  test('a blocked button takes the keyboard to what it needs; a new page reads as plain text', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`${INBOX}/prp_growth1`)
    // A person can press a button that says why it is off (Playwright waits for enabled ones: forced).
    await page.getByRole('button', { name: 'Return', exact: true }).click({ force: true })
    await expect(page.getByLabel('Comment for the agent')).toBeFocused()
    const fresh = card(page, 2)
    await expect(fresh.getByText('New page', { exact: true })).toBeVisible()
    await expect(fresh.locator('ins')).toHaveCount(0)
    await expect(fresh).toContainText('Start with the question of the video, before the greeting.')
    // The whole head of a card is the tap target of its choice, 44 px at least.
    const box = await fresh.locator('label.op-head').boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    await fresh.locator('label.op-head').click({ position: { x: (box?.width ?? 100) - 10, y: 10 } })
    await expect(page.getByRole('checkbox', { name: 'Approve change 2' })).toBeChecked()
  })

  test('without a live feed, a decision still updates the counter and the inbox', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript(() => {
      Object.defineProperty(window, 'EventSource', { value: undefined })
    })
    await page.goto(`${INBOX}/prp_growth2`)
    await expect(page.getByRole('banner').getByRole('link', { name: /3 proposals to review/ })).toBeVisible()
    await page.getByRole('button', { name: 'Approve all' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Approved.' })).toBeVisible()
    await expect(page.getByRole('banner').getByRole('link', { name: /2 proposals to review/ })).toBeVisible()
    await page.getByRole('link', { name: '← All proposals' }).click()
    await expect(page.getByRole('list', { name: 'Pending proposals' }).getByRole('listitem')).toHaveCount(2)
  })
})

test('a checkbox outside a proposal still holds single-letter shortcuts back, as before', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal')
  await page.getByText('Filter the sessions').click()
  const box = page.getByRole('checkbox').first()
  await box.focus()
  await page.keyboard.press('g')
  await page.keyboard.press('w')
  await page.waitForTimeout(200)
  await expect(page).toHaveURL(/\/b\/growth\/journal$/)
})

test.describe('the second pass of the PR21 review', () => {
  test('`a` then Enter never approves past a choice: the keyboard lands on «Approve selected», or the comment', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    const sent: Array<Record<string, unknown>> = []
    page.on('request', (r) => {
      if (r.url().endsWith('/approve')) sent.push(r.postDataJSON() as Record<string, unknown>)
    })
    await page.goto(`${INBOX}/prp_growth1`)
    await page.getByRole('checkbox', { name: 'Approve change 1' }).check()
    await page.getByLabel('Comment for the agent').fill('Only the first.')
    await away(page)
    await page.keyboard.press('a')
    await expect(page.getByRole('button', { name: 'Approve selected & return the rest' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Approved in part' })).toBeVisible()
    expect(sent).toEqual([{ fingerprint: 'fp_prp_growth1_1', approve: [0], comment: 'Only the first.' }])
  })

  test('`a` with only a comment goes to the comment; Enter there is a new line, never a decision', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    let sent = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/approve') || r.url().endsWith('/return')) sent += 1
    })
    await page.goto(`${INBOX}/prp_growth2`)
    const comment = page.getByLabel('Comment for the agent')
    await comment.fill('Not sure yet.')
    await away(page)
    await page.keyboard.press('a')
    await expect(comment).toBeFocused()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    expect(sent).toBe(0)
  })

  test('withdrawn by its author meanwhile: the screen says so and the comment stays', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript(() => {
      Object.defineProperty(window, 'EventSource', { value: undefined })
    })
    await page.goto(`${INBOX}/prp_growth2`)
    await page.getByLabel('Comment for the agent').fill('Words kept.')
    await behind(baseURL as string, s.id, 'decided', { id: 'prp_growth2', status: 'withdrawn' })
    await page.getByRole('button', { name: 'Approve all' }).click()
    await expect(page.getByText('Withdrawn by its author. Nothing was applied.')).toBeVisible()
    await expect(page.getByText('Your comment was not sent: “Words kept.”')).toBeVisible()
  })

  test('a purge of the wiki drops the edits written before it, and says so', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth1`)
    const c2 = card(page, 2)
    await c2.getByRole('button', { name: 'Edit', exact: true }).click()
    await c2.getByLabel('Title').fill('Hooks that hold')
    await c2.getByRole('button', { name: 'Use my version' }).click()
    await expect(c2).toContainText('edited by you, not sent yet')
    await page.waitForTimeout(300)
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth' }),
    })
    await expect(page.getByText('Text was purged from this wiki after you edited')).toBeVisible({
      timeout: 3_000,
    })
    await expect(card(page, 2)).not.toContainText('edited by you')
  })

  test('on a 409 for an old base the card takes the keyboard, never the alert', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${INBOX}/prp_growth1`)
    await page.evaluate(() => {
      ;(window as unknown as { landed: string[] }).landed = []
      document.addEventListener('focusin', (e) => {
        const t = e.target as HTMLElement
        ;(window as unknown as { landed: string[] }).landed.push(t.getAttribute('role') ?? t.tagName)
      })
    })
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth', address: 'audience/intros', body: 'Newer.' }),
    })
    await page.getByRole('button', { name: 'Approve all' }).click()
    await expect(card(page, 1)).toBeFocused()
    const landed = await page.evaluate(() => (window as unknown as { landed: string[] }).landed)
    expect(landed).not.toContain('alert')
  })
})
