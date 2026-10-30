// Spec B6 «Admin › Branding» and plan §3.5 G1, G2: the name and logo of the installation are public — the
// sign-in page and an invitation show them before anyone has a key — and they answer before the
// first-time setup, so the web can lead to it. Uploading a logo arrives with G3 (plan T045): until then
// there is no logo, and the logo address says so with a way out.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('branding of the installation', { skip: skipPg }, () => {
  let fresh: World
  let ready: World
  before(async () => {
    fresh = await world({ fresh: true })
    ready = await world()
  })
  after(async () => {
    await fresh.close()
    await ready.close()
  })

  it('G1: before the setup, it answers without a key and says the setup is pending', async () => {
    const r = await fresh.raw('GET', '/v1/branding')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body, { name: '', logo: null, setupRequired: true })
    assert.equal(r.headers.get('cache-control'), 'no-store')
  })

  it('G1: once set up, it gives the name of the installation', async () => {
    const r = await ready.raw('GET', '/v1/branding')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body, { name: 'Test', logo: null, setupRequired: false })
  })

  it('G1: a key is not needed, and a bad one is not looked at', async () => {
    const r = await ready.raw('GET', '/v1/branding', { headers: { authorization: 'Bearer rscb_nothing' } })
    assert.equal(r.status, 200, r.text)
  })

  it('G2: without a logo, the logo address is a 404 that says how to add one, before and after the setup', async () => {
    for (const w of [fresh, ready]) {
      const r = await w.raw('GET', '/v1/branding/logo')
      assert.equal(r.status, 404, r.text)
      assert.equal(r.body.error?.code, 'no_logo')
      assert.match(r.body.error?.howToProceed ?? '', /administration/i)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    }
  })

  it('G1 and G2 are read-only: writing to them is not allowed', async () => {
    const r = await ready.raw('PUT', '/v1/branding', { body: { name: 'Mine' } })
    assert.equal(r.status, 405, r.text)
  })
})
