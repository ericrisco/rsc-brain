// Review of PR20 (spec B6 «Journal», «Overview»): what a person met using the journal, against the fixture
// API. Previews keep identifiers as written; the overview leads to what its numbers count; the keyboard
// lands where the work goes on after Edit, Forget and Recover; a session shows each entry's state in words
// and says how many were forgotten; a wiki page lists its open corrections; «Show more» starts again when
// the live feed brings a fresh first page; and nobody is offered a decision the server would refuse.
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const J = '/b/growth/journal'
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return {
      tag: a?.tagName ?? '',
      id: a?.id ?? '',
      text: a?.textContent?.trim() ?? '',
      role: a?.getAttribute('role'),
    }
  })

test('previews keep underscores and dots inside words', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${J}/entries/ent_fx_hooks`)
  await page.getByRole('button', { name: 'Edit this entry' }).click()
  await page
    .getByLabel('Text')
    .fill('Retry when the status is past_due; keep stripe_invoice_id and invoices.retry_at.')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 2.' })).toBeVisible()
  await page.goto(`${J}/sessions/ses_fx_1`)
  const line = page.locator('#session-entries ~ ol > li').filter({ hasText: 'The hook goes first' })
  await expect(line).toContainText('past_due; keep stripe_invoice_id and invoices.retry_at.')
})

test('the overview leads to what it counts', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  const today = page.getByRole('region', { name: "Today's sessions" })
  await expect(today.getByRole('link', { name: 'Review the intros of October' })).toHaveAttribute(
    'href',
    `${J}/sessions/ses_growth001`,
  )
  // A session without a purpose opens too, named in words.
  await expect(today.getByRole('link', { name: 'Unnamed work · an API client' })).toHaveAttribute(
    'href',
    `${J}/sessions/ses_growth003`,
  )
  const numbers = page.getByRole('region', { name: 'In numbers' })
  await expect(numbers.getByRole('link', { name: /not in the wiki yet/ })).toHaveAttribute(
    'href',
    `${J}?uncompiled=1`,
  )
  // What waits for review leads to the proposals inbox (it exists since PR21).
  await expect(numbers.getByRole('link', { name: /waiting for review/ })).toHaveAttribute(
    'href',
    '/b/growth/proposals',
  )
  await numbers.getByRole('link', { name: /conflicts?$/ }).click()
  await expect(page).toHaveURL(new RegExp(`${J}/conflicts$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Conflicts' })).toBeVisible()
  await page.goBack()
  await numbers.getByRole('link', { name: /not in the wiki yet/ }).click()
  await expect(page).toHaveURL(new RegExp(`${J}\\?uncompiled=1$`))
  await expect(page.getByLabel('Only with entries not in the wiki yet')).toBeChecked()
})

test('after Edit the keyboard is in the title; after Forget and Recover it hears what happened', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${J}/entries/ent_fx_plain`)
  await page.getByRole('button', { name: 'Edit this entry' }).click()
  await expect(page.getByLabel('Title', { exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Forget…' }).click()
  const d = page.getByRole('dialog', { name: 'Forget this entry?' })
  await d.getByLabel('Why (required)').fill('Plain text was a dead end.')
  await d.getByRole('button', { name: 'Forget entry' }).click()
  await expect(d).toBeHidden()
  await expect.poll(() => focused(page)).toMatchObject({ role: 'status', text: /Forgotten/ })
  await page.getByRole('button', { name: 'Recover: Plain-text onboarding emails' }).click()
  await expect.poll(() => focused(page)).toMatchObject({ role: 'status', text: /Recovered/ })
})

test('a session shows each entry’s state in words, and how many were forgotten', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${J}/entries/ent_fx_hooks`)
  await page.getByRole('button', { name: 'Pin' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Pinned' })).toBeVisible()
  await page.getByText('Review and expiry dates').click()
  await page.getByLabel('Expires on').fill('2020-01-01')
  await page.getByRole('button', { name: 'Save dates' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Dates saved.' })).toBeVisible()
  await page.getByRole('button', { name: 'Relate to another entry…' }).click()
  const d = page.getByRole('dialog', { name: 'Relate to another entry' })
  await d.getByLabel('is replaced by the other one', { exact: false }).check()
  await d.getByLabel('The other entry').fill('thirty')
  await d.getByRole('option', { name: /Thirty-second intros/ }).click()
  await d.getByRole('button', { name: 'Save relation' }).click()
  await expect(d).toBeHidden()
  await page.goto(`${J}/sessions/ses_fx_1`)
  const lines = page.locator('#session-entries ~ ol > li')
  const hooks = lines.filter({ hasText: 'The hook goes first' })
  for (const badge of ['Pinned', 'Superseded', 'Expired']) await expect(hooks).toContainText(badge)
  const intros = lines.filter({
    has: page.getByRole('link', { name: 'Short intros keep viewers', exact: true }),
  })
  await expect(intros).toContainText('Has conflict')
  await expect(lines.filter({ hasText: 'Session summary' })).not.toContainText('Has conflict')
  // Ana's session lost one entry: the session says so, and a curator can open them.
  await page.goto(`${J}/sessions/ses_fx_2`)
  await page.getByRole('link', { name: '1 forgotten — see Forgotten' }).click()
  await expect(page).toHaveURL(new RegExp(`${J}/forgotten$`))
})

test('a contributor learns the count of forgotten entries without a link she cannot open', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto(`${J}/sessions/ses_fx_2`)
  await expect(page.locator('#session-entries').locator('..')).toContainText('1 forgotten')
  await expect(page.getByRole('link', { name: /see Forgotten/ })).toHaveCount(0)
})

test('a wiki page lists the corrections about it', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/pages/audience/intros')
  const wrong = page.getByRole('region', { name: 'Something wrong here?' })
  await expect(wrong.getByRole('link', { name: 'No greeting before the hook' })).toHaveAttribute(
    'href',
    `${J}/entries/ent_fx_corr`,
  )
  await expect(wrong).toContainText('for narrator')
  await expect(wrong.getByRole('link', { name: 'Add a correction' })).toBeVisible()
})

test('«Show more» starts again when the live feed brings a fresh first page', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in', { sessions: 'much-data' })
  await page.goto(J)
  const items = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem')
  await expect(items).toHaveCount(50)
  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(items).toHaveCount(100)
  await s.emit('growth', 'session.opened')
  await expect(items).toHaveCount(50)
  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(items).toHaveCount(100)
})

test.describe('decisions only for who may take them', () => {
  test('a contributor keeps what is hers to keep; a correction of someone else waits for them', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(`${J}/conflicts`)
    const cards = page.locator('.conflict-item')
    await expect(cards).toHaveCount(2)
    const contra = cards.filter({ hasText: 'Thirty-second intros work best' })
    // A heading per conflict; each side with who wrote it and its session.
    await expect(contra.getByRole('heading')).toContainText('contradict')
    await expect(contra).toContainText('Codex of Ana')
    await expect(contra).toContainText('Claude Code of Eric')
    await expect(contra.getByRole('link', { name: 'Fix the onboarding emails' })).toBeVisible()
    // Eric's entry is not hers to supersede: she may keep his (hers loses) or say they are not related.
    await expect(
      contra.getByRole('button', { name: 'Keep this one: Short intros keep viewers' }),
    ).toBeVisible()
    await expect(contra.getByRole('button', { name: /Keep this one: Thirty-second/ })).toHaveCount(0)
    await expect(contra.getByRole('button', { name: 'Not related' })).toBeVisible()
    const asked = cards.filter({ hasText: 'No greeting before the hook' })
    await expect(asked.getByRole('button')).toHaveCount(0)
    await expect(asked).toContainText(
      'Only the authors of these entries or a curator of Growth (Eric) decide',
    )
    await noSideScroll(page)
    // Relating her entry: what would decide about it is hers; replacing it is offered.
    await page.goto(`${J}/entries/ent_fx_intros`)
    await page.getByRole('button', { name: 'Relate to another entry…' }).click()
    const d = page.getByRole('dialog', { name: 'Relate to another entry' })
    await expect(d.getByRole('radio').first()).toBeFocused()
    await expect(d.getByLabel('is replaced by the other one', { exact: false })).toBeDisabled()
    await expect(d).toContainText('Only its author or a curator can replace an entry')
  })

  test('the author of a correction keeps it against what an agent asked about it', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'member')
    await page.goto(`${J}/correct`)
    await page.getByLabel('Nothing in particular').check()
    await page.getByLabel('Title').fill('Hooks in five seconds')
    await page.getByLabel('The correction').fill('Put the hook in the first five seconds.')
    await page.getByRole('button', { name: 'Add correction' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Hooks in five seconds' })).toBeVisible()
    const mine = decodeURIComponent(page.url().split('/').pop() as string)
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/agent-relate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth', from: 'ent_fx_intros', to: mine, kind: 'supersedes' }),
    })
    // Keeping hers supersedes Eric's entry: hers to answer only because the agent asked about hers.
    await page.goto(`${J}/conflicts`)
    const asked = page.locator('.conflict-item').filter({ hasText: 'Hooks in five seconds' })
    await expect(asked).toContainText('An agent asked')
    await asked.getByRole('button', { name: 'Keep this one: Hooks in five seconds' }).click()
    const d = page.getByRole('dialog', { name: 'Decide this conflict?' })
    await expect(d).toContainText('“Hooks in five seconds” stays.')
    await d.getByRole('button', { name: 'Decide' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Decided.' })).toBeVisible()
    await expect(page.locator('.conflict-item').filter({ hasText: 'Hooks in five seconds' })).toHaveCount(0)
  })

  test('a curator decides any of them, from either side', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`${J}/conflicts`)
    const contra = page.locator('.conflict-item').filter({ hasText: 'Thirty-second intros work best' })
    await contra.getByRole('button', { name: 'Keep this one: Thirty-second intros work best' }).click()
    const d = page.getByRole('dialog', { name: 'Decide this conflict?' })
    await expect(d).toContainText('“Thirty-second intros work best” stays.')
    await d.getByRole('button', { name: 'Decide' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Decided.' })).toBeVisible()
    await expect(page.locator('.conflict-item')).toHaveCount(1)
  })
})

test('the entry names its session by its purpose, and offers one «Add a correction»', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${J}?client=Codex`)
  await page.getByRole('link', { name: 'Fix the onboarding emails' }).click()
  await page.getByRole('link', { name: 'Thirty-second intros work best' }).click()
  const crumbs = page.getByRole('navigation', { name: 'Journal', exact: true })
  await expect(crumbs.getByRole('link', { name: 'Fix the onboarding emails' })).toBeVisible()
  await expect(
    page.locator('.page-aside').getByRole('link', { name: 'Fix the onboarding emails' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: /Add a correction/ })).toHaveCount(1)
  // The session's header: when it opened, its entries apart from its summary, «Closed» said once.
  await page.goto(`${J}/sessions/ses_fx_3`)
  await expect(page.locator('.facts')).toContainText('Opened')
  await expect(page.getByText(/Closed without (a )?summary/)).toHaveCount(1)
})

test('Sessions keeps its filters when coming back from a session', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${J}?client=Codex`)
  await page.getByRole('link', { name: 'Fix the onboarding emails' }).click()
  await page
    .getByRole('navigation', { name: 'Journal', exact: true })
    .getByRole('link', { name: 'Sessions' })
    .click()
  await expect(page).toHaveURL(new RegExp(`${J}\\?client=Codex$`))
  // A filter is on: the filters show open, with their date fields named alike.
  await expect(page.getByLabel('Active from')).toBeVisible()
  await expect(page.getByLabel('Active until')).toBeVisible()
})

test('To review has its count beside it, as Conflicts does', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(J)
  const nav = page.getByRole('navigation', { name: 'Journal sections' })
  await expect(nav.getByRole('link', { name: /To review/ })).toContainText('1')
})
