// A brain's settings (spec B6 «Settings de un cerebro», plan T046; PR25a and its fixes), against the
// fixture API: four tabs (Members, Agents, Health, Archive); who is in the brain and with which role (the
// last curator stays, and the screen says why; a role is saved with its own button); the repositories
// agents find it by; the compile guide (folded until opened) and the usage note; meaning search; the health
// thresholds; archiving and, for the administration, deleting. Each part saves only what it changed, on the
// value it read: another curator's change in another part is never erased, and one in the same field is
// shown with what was typed kept. Only curators reach it.
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
const tab = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Parts of the settings' }).getByRole('link', { name })
const member = (page: Page, name: string) =>
  region(page, 'Members').getByRole('listitem').filter({ hasText: name })

test.describe('settings of a brain', () => {
  test('a curator reaches them from the brain; four tabs, each with its parts, each passing the audit', async ({
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
    await expect(tab(page, 'Members')).toHaveAttribute('aria-current', 'page')
    const parts: Record<string, string[]> = {
      Members: ['Members'],
      Agents: ['Repositories', 'Usage note', 'Compile guide', 'Meaning search'],
      Health: ['Health thresholds'],
      Archive: ['Export and import', 'Archive', 'Delete this brain'],
    }
    for (const [name, regions] of Object.entries(parts)) {
      await tab(page, name).click()
      await expect(tab(page, name)).toHaveAttribute('aria-current', 'page')
      for (const r of regions) await expect(region(page, r)).toBeVisible()
      await expect(
        page
          .getByRole('navigation', { name: 'Sections of this brain' })
          .getByRole('link', { name: 'Settings' }),
      ).toHaveAttribute('aria-current', /page|true/)
      await audit(page, `settings ${name}`)
    }
    await expect(region(page, 'Export and import')).toContainText('arrive with the install release')
    await expect(region(page, 'Export and import').getByRole('button')).toHaveCount(0)
    // A part heading reads stronger than a field label.
    await tab(page, 'Health').click()
    const size = async (sel: string) =>
      page
        .locator(sel)
        .first()
        .evaluate((e) => Number.parseFloat(getComputedStyle(e).fontSize))
    expect(await size('#health-title')).toBeGreaterThan(await size('label[for="threshold-staleDays"]'))
    await page.evaluate(() => localStorage.setItem('rscb.theme', 'light'))
    await page.reload()
    await expect(region(page, 'Health thresholds').getByLabel('Stale after (days)')).toBeVisible()
    await audit(page, 'settings light')
  })

  test('the only curator cannot be demoted or removed, and the select says why', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const eric = member(page, 'Eric')
    await expect(eric).toContainText('Only curator')
    const select = eric.getByRole('combobox')
    await expect(select).toBeDisabled()
    await expect(select).toHaveAccessibleDescription(/A brain always keeps a curator/)
    await expect(eric.getByRole('button', { name: /Remove/ })).toHaveCount(0)
  })

  test('a role is saved with its own button (moving through the list saves nothing), then the list is read again', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const ana = member(page, 'Ana')
    const select = ana.getByLabel('Role of Ana')
    await select.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('status').filter({ hasText: 'Ana is now' })).toHaveCount(0)
    await select.selectOption('reader')
    await ana.getByRole('button', { name: 'Save role of Ana' }).click()
    const said = page.getByRole('status').filter({ hasText: 'Ana is now a reader.' })
    await expect(said).toBeFocused()
    await expect(ana.getByRole('button', { name: 'Save role of Ana' })).toHaveCount(0)
    await expect(select).toHaveValue('reader')
  })

  test('giving up one’s own curator role asks first, then the page says why it closes', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    await member(page, 'Ana').getByLabel('Role of Ana').selectOption('curator')
    await member(page, 'Ana').getByRole('button', { name: 'Save role of Ana' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana is now a curator.' })).toBeVisible()
    await member(page, 'Eric').getByLabel('Role of Eric').selectOption('contributor')
    await member(page, 'Eric').getByRole('button', { name: 'Save role of Eric' }).click()
    const dialog = page.getByRole('dialog', { name: 'Give up the curator role?' })
    await expect(dialog).toContainText('can no longer change its settings')
    await dialog.getByRole('button', { name: 'Give it up' }).click()
    await expect(page.locator('[data-state="forbidden"]')).toContainText(
      'Only curators of Growth change its settings',
    )
  })

  test('remove: the confirmation is by the row with the keyboard on it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const ana = member(page, 'Ana')
    await ana.getByRole('button', { name: 'Remove Ana' }).click()
    const yes = ana.getByRole('button', { name: 'Remove Ana from Growth' })
    await expect(yes).toBeFocused()
    await yes.click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana is no longer in Growth.' })).toBeFocused()
    await expect(member(page, 'Ana')).toHaveCount(0)
  })

  test('add: an unknown email is said; someone already in the brain is not changed, and the keyboard goes to their role', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings')
    const members = region(page, 'Members')
    await members.getByLabel('Email or account id').fill('nobody@example.test')
    await members.getByRole('button', { name: 'Add member' }).click()
    await expect(members.getByRole('alert')).toContainText('There is no account with that id or email')
    await expect(members.getByLabel('Email or account id')).toHaveValue('nobody@example.test')
    await members.getByLabel('Email or account id').fill('ana@example.test')
    await members.getByLabel('Role for the new member').selectOption('curator')
    await expect(members).toContainText('Service accounts join as contributor or reader')
    await members.getByRole('button', { name: 'Add member' }).click()
    await expect(members).toContainText('Ana is already a contributor — change their role in the list.')
    await expect(member(page, 'Ana').getByLabel('Role of Ana')).toBeFocused()
    await expect(member(page, 'Ana').getByLabel('Role of Ana')).toHaveValue('contributor')
    // Removed, then added again by the form.
    await member(page, 'Ana').getByRole('button', { name: 'Remove Ana' }).click()
    await member(page, 'Ana').getByRole('button', { name: 'Remove Ana from Growth' }).click()
    await members.getByLabel('Email or account id').fill('ana@example.test')
    await members.getByLabel('Role for the new member').selectOption('contributor')
    await members.getByRole('button', { name: 'Add member' }).click()
    await expect(member(page, 'Ana').getByLabel('Role of Ana')).toHaveValue('contributor')
    await expect(members.getByLabel('Email or account id')).toHaveValue('')
  })

  test('a repository: what it matches before linking, linked, then unlinked', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/agents')
    const repos = region(page, 'Repositories')
    await expect(repos.getByRole('listitem').filter({ hasText: 'github.com/acme/growth-site' })).toBeVisible()
    const field = repos.getByLabel('Repository address')
    await field.fill('~/code/app')
    await expect(repos).toContainText('That is a folder on your machine')
    await field.fill('acme/app')
    await expect(repos).toContainText('use the full address, e.g. github.com/org/repo')
    await field.fill('git@github.com:Acme/App.git')
    await expect(repos).toContainText('Matches github.com/acme/app')
    await repos.getByRole('button', { name: 'Link repository' }).click()
    await expect(repos.getByRole('listitem').filter({ hasText: 'github.com/acme/app' })).toBeVisible()
    await expect(field).toHaveValue('')
    const row = repos.getByRole('listitem').filter({ hasText: 'github.com/acme/app' })
    await row.getByRole('button', { name: 'Unlink github.com/acme/app' }).click()
    await expect(row.getByRole('button', { name: 'Unlink it' })).toBeFocused()
    await row.getByRole('button', { name: 'Unlink it' }).click()
    await expect(repos.getByRole('listitem').filter({ hasText: 'github.com/acme/app' })).toHaveCount(0)
  })

  test('the compile guide is folded until opened; the default shown, a custom one saved, then reset to default', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/agents')
    const guide = region(page, 'Compile guide')
    await expect(guide).toContainText('Default')
    await expect(guide.getByLabel('Compile guide')).toHaveCount(0)
    await guide.getByRole('button', { name: 'Edit the guide' }).click()
    const text = guide.getByLabel('Compile guide')
    await expect(text).toBeFocused()
    await expect(text).toHaveValue(/How to compile this brain's journal/)
    await text.fill('')
    await expect(guide).toContainText('An empty guide is the default guide.')
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

  test('two curators, same field: the save is refused, their text shown, mine kept to save again', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/agents')
    const note = region(page, 'Usage note')
    const text = note.getByLabel('Usage note')
    await text.fill('Always name the ticket.')
    await s.settingsEdit('growth', { usageNote: 'Write in English.' })
    await note.getByRole('button', { name: 'Save the note' }).click()
    await expect(note.getByRole('alert')).toContainText('Someone changed this')
    await expect(note).toContainText('Write in English.')
    await expect(text).toHaveValue('Always name the ticket.')
    await note.getByRole('button', { name: 'Save the note' }).click()
    await expect(note.getByRole('status')).toContainText('Saved.')
  })

  test('another curator’s note is never erased by a save of another part (the reviewer’s first case)', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/agents')
    await expect(region(page, 'Usage note').getByLabel('Usage note')).toHaveValue('')
    // Meanwhile another curator writes the note.
    await s.settingsEdit('growth', { usageNote: 'Write in English.' })
    // I save the meaning search, then the thresholds: neither touches the note.
    await region(page, 'Meaning search').getByLabel('Leave this brain out of meaning search').check()
    await region(page, 'Meaning search').getByRole('button', { name: 'Save' }).click()
    await expect(region(page, 'Meaning search').getByRole('status')).toContainText('Saved.')
    await tab(page, 'Health').click()
    await region(page, 'Health thresholds').getByLabel('Stale after (days)').fill('30')
    await region(page, 'Health thresholds').getByRole('button', { name: 'Save' }).click()
    await expect(region(page, 'Health thresholds').getByRole('status')).toContainText('Saved.')
    await page.reload()
    await tab(page, 'Agents').click()
    await expect(region(page, 'Usage note').getByLabel('Usage note')).toHaveValue('Write in English.')
  })

  test('another curator’s thresholds are never erased, and the same one is shown with mine kept (the reviewer’s second case)', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/health')
    const health = region(page, 'Health thresholds')
    await expect(health.getByLabel('Stale after (days)')).toHaveValue('90')
    // Meanwhile another curator changes how long a page may be, and when it is stale.
    await s.settingsEdit('growth', { longChars: 30000 })
    // I change only the maintenance: saved, theirs untouched.
    await health.getByLabel('Maintenance every (approvals)').fill('25')
    await health.getByRole('button', { name: 'Save' }).click()
    await expect(health.getByRole('status')).toContainText('Saved.')
    await s.settingsEdit('growth', { staleDays: 60 })
    // Now the same field: refused, their values shown, mine kept.
    await health.getByLabel('Stale after (days)').fill('45')
    await health.getByRole('button', { name: 'Save' }).click()
    await expect(health.getByRole('alert')).toContainText('Someone changed this')
    await expect(health).toContainText('Stale after (days): 60')
    await expect(health.getByLabel('Stale after (days)')).toHaveValue('45')
    await health.getByRole('button', { name: 'Save' }).click()
    await expect(health.getByRole('status')).toContainText('Saved.')
    await page.reload()
    await expect(health.getByLabel('Long after (characters)')).toHaveValue('30000')
    await expect(health.getByLabel('Stale after (days)')).toHaveValue('45')
    await expect(health.getByLabel('Maintenance every (approvals)')).toHaveValue('25')
  })

  test('a draft lives in memory only and goes once saved: what another curator saves later shows', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/agents')
    const text = region(page, 'Usage note').getByLabel('Usage note')
    await text.fill('A secret pasted by mistake rscb_not_a_real_one')
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain(
      'rscb_not',
    )
    // Kept while moving inside the web.
    await tab(page, 'Health').click()
    await tab(page, 'Agents').click()
    await expect(text).toHaveValue('A secret pasted by mistake rscb_not_a_real_one')
    await text.fill('Name the ticket.')
    await region(page, 'Usage note').getByRole('button', { name: 'Save the note' }).click()
    await expect(region(page, 'Usage note').getByRole('status')).toContainText('Saved.')
    await s.settingsEdit('growth', { usageNote: 'Write in English.' })
    // Back to the tab: the settings are read again, and no old draft hides what is there now.
    await tab(page, 'Health').click()
    await tab(page, 'Agents').click()
    await expect(region(page, 'Usage note').getByLabel('Usage note')).toHaveValue('Write in English.')
  })

  test('meaning search and the health thresholds are saved; a number out of range is said by its field', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/agents')
    const meaning = region(page, 'Meaning search')
    await meaning.getByLabel('Leave this brain out of meaning search').check()
    await meaning.getByRole('button', { name: 'Save' }).click()
    await expect(meaning.getByRole('status')).toContainText('Saved.')
    await tab(page, 'Health').click()
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

  test('archive says what stops and what still works, and asks first; archived, settings and links are read-only', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/archive')
    await region(page, 'Archive').getByRole('button', { name: 'Archive this brain' }).click()
    const dialog = page.getByRole('dialog', { name: 'Archive Growth?' })
    await expect(dialog).toContainText('What stops')
    await expect(dialog).toContainText('no repository can be linked')
    await expect(dialog).toContainText('What still works: reading, search')
    await expect(dialog).toContainText('who is a member')
    await dialog.getByRole('button', { name: 'Archive Growth' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Growth is archived.' })).toBeFocused()
    await tab(page, 'Agents').click()
    await expect(
      region(page, 'Repositories').getByRole('button', { name: 'Link repository' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await region(page, 'Compile guide').getByRole('button', { name: 'Edit the guide' }).click()
    await expect(
      region(page, 'Compile guide').getByRole('button', { name: 'Save the guide' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await expect(region(page, 'Compile guide')).toContainText('archived')
    // Members still change on an archived brain.
    await tab(page, 'Members').click()
    await member(page, 'Ana').getByLabel('Role of Ana').selectOption('reader')
    await member(page, 'Ana').getByRole('button', { name: 'Save role of Ana' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana is now a reader.' })).toBeVisible()
    await tab(page, 'Archive').click()
    await region(page, 'Archive').getByRole('button', { name: 'Unarchive this brain' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Growth is active again.' })).toBeVisible()
  })

  test('the administration deletes a brain by typing its name', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/archive')
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
    for (const path of ['/b/growth/settings', '/b/growth/settings/health']) {
      await page.goto(path)
      const state = page.locator('[data-state="forbidden"]')
      await expect(state).toContainText('Only curators of Growth change its settings')
      await expect(state).toContainText('Ask a curator of Growth')
    }
  })

  test('loading and error states keep their shape; an error offers to try again', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { settings: 'error' })
    await page.goto('/b/growth/settings/agents')
    await expect(region(page, 'Usage note').getByRole('button', { name: 'Try again' })).toBeVisible()
    await s.state('settings', 'normal')
    await region(page, 'Usage note').getByRole('button', { name: 'Try again' }).click()
    await expect(region(page, 'Usage note').getByLabel('Usage note')).toBeVisible()
  })

  for (const width of [320, 375] as const) {
    test(`at ${width} px nothing scrolls sideways, and each tab fits in about two screens`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.setViewportSize({ width, height: 800 })
      for (const path of ['', '/agents', '/health', '/archive']) {
        await page.goto(`/b/growth/settings${path}`)
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()
        if (path === '/agents')
          await region(page, 'Repositories')
            .getByLabel('Repository address')
            .fill('ssh://git@gitlab.example.com:2222/a-very-long-group/a-very-long-project-name.git')
        await noSideScroll(page)
        const tall = await page.evaluate(() => document.documentElement.scrollHeight)
        expect(tall, `${path || '/'} is ${tall}px tall`).toBeLessThan(800 * 3)
      }
    })
  }
})
