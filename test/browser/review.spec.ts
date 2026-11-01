// The second review of PR17 (B6 web foundations): where the first steps point, how a session ends, what
// a link says before anyone types, and the small things a person meets on the way. Each test walks a real
// task against the fixture API.
import { expect, INVITE, PASSWORD, RESET, scenario, test } from './fixture.ts'

const ENDED = 'Your session ended. Sign in again.'

test.describe('R1: the first steps point at the installation, not at the browser', () => {
  test('the command to connect an agent uses the public address the server gives', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { home: 'empty' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
    const command = page.locator('pre.command')
    await expect(command).toHaveText(
      'claude mcp add --transport http rsc-brain https://brain.example.test/mcp --scope user\nclaude mcp login rsc-brain',
    )
    await expect(command).not.toContainText(baseURL as string)
  })
})

test.describe('R2: signing out', () => {
  test('a sign-out the server answers "no session" still lands on a plain sign-in page', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
    await s.endSessions()
    await page.getByRole('button', { name: /Account/ }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Signed out.' })).toBeVisible()
    await expect(page).toHaveURL(/\/sign-in$/)
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/\/sign-in$/)
    await expect(page.getByText(ENDED)).toHaveCount(0)
  })
})

test.describe('R3: dialogs', () => {
  test('closed with Esc and opened again at once, the dialog stays open', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await page.getByRole('button', { name: /Search your brains/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Search' })
    await expect(dialog).toBeVisible()
    // Esc in the field, then the search opened again before the browser delivers the dialog's "close".
    const reopened = await page.evaluate(async () => {
      const d = [...document.querySelectorAll('dialog')].find((x) => x.open) as HTMLDialogElement
      const field = document.querySelector('#search-q') as HTMLInputElement
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      for (let i = 0; i < 20 && d.open; i++) await Promise.resolve()
      if (d.open) return 'did not close'
      // The browser's "close" of that Esc is still queued: it arrives after the dialog opened again.
      let late = false
      // Watched on the way down (window, capture), before the dialog's own handler can act on it.
      const watch = (e: Event) => {
        if (e.target !== d) return
        late = d.open
        window.removeEventListener('close', watch, true)
      }
      window.addEventListener('close', watch, true)
      ;(document.querySelector('.searchbox') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 100))
      if (!late) return 'the close did not arrive late: this test proves nothing'
      return d.open ? 'open' : 'closed'
    })
    expect(reopened).toBe('open')
    await expect(dialog).toBeVisible()
  })
})

test.describe('R4: a session that ends mid-use', () => {
  test('sign-in says so, the keyboard is on the email, and the page and its query come back', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/?from=mail')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await page.locator('html[data-keys="on"]').waitFor({ state: 'attached' })
    await page.keyboard.press('Control+k')
    await page.getByLabel('Search for').fill('retention')
    await s.endSessions()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/sign-in\?next=%2F%3Ffrom%3Dmail$/)
    await expect(page.getByRole('status').filter({ hasText: ENDED })).toBeVisible()
    await expect(page.getByLabel('Email')).toBeFocused()
    await page.getByLabel('Email').fill('eric@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/\?from=mail$/)
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    // The search that was open when the session ended does not come back by itself.
    await page.waitForTimeout(300)
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden()
  })

  test('a plain visit to sign-in says nothing about a session, and the keyboard is on the email', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/sign-in')
    await expect(page.getByLabel('Email')).toBeFocused()
    await expect(page.getByText(ENDED)).toHaveCount(0)
  })
})

test.describe('R5: moving between screens already loaded', () => {
  test('a session revoked meanwhile is noticed on the next move, not after it', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await page.getByRole('link', { name: 'Growth' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
    // Each move checks the session once; that check answers before the session is revoked.
    const checked = page.waitForResponse((r) => r.url().endsWith('/v1/me'))
    await page.locator('aside').getByRole('link', { name: '← All brains' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
    expect((await checked).status()).toBe(200)
    await s.endSessions()
    await page.getByRole('link', { name: 'Growth' }).click()
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fgrowth$/)
    await expect(page.getByRole('status').filter({ hasText: ENDED })).toBeVisible()
  })
})

test.describe('R6: invitations', () => {
  test('signed in, a used invitation says so and leads to the brains', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/invite#token=inv_not_a_real_token_000')
    await expect(
      page.getByRole('heading', { level: 1, name: 'This invitation is already used' }),
    ).toBeVisible()
    const main = page.getByRole('main')
    await expect(main.getByRole('link', { name: 'Go to your brains' })).toHaveAttribute('href', '/')
    await expect(main.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
    await expect(page.locator('header a.brand')).toHaveAttribute('href', '/')
  })

  test('signed out, a used invitation still offers to sign in', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/invite#token=inv_not_a_real_token_000')
    await expect(
      page.getByRole('heading', { level: 1, name: 'This invitation link does not work' }),
    ).toBeVisible()
    await expect(page.locator('header a.brand')).toHaveAttribute('href', '/sign-in')
  })

  test('signed in as someone else, the page says what accepting does before the form', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(`/invite#token=${INVITE}`)
    const notice = page.getByText(
      'You are signed in as Eric. Accepting signs Eric out and continues as marta@example.test.',
    )
    await expect(notice).toBeVisible()
    const before = await notice.evaluate((n) => {
      const form = document.querySelector('main form')
      return Boolean(form && n.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(before).toBe(true)
  })

  test('after accepting, home welcomes the person with what they joined', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto(`/invite#token=${INVITE}`)
    await page.getByLabel('Your name').fill('Marta')
    await page.getByLabel('Choose a password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Create my account' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Welcome — you joined Growth as contributor and Support as reader.' }),
    ).toBeVisible()
  })

  test('a new invitation link pasted in the same tab puts the keyboard on its title', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/invite#token=inv_not_a_real_token_000')
    await expect(
      page.getByRole('heading', { level: 1, name: 'This invitation link does not work' }),
    ).toBeVisible()
    await page.evaluate((t) => {
      location.hash = `#token=${t}`
    }, INVITE)
    await expect(page.getByRole('heading', { level: 1, name: 'Accept your invitation' })).toBeFocused()
  })
})

test.describe('R6: reset links', () => {
  test('a reset link that does not work says so on arrival, before anyone types', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/reset#token=rst_not_a_real_token_000')
    await expect(page.getByRole('heading', { level: 1, name: 'This reset link does not work' })).toBeVisible()
    await expect(page.getByLabel('New password')).toHaveCount(0)
  })

  test('a short new password is marked on its field, without asking the server', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    let sent = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/v1/auth/reset/confirm')) sent++
    })
    await page.goto(`/reset#token=${RESET}`)
    const field = page.getByLabel('New password')
    await field.fill('too short')
    await page.getByRole('button', { name: 'Save the new password' }).click()
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(field).toHaveAccessibleDescription(/at least 12 characters/)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(sent).toBe(0)
  })
})

test.describe('R6: the small things', () => {
  test('the banner after the setup lines up with the card under it', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.goto('/setup')
    await page.evaluate(() => localStorage.setItem('rscb.theme', 'light'))
    await page.getByLabel('Name of this installation').fill('rsc-brain')
    await page.getByLabel('Your name').fill('Eric')
    await page.getByLabel('Your email').fill('eric@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    const banner = page.getByRole('status').filter({ hasText: 'Brain is set up.' })
    await expect(banner).toBeVisible()
    const a = await banner.boundingBox()
    const b = await page.locator('.state.next').boundingBox()
    expect(a?.width).toBe(b?.width)
    expect(a?.x).toBe(b?.x)
  })

  test('offline, "could not be reached" is said once', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Support' })).toBeVisible()
    await context.setOffline(true)
    await page.getByRole('link', { name: 'Support' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('rsc-brain could not be reached')
    await expect(alert.getByText(/could not be reached/i)).toHaveCount(1)
    await context.setOffline(false)
  })

  // PR18 replaced the placeholder of PR17 with the overview: what the brain holds and what happens today.
  test('a brain page is its overview: what it holds and what happens today', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'In numbers' })).toBeVisible()
    await expect(page.getByRole('region', { name: "Today's sessions" })).toBeVisible()
  })
})
