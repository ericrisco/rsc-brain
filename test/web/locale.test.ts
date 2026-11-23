import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError } from '../../web/src/api/client.ts'
import { confirmProblem } from '../../web/src/lib/backups.ts'
import { preferredLocale, setLocale } from '../../web/src/locale.ts'
import { localizeMessage, T } from '../../web/src/text.ts'

afterEach(() => setLocale('en'))

test('uses the first supported browser language and accepts regional variants', () => {
  assert.equal(preferredLocale(['en-US', 'es']), 'en')
  assert.equal(preferredLocale(['fr', 'es-MX', 'en']), 'es')
  assert.equal(preferredLocale(['et', 'fr']), 'en')
})

test('keeps names, command identifiers and confirmation text literal in Spanish', () => {
  setLocale('es')
  assert.equal(confirmProblem('', 'Home'), 'Escribe el nombre de esta instalación: Home')
  assert.equal(T.proposals.byline(null, 'Search'), 'Search')
  assert.equal(localizeMessage('constructor'), 'constructor')
  assert.equal(
    T.home.welcome([
      { name: 'Sales', role: 'reader' },
      { name: 'Home', role: 'curator' },
    ]),
    'Te damos la bienvenida. Formas parte de Sales como lector y Home como curador.',
  )
  assert.equal(T.home.welcome([]), 'Te damos la bienvenida. Tu cuenta está lista.')
  assert.equal(T.settings.removeFrom('One from Two', 'Home'), 'Eliminar One from Two de Home')
  assert.match(T.health.maintenanceAsk('Home'), /brain_health.*brain_propose.*brain_write/)
})

test('formats Spanish counts, grammatical branches and dates without breaking English output', () => {
  setLocale('es')
  assert.equal(T.home.size(1, 1), '1 página · 1 entrada')
  assert.deepEqual(T.overview.pages(1234), ['1.234', 'páginas'])
  assert.equal(T.graph.count(5000, 5000), '5.000 páginas')
  assert.equal(T.search.results(2, false), '2 resultados')
  assert.match(T.activity.newWaiting('24'), /24 eventos nuevos/)
  assert.equal(T.dateTime(''), 'Fecha no válida UTC')
  setLocale('en')
  assert.equal(T.home.size(1, 1), '1 page · 1 entry')
})

test('already received errors track the selected language and preserve the machine-readable source', () => {
  const why = 'A password has 12 to 200 characters.'
  const err = new ApiError(400, 'invalid', why, 'Try again.', undefined, {
    problems: [{ op: 2, message: 'There is no entry "Home" in this brain.' }],
  })
  setLocale('es')
  assert.equal(err.rawMessage, why)
  assert.equal(err.message, 'La contraseña debe tener entre 12 y 200 caracteres.')
  assert.equal(err.howToProceed, 'Vuelve a intentarlo.')
  assert.equal(err.problems[0]?.message, 'No existe la entrada «Home» en este cerebro.')
  assert.equal(
    localizeMessage('Only the author of a proposal can replace it.'),
    'Solo quien creó una propuesta puede reemplazarla.',
  )
  setLocale('en')
  assert.equal(err.message, why)
})
