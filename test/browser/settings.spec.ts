// A brain's settings (spec B6 «Settings de un cerebro», plan T046; PR25a), against the fixture API: who
// is in the brain and with which role (the last curator stays, and the screen says why), the repositories
// agents find it by, the compile guide and the usage note with their defaults and a save that never
// overwrites another curator unseen, meaning search, the health thresholds, archiving and, for the
// administration, deleting. Only curators reach it.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

test.describe('settings of a brain', () => {
  test('a curator reaches them from the brain, with every section, and the page passes the audit', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page
      .getByRole('navigation', { name: 'Sections of this brain' })
      .getByRole('link', { name: 'Settings' })
      .click()
    await expect(page).toHaveURL(/\/b\/growth\/settings$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    for (const name of [
      'Members',
      'Repositories',
      'Compile guide',
      'Usage note',
      'Meaning search',
      'Health thresholds',
      'Export and import',
      'Archive',
      'Delete this brain',
    ])
      await expect(region(page, name)).toBeVisible()
    await expect(region(page, 'Export and import')).toContainText('arrive with the install release')
    await expect(region(page, 'Export and import').getByRole('button')).toHaveCount(0)
    await audit(page, 'settings')
    for (const theme of ['light'] as const) {
      await page.evaluate((t) => localStorage.setItem('rscb.theme', t), theme)
      await page.reload()
      await expect(region(page, 'Members').getByRole('listitem').first()).toBeVisible()
      await audit(page, `settings ${theme}`)
    }
  })

  test('the only curator cannot be demoted or removed, and the screen says why', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const eric = region(page, 'Members').getByRole('listitem').filter({ hasText: 'Eric' })
    await expect(eric).toContainText('Only curator')
    await expect(eric).toContainText('A brain always keeps a curator')
    await expect(eric.getByRole('combobox')).toBeDisabled()
    await expect(eric.getByRole('button', { name: /Remove/ })).toHaveCount(0)
  })

  test('add a person by email, change their role, remove them', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const members = region(page, 'Members')
    await members.getByLabel('Email or account id').fill('nobody@example.test')
    await members.getByRole('button', { name: 'Add member' }).click()
    await expect(members.getByRole('alert')).toContainText('There is no account with that id or email')
    await expect(members.getByLabel('Email or account id')).toHaveValue('nobody@example.test')
    const m = members
    const ana = m.getByRole('listitem').filter({ hasText: 'Ana' })
    await ana.getByLabel('Role of Ana').selectOption('reader')
    await expect(page.getByRole('status').filter({ hasText: 'Ana is now a reader.' })).toBeVisible()
    await ana.getByRole('button', { name: 'Remove Ana' }).click()
    await ana.getByRole('button', { name: 'Remove Ana from Growth' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana is no longer in Growth.' })).toBeVisible()
    await expect(m.getByRole('listitem').filter({ hasText: 'Ana' })).toHaveCount(0)
    await m.getByLabel('Email or account id').fill('ana@example.test')
    await m.getByLabel('Role for the new member').selectOption('contributor')
    await m.getByRole('button', { name: 'Add member' }).click()
    await expect(m.getByRole('listitem').filter({ hasText: 'Ana' })).toContainText('contributor')
    await expect(m.getByLabel('Email or account id')).toHaveValue('')
  })

  test('a repository: what it matches before linking, linked, then unlinked', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const repos = region(page, 'Repositories')
    await expect(repos.getByRole('listitem').filter({ hasText: 'github.com/acme/growth-site' })).toBeVisible()
    const field = repos.getByLabel('Repository address')
    await field.fill('~/code/app')
    await expect(repos).toContainText('That is a folder on your machine')
    await field.fill('git@github.com:Acme/App.git')
    await expect(repos).toContainText('Matches github.com/acme/app')
    await repos.getByRole('button', { name: 'Link repository' }).click()
    await expect(repos.getByRole('listitem').filter({ hasText: 'github.com/acme/app' })).toBeVisible()
    await expect(field).toHaveValue('')
    const row = repos.getByRole('listitem').filter({ hasText: 'github.com/acme/app' })
    await row.getByRole('button', { name: 'Unlink github.com/acme/app' }).click()
    await row.getByRole('button', { name: 'Unlink it' }).click()
    await expect(repos.getByRole('listitem').filter({ hasText: 'github.com/acme/app' })).toHaveCount(0)
  })

  test('the compile guide: the default is shown, a custom one saved, then reset to default', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const guide = region(page, 'Compile guide')
    await expect(guide).toContainText('Default')
    const text = guide.getByLabel('Compile guide')
    await expect(text).toHaveValue(/How to compile this brain's journal/)
    await text.fill('Keep pages short. Cite every entry.')
    await guide.getByRole('button', { name: 'Save the guide' }).click()
    await expect(guide.getByRole('status')).toContainText('Saved.')
    await expect(guide).toContainText('Custom')
    await guide.getByRole('button', { name: 'Reset to default' }).click()
    await expect(text).toHaveValue(/How to compile this brain's journal/)
    await guide.getByRole('button', { name: 'Save the guide' }).click()
    await expect(guide.getByRole('status')).toContainText('Saved.')
    await expect(guide).toContainText('Default')
  })

  test('two curators at once: the second save is refused, their version shown, my text kept to save again', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const note = region(page, 'Usage note')
    const text = note.getByLabel('Usage note')
    await text.fill('Always name the ticket.')
    await s.settingsEdit('growth', { usageNote: 'Write in English.' })
    await note.getByRole('button', { name: 'Save the note' }).click()
    await expect(note.getByRole('alert')).toContainText('Someone changed these settings')
    await expect(note).toContainText('Write in English.')
    await expect(text).toHaveValue('Always name the ticket.')
    await note.getByRole('button', { name: 'Save the note' }).click()
    await expect(note.getByRole('status')).toContainText('Saved.')
  })

  test('meaning search and the health thresholds are saved; a number out of range is said by its field', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const meaning = region(page, 'Meaning search')
    await meaning.getByLabel('Leave this brain out of meaning search').check()
    await meaning.getByRole('button', { name: 'Save' }).click()
    await expect(meaning.getByRole('status')).toContainText('Saved.')
    const health = region(page, 'Health thresholds')
    const stale = health.getByLabel('Stale after (days)')
    await stale.fill('0')
    await health.getByRole('button', { name: 'Save' }).click()
    await expect(health).toContainText('A whole number from 1 to 3650.')
    await expect(stale).toBeFocused()
    await stale.fill('30')
    await health.getByRole('button', { name: 'Save' }).click()
    await expect(health.getByRole('status')).toContainText('Saved.')
  })

  test('archive says what stops and asks first; archived, the settings are read-only until unarchived', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    await region(page, 'Archive').getByRole('button', { name: 'Archive this brain' }).click()
    const dialog = page.getByRole('dialog', { name: 'Archive Growth?' })
    await expect(dialog).toContainText('No one can write to it')
    await expect(dialog).toContainText('Reading and search keep working')
    await dialog.getByRole('button', { name: 'Archive Growth' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Growth is archived.' })).toBeFocused()
    await expect(
      region(page, 'Compile guide').getByRole('button', { name: 'Save the guide' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await expect(region(page, 'Compile guide')).toContainText('archived')
    await region(page, 'Archive').getByRole('button', { name: 'Unarchive this brain' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Growth is active again.' })).toBeVisible()
    await expect(
      region(page, 'Compile guide').getByRole('button', { name: 'Save the guide' }),
    ).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('the administration deletes a brain by typing its name', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    await region(page, 'Delete this brain').getByRole('button', { name: 'Delete this brain' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete Growth?' })
    const confirm = dialog.getByRole('button', { name: 'Delete Growth for good' })
    await confirm.click()
    await expect(dialog.getByLabel('Type growth to confirm')).toBeFocused()
    await dialog.getByLabel('Type growth to confirm').fill('growth')
    await confirm.click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('status').filter({ hasText: 'Growth was deleted.' })).toBeVisible()
  })

  test('someone who is not a curator is told who to ask, and is not offered the page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/b/growth')
    await expect(
      page
        .getByRole('navigation', { name: 'Sections of this brain' })
        .getByRole('link', { name: 'Settings' }),
    ).toHaveCount(0)
    await page.goto('/b/growth/settings')
    const state = page.locator('[data-state="forbidden"]')
    await expect(state).toContainText('Only curators of Growth change its settings')
    await expect(state).toContainText('Ask a curator of Growth')
  })

  test('loading and error states keep their shape; an error offers to try again', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { settings: 'error' })
    await page.goto('/b/growth/settings')
    await expect(region(page, 'Compile guide').getByRole('button', { name: 'Try again' })).toBeVisible()
    await s.state('settings', 'normal')
    await region(page, 'Compile guide').getByRole('button', { name: 'Try again' }).click()
    await expect(region(page, 'Compile guide').getByLabel('Compile guide')).toBeVisible()
  })

  for (const width of [320, 375] as const) {
    test(`at ${width} px nothing scrolls sideways`, async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/b/growth/settings')
      await expect(region(page, 'Members').getByRole('listitem').first()).toBeVisible()
      await region(page, 'Repositories')
        .getByLabel('Repository address')
        .fill('ssh://git@gitlab.example.com:2222/a-very-long-group/a-very-long-project-name.git')
      await noSideScroll(page)
    })
  }
})
