// Spec B6 «Estados en todas las pantallas» (T005): which state a screen is in follows from what it holds,
// and every state that is not the content says what happened and what to do — a refusal never leaves a
// blank page, and offline writes say why they are off.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError } from '../../web/src/api/client.ts'
import { errorView, viewState, writeBlocked } from '../../web/src/ui/state.ts'

const none = (d: { items: unknown[] }) => d.items.length === 0

describe('the state of a screen', () => {
  it('loading only while nothing is there yet', () => {
    assert.equal(viewState({ loading: true, data: undefined, online: true }), 'loading')
    // A reload keeps the content on screen: nothing jumps.
    assert.equal(viewState({ loading: true, data: { items: [1] }, online: true, isEmpty: none }), 'ready')
  })

  it('empty, or empty because of the filters', () => {
    assert.equal(viewState({ loading: false, data: { items: [] }, online: true, isEmpty: none }), 'empty')
    assert.equal(
      viewState({ loading: false, data: { items: [] }, online: true, isEmpty: none, filtered: true }),
      'filtered-empty',
    )
  })

  it('a refusal of access, offline, or another error, when there is nothing to show', () => {
    const at = (error: ApiError, online = true) =>
      viewState({ loading: false, data: undefined, error, online })
    assert.equal(at(new ApiError(403, 'forbidden', 'No.', 'Ask a curator.')), 'forbidden')
    assert.equal(at(new ApiError(404, 'not_found', 'No such brain.', 'Check the name.')), 'forbidden')
    assert.equal(at(new ApiError(0, 'offline', 'Unreachable.', 'Check the connection.')), 'offline')
    assert.equal(at(new ApiError(500, 'internal', 'Broken.', 'Try again.'), false), 'offline')
    assert.equal(at(new ApiError(500, 'internal', 'Broken.', 'Try again.')), 'error')
  })

  it('an error over content that is already there keeps the content', () => {
    const error = new ApiError(500, 'internal', 'Broken.', 'Try again.')
    assert.equal(
      viewState({ loading: false, data: { items: [1] }, error, online: true, isEmpty: none }),
      'ready',
    )
  })
})

describe('what a state says', () => {
  it('an error says what happened, how to proceed, and offers to try again', () => {
    const v = errorView(new ApiError(500, 'internal', 'Something went wrong (reference ab12).', 'Try again.'))
    assert.equal(v.message, 'Something went wrong (reference ab12).')
    assert.equal(v.howToProceed, 'Try again.')
    assert.equal(v.retry, true)
    assert.ok(v.title)
  })

  it('no access never ends in a blank: it says who to ask', () => {
    const v = errorView(
      new ApiError(
        404,
        'not_found',
        'There is no brain "acme", or you are not a member.',
        'Ask a curator of it.',
      ),
    )
    assert.equal(v.kind, 'forbidden')
    assert.equal(v.howToProceed, 'Ask a curator of it.')
    assert.equal(v.retry, false)
  })

  it('offline says so and offers to try again', () => {
    const v = errorView(new ApiError(0, 'offline', 'Brain could not be reached.', 'Check your connection.'))
    assert.equal(v.kind, 'offline')
    assert.equal(v.retry, true)
  })

  it('writes are off while offline or while the same action is in flight, with the reason', () => {
    assert.match(writeBlocked({ online: false, pending: false }) ?? '', /offline/i)
    assert.match(writeBlocked({ online: true, pending: true }) ?? '', /in progress|sending/i)
    assert.equal(writeBlocked({ online: true, pending: false }), null)
  })
})
