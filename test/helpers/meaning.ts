// A provider of meaning for the tests only: deterministic, no network. Words map to a few concepts, so
// "audience drop-off" is close to a page about retention, and "voice" to "voces". It records what it
// was sent, and can be made to fail.
import { normalise, type Provider } from '../../src/meaning/providers.ts'

const CONCEPTS: Record<string, number> = {
  retention: 0,
  retain: 0,
  retener: 0,
  stay: 0,
  stays: 0,
  drop: 0,
  dropoff: 0,
  audience: 1,
  viewers: 1,
  publico: 1,
  voice: 2,
  voices: 2,
  voces: 2,
  voz: 2,
  narrator: 2,
  logo: 3,
  brand: 3,
}

export type FakeProvider = Provider & { sent: string[]; failing: boolean; calls: number }

export function fakeProvider(name = 'test', model = 'fake-1'): FakeProvider {
  const p: FakeProvider = {
    name,
    model,
    sent: [],
    failing: false,
    calls: 0,
    async embed(texts) {
      p.calls += 1
      if (p.failing) throw new Error('provider down')
      p.sent.push(...texts)
      return texts.map((t) => {
        const v = new Array(32).fill(0)
        const words = t
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
        let any = false
        for (const w of words) {
          const c = CONCEPTS[w]
          if (c !== undefined) {
            v[c] += 1
            any = true
          }
        }
        // A text with none of the concepts points somewhere of its own, away from them.
        if (!any) v[8 + (t.length % 24)] = 1
        return normalise(v)
      })
    },
  }
  return p
}
