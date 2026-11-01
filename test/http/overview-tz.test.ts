// Review of PR26: the day of the session a key gets by writing without opening one is the same in the
// overview as in the journal, also where the server's time zone is ahead of UTC (pg reads a date as local
// midnight; turning it into an ISO instant moved it to the day before).
process.env.TZ = 'Europe/Madrid'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('the day of a session, east of UTC (TZ=Europe/Madrid)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }

  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'tz' })).status, 201)
    const r = await w.call(eric.key, 'POST', '/v1/brains/tz/entries', {
      type: 'learning',
      title: 'No session opened',
      content: 'Written without opening a session.',
    })
    assert.equal(r.status, 201, r.text)
  })
  after(async () => w.close())

  it('the overview says the same day as the journal', async () => {
    assert.equal(new Date(2026, 9, 29).getTimezoneOffset(), -60, 'this file runs in Madrid time')
    const o = await w.call(eric.key, 'GET', '/v1/brains/tz/overview')
    const s = await w.call(eric.key, 'GET', '/v1/brains/tz/sessions')
    const fromOverview = (o.body.todaySessions as Array<{ day: string | null }>)[0]?.day
    const fromJournal = (s.body.items as Array<{ day: string | null }>)[0]?.day
    assert.ok(fromJournal, 'a session of the day')
    assert.equal(fromOverview, fromJournal)
  })
})
