import { expect, noSideScroll, scenario, test } from './fixture.ts'

test('switches a sign-in error without clearing the form and remembers Spanish on a phone', async ({
  context,
  baseURL,
  page,
}) => {
  await scenario(context, baseURL as string, 'signed-out')
  await page.setViewportSize({ width: 344, height: 740 })
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill('eric@example.test')
  await page.getByLabel('Password').fill('wrong password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('The email or the password is not right.')
  await page.getByRole('button', { name: 'Spanish' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('El correo o la contraseña son incorrectos.')
  await expect(page.locator('input[name="email"]')).toHaveValue('eric@example.test')
  await noSideScroll(page)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
})

test('changes language in the account menu and keeps the Spanish rail within its desktop column', async ({
  context,
  baseURL,
  page,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await page.getByRole('button', { name: /Account/ }).click()
  await page.getByRole('button', { name: 'Spanish' }).click()
  await expect(page.getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('link', { name: 'Descripción general' })).toBeVisible()
  await page.keyboard.press('Escape')
  const rail = page.locator('header.rail')
  const widths = await rail.evaluate((el) => ({ viewport: el.clientWidth, content: el.scrollWidth }))
  expect(widths.content).toBeLessThanOrEqual(widths.viewport)
  await noSideScroll(page)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Descripción general' })).toBeVisible()
})

test('shows a duplicate brain refusal beside the address in Spanish and keeps the typed name', async ({
  context,
  baseURL,
  page,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await page.getByRole('button', { name: /Account/ }).click()
  await page.getByRole('button', { name: 'Spanish' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Crear un cerebro' }).click()
  const dialog = page.getByRole('dialog', { name: 'Crear un cerebro' })
  await dialog.getByLabel('Nombre').fill('Growth')
  await dialog.getByRole('button', { name: 'Crear un cerebro' }).click()
  await expect(
    dialog.getByText('Ya existe un cerebro con la dirección «growth». Elige otro nombre.'),
  ).toBeVisible()
  await expect(dialog.locator('input[name="slug"]')).toBeFocused()
  await expect(dialog.getByLabel('Nombre')).toHaveValue('Growth')
})
