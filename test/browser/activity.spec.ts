// Spec B6 «Activity: en vivo» (PR23, T037; CA8 on the fixture, CA6b as the web shows it, CA9 read side): what
// happens in a brain, live; the sessions open now with their client and reference, a Factory run linked only
// with a Factory address; filters by client, kind and reference; pause; «reconnecting» when the connection
// drops and what was missed replayed when it is back; a hidden tab that catches up. Every state designed.
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const A = '/b/growth/activity'

async function tab(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (h ? 'hidden' : 'visible'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

const feed = (page: Page) => page.getByRole('list', { name: 'Live feed' }).getByRole('listitem')

test('CA8: an agent’s write shows in under 2 s; paused, the list stays still and counts what waits', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible()
  await expect(page.locator('.live-state')).toHaveText('Live')
  const t0 = Date.now()
  await s.emit('growth', 'entry.saved', { target: { id: 'e1', label: 'Hooks need a question' } })
  await expect(feed(page).first()).toContainText('Hooks need a question', { timeout: 2_000 })
  expect(Date.now() - t0).toBeLessThan(2_000)
  await expect(feed(page).first()).toContainText('Eric')
  await expect(feed(page).first()).toContainText('Claude Code')
  await expect(feed(page).first()).toContainText('saved')

  await page.getByRole('button', { name: 'Pause' }).click()
  // The badge says so while paused.
  await expect(page.locator('.live-state')).toHaveText('Paused')
  await s.emit('growth', 'entry.saved', { target: { id: 'e2', label: 'Second thing' } })
  await s.emit('growth', 'proposal.submitted', { target: { id: 'p1', label: 'Tighten intros' } })
  const resume = page.getByRole('button', { name: 'Resume (2 new)' })
  await expect(resume).toBeVisible()
  await expect(feed(page).first()).toContainText('Hooks need a question')
  await expect(feed(page)).toHaveCount(1)
  await resume.click()
  await expect(feed(page)).toHaveCount(3)
  await expect(feed(page).first()).toContainText('Tighten intros')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeFocused()
})

test('losing the connection says «reconnecting», and once back what was missed arrives', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await s.emit('growth', 'entry.saved', { target: { id: 'e1', label: 'Before the cut' } })
  await expect(feed(page).first()).toContainText('Before the cut')
  await s.streams(true)
  await expect(page.getByText('The connection dropped. Reconnecting')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.live-state')).toHaveText('Reconnecting…')
  // The brain goes on meanwhile.
  await s.emit('growth', 'entry.saved', { target: { id: 'e2', label: 'While away' } })
  await s.streams(false)
  await expect(feed(page).first()).toContainText('While away', { timeout: 20_000 })
  await expect(page.locator('.live-state')).toHaveText('Live')
  await expect(page.getByText('The connection dropped. Reconnecting')).toHaveCount(0)
  await expect(feed(page).filter({ hasText: 'Before the cut' })).toHaveCount(1)
})

test('a hidden tab lets the feed go and catches up when shown again', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await tab(page, true)
  await expect(page.locator('.live-state')).toHaveText('Paused while this tab is hidden')
  await s.emit('growth', 'entry.saved', { target: { id: 'e1', label: 'Written while hidden' } })
  await tab(page, false)
  await expect(feed(page).first()).toContainText('Written while hidden', { timeout: 3_000 })
})

test('CA6b as shown: a contributor sees writes and her own searches, not someone else’s', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'member')
  await s.emit('growth', 'search', { who: { id: 'acc_eric', name: 'Eric' }, query: 'eric-looks' })
  await s.emit('growth', 'search', { who: { id: 'acc_ana', name: 'Ana' }, query: 'ana-looks' })
  await s.emit('growth', 'entry.saved', { target: { id: 'e1', label: 'Eric writes' } })
  await page.goto(A)
  await expect(feed(page).first()).toContainText('Eric writes')
  await expect(feed(page).filter({ hasText: 'ana-looks' })).toHaveCount(1)
  await expect(feed(page).filter({ hasText: 'eric-looks' })).toHaveCount(0)
  await expect(page.getByText('Searches and pages read show only your own')).toBeVisible()
})

test('a curator sees every search', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await s.emit('growth', 'search', { who: { id: 'acc_ana', name: 'Ana' }, query: 'ana-looks' })
  await page.goto(A)
  await expect(feed(page).filter({ hasText: 'ana-looks' })).toHaveCount(1)
  await expect(page.getByText('As a curator, you see everything')).toBeVisible()
})

test('active sessions: client and reference; a Factory run links only with a Factory address', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { factoryUrl: 'https://factory.example.test' })
  await page.goto(A)
  const sessions = page.getByRole('region', { name: 'Active sessions now' })
  const run = sessions.getByRole('listitem').filter({ hasText: 'Narrate the outro of video 42' })
  await expect(run).toContainText('narrator')
  const link = run.getByRole('link', { name: /run r_3f9a1c2e, step 1/ })
  await expect(link).toHaveAttribute('href', 'https://factory.example.test/runs/r_3f9a1c2e')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  // A reference that names no run is text.
  // Quiet for more than 30 minutes: listed apart.
  const other = page
    .getByRole('region', { name: 'Quiet sessions' })
    .getByRole('listitem')
    .filter({ hasText: 'Fix the onboarding emails' })
  await expect(other).toContainText('repo web, branch emails')
  await expect(other.getByRole('link', { name: /repo web/ })).toHaveCount(0)
})

test('without a Factory address, a run reference is text', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  const run = page
    .getByRole('region', { name: 'Active sessions now' })
    .getByRole('listitem')
    .filter({ hasText: 'Narrate the outro' })
  await expect(run).toContainText('run r_3f9a1c2e, step 1')
  await expect(run.getByRole('link', { name: /r_3f9a1c2e/ })).toHaveCount(0)
})

test('filters by client, kind and reference; filtered empty clears', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await s.emit('growth', 'entry.saved', { client: 'codex', target: { id: 'a', label: 'By Codex' } })
  await s.emit('growth', 'proposal.submitted', { target: { id: 'b', label: 'A proposal' } })
  await s.emit('growth', 'entry.saved', { ref: 'run r_3f9a1c2e', target: { id: 'c', label: 'From a run' } })
  await expect(feed(page)).toHaveCount(3)
  // Folded until opened (a phone sees the feed first).
  await expect(page.getByLabel('Client')).toBeHidden()
  await page.locator('summary').filter({ hasText: 'Filter the activity' }).click()
  await page.getByLabel('Client').selectOption('Codex')
  await expect(feed(page)).toHaveCount(1)
  await expect(feed(page).first()).toContainText('By Codex')
  await page.getByLabel('Client').selectOption('')
  await page.getByLabel('Kind').selectOption('proposals')
  await expect(feed(page)).toHaveCount(1)
  await expect(feed(page).first()).toContainText('A proposal')
  await page.getByLabel('Kind').selectOption('')
  await page.getByLabel('Reference').fill('r_3f9a1c2e')
  await expect(feed(page)).toHaveCount(1)
  await page.getByLabel('Reference').fill('nothing-like-this')
  await expect(page.getByRole('heading', { name: 'No results for these filters' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(feed(page)).toHaveCount(3)
})

test('states: empty says what will appear; no access says who to ask; sessions failing leave the feed', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in', { sessions: 'empty' })
  await page.goto(A)
  await expect(
    page.getByRole('heading', { name: 'Nothing has happened here in the last 24 hours' }),
  ).toBeVisible()
  await expect(page.getByText('No session is open right now.')).toBeVisible()
  await s.state('sessions', 'error')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Active sessions now' }).getByRole('alert')).toBeVisible()
  await expect(page.locator('.live-state')).toHaveText('Live')
  await s.state('brain', 'forbidden')
  await page.goto('/b/growth/activity')
  await expect(page.getByRole('alert')).toContainText('ask a curator of that brain to add you')
})

test('320 px and dark: nothing scrolls sideways, pause and filters reachable by keyboard', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(
    context,
    baseURL as string,
    'signed-in',
    {},
    { factoryUrl: 'https://factory.example.test' },
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  for (let i = 0; i < 4; i++)
    await s.emit('growth', 'entry.saved', {
      ref: 'run r_3f9a1c2e, step 1, a long reference that must wrap on a phone',
      target: { id: `e${i}`, label: `An entry with a rather long title number ${i} that wraps` },
    })
  await expect(feed(page)).toHaveCount(4)
  await noSideScroll(page)
  await page.getByRole('button', { name: 'Pause' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /^Resume/ })).toBeFocused()
  await noSideScroll(page)
})

test('the side bar leads to Activity and Health', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  const nav = page.getByRole('navigation', { name: 'Sections of this brain' })
  await nav.getByRole('link', { name: 'Activity' }).click()
  await expect(page).toHaveURL(/\/b\/growth\/activity$/)
  await expect(nav.getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page')
  await nav.getByRole('link', { name: 'Health' }).click()
  await expect(page).toHaveURL(/\/b\/growth\/health$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible()
})

// Review of PR23.
const openFilters = (page: Page) => page.locator('summary').filter({ hasText: 'Filter the activity' }).click()

test('«N new» counts what the filters would show; «Retry now» while reconnecting', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await openFilters(page)
  await page.getByLabel('Kind').selectOption('proposals')
  await page.getByRole('button', { name: 'Pause' }).click()
  await s.emit('growth', 'entry.saved', { target: { id: 'e1', label: 'Not a proposal' } })
  await s.emit('growth', 'proposal.submitted', { target: { id: 'p1', label: 'A proposal' } })
  await expect(page.getByRole('button', { name: 'Resume (1 new)' })).toBeVisible()
  await page.getByRole('button', { name: 'Resume (1 new)' }).click()
  await s.streams(true)
  await expect(page.locator('.live-state')).toHaveText('Reconnecting…', { timeout: 5_000 })
  await s.streams(false)
  await page.getByRole('button', { name: 'Retry now' }).click()
  await expect(page.locator('.live-state')).toHaveText('Live', { timeout: 3_000 })
})

test('the reference filter finds the session reference; a Factory row names who it acted for', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await s.emit('growth', 'entry.saved', {
    sessionRef: 'ticket 42',
    target: { id: 'e1', label: 'In ticket 42' },
  })
  await s.emit('growth', 'entry.saved', {
    client: 'narrator',
    who: { id: 'acc_factory', name: 'RSC Factory' },
    onBehalf: { id: 'acc_ana', name: 'Ana' },
    target: { id: 'e2', label: 'Narrated' },
  })
  await expect(feed(page).first()).toContainText('for Ana')
  await openFilters(page)
  await page.getByLabel('Reference').fill('ticket 42')
  await expect(feed(page)).toHaveCount(1)
  await expect(feed(page).first()).toContainText('In ticket 42')
})

test('repeated searches are one row with a count; forgetting reads in words', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  for (let i = 0; i < 3; i++) await s.emit('growth', 'search', { query: 'pricing' })
  await s.emit('growth', 'entry.changed', { target: { id: 'ent_x', label: 'forgotten' } })
  await expect(feed(page).first()).toContainText('forgot an entry')
  await expect(feed(page).first()).not.toContainText('changed an entry')
  await expect(feed(page).filter({ hasText: 'pricing' })).toHaveCount(1)
  await expect(feed(page).filter({ hasText: 'pricing' })).toContainText('3 times')
})

test('removed from the brain while watching: the list is cleared and says why', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await s.emit('growth', 'search', { query: 'something-private' })
  await expect(feed(page).filter({ hasText: 'something-private' })).toHaveCount(1)
  await s.close('growth', 'role_changed', 'Your role in this brain changed, or you left it.')
  await expect(page.getByText('Your role in this brain changed')).toBeVisible()
  await expect(page.getByText('something-private')).toHaveCount(0)
})

test('sessions quiet for 30 minutes are apart, with since when', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(A)
  const quiet = page.getByRole('region', { name: 'Quiet sessions' })
  await expect(quiet.getByRole('listitem').filter({ hasText: 'Fix the onboarding emails' })).toContainText(
    /Quiet since \d\d:\d\d UTC/,
  )
  await expect(
    page
      .getByRole('region', { name: 'Active sessions now' })
      .getByRole('listitem')
      .filter({ hasText: 'Fix the onboarding emails' }),
  ).toHaveCount(0)
})

test('a forget heard live takes the title off the rows already shown, for a member', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'member')
  await page.goto(A)
  await expect(page.locator('.live-state')).toHaveText('Live')
  await s.emit('growth', 'entry.saved', { target: { id: 'ent_secret', label: 'Secret-title-here' } })
  await expect(feed(page).filter({ hasText: 'Secret-title-here' })).toHaveCount(1)
  await s.emit('growth', 'entry.changed', { target: { id: 'ent_secret', label: 'forgotten' } })
  await expect(feed(page).first()).toContainText('forgot an entry')
  await expect(page.getByText('Secret-title-here')).toHaveCount(0)
  // A closed session whose summary is then forgotten loses the summary's title too.
  await s.emit('growth', 'session.closed', {
    target: { id: 'ses_sum', label: 'Summary-title-here' },
    summaryEntryId: 'ent_sum',
  })
  await expect(feed(page).filter({ hasText: 'Summary-title-here' })).toHaveCount(1)
  await s.emit('growth', 'entry.changed', { target: { id: 'ent_sum', label: 'forgotten' } })
  await expect(feed(page).first()).toContainText('forgot an entry')
  await expect(page.getByText('Summary-title-here')).toHaveCount(0)
  // A session closed with a summary it may no longer see: said without a title.
  await s.emit('growth', 'session.closed', { target: { id: 'ses_x', label: null } as never })
  await expect(feed(page).first()).toContainText('closed a session')
})
