// Checks that close the web redesign (CA17b, CA19 at 200%, Annex C 3, 4 and 13, the tab rows of a phone).
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'
import { contrast } from './look.ts'
import { ROWS } from './screens.ts'

const alertOf = async (page: Page, path: string) => {
  await page.goto(path)
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  return alert.evaluate((el) => {
    // The elements, as a tree of tag, class and role: what is drawn, whatever the brain's address.
    const walk = (n: Element): string =>
      `${n.tagName.toLowerCase()}.${n.getAttribute('class') ?? ''}[${n.getAttribute('role') ?? ''}]` +
      `(${[...n.children].map(walk).join(',')})`
    return { tree: walk(el), text: (el as HTMLElement).textContent }
  })
}

test('CA17b: a brain one is not in and a brain that does not exist are the same screen, element by element', async ({
  page,
  context,
  baseURL,
}) => {
  // The administrator of a new installation is in no brain: Growth exists, and is one they are not in.
  await scenario(context, baseURL as string, 'alone')
  const notIn = await alertOf(page, '/b/growth')
  const nowhere = await alertOf(page, '/b/no-such-brain-at-all')
  expect(notIn.tree).toBe(nowhere.tree)
  expect(notIn.text).toBe(nowhere.text)
  // It names nobody: no person and no address of one.
  expect(nowhere.text).not.toMatch(/@|Eric|Ana\b/)
})

// CA19: at 200% zoom (a 1440 window is 720 CSS pixels wide) nothing scrolls sideways and no text is cut off.
const ZOOMED = ['home', 'overview', 'page', 'proposals', 'proposal', 'graph', 'admin · limits']
for (const name of ZOOMED)
  test(`CA19: at 200% zoom, ${name} has no sideways scroll and nothing clipped`, async ({
    page,
    context,
    baseURL,
  }) => {
    const row = ROWS.find((r) => r.name === name)
    if (!row) throw new Error(`no row ${name}`)
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 720, height: 450 })
    await page.goto(row.path)
    await expect(row.ready(page)).toBeVisible()
    await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    const r = await page.evaluate(() => {
      const doc = document.documentElement
      const main = document.querySelector('main') as HTMLElement
      const clipped: string[] = []
      for (const el of main.querySelectorAll<HTMLElement>('*')) {
        const cs = getComputedStyle(el)
        if (
          cs.display === 'none' ||
          el.closest('.sr-only, canvas, [data-scroll-x], .table-wrap, .table-scroll, pre')
        )
          continue
        const hides = cs.overflowX === 'hidden' || cs.overflowX === 'clip'
        if (hides && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
          clipped.push(`${el.tagName.toLowerCase()}.${el.className}`)
      }
      return { page: doc.scrollWidth - doc.clientWidth, sheet: main.scrollWidth - main.clientWidth, clipped }
    })
    expect(r.page, 'the page scrolls sideways').toBeLessThanOrEqual(0)
    expect(r.sheet, 'the sheet scrolls sideways').toBeLessThanOrEqual(1)
    expect(r.clipped, 'text is cut off').toEqual([])
  })

// Annex C 3: a zero is written as 0, and a datum that is absent is a grey dash; no screen shows a hole or a
// programmer's word in place of a figure.
test('Annex C 3: figures are never blank or "null", and an absent datum is a grey dash', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  let dashes = 0
  for (const row of ROWS.filter((r) => !r.preset)) {
    await page.goto(row.path)
    await expect(row.ready(page)).toBeVisible()
    await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
    const r = await page.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement
      const text = main.textContent
      const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()
      const probe = Object.assign(document.createElement('span'), { style: `color:${muted}` })
      document.body.append(probe)
      const mutedRgb = getComputedStyle(probe).color
      probe.remove()
      const figures = [...main.querySelectorAll<HTMLElement>('td.num, .tile .figure, .figure, dd.num')]
      const blanks = figures.filter((f) => !f.textContent?.trim()).length
      const dash = [...main.querySelectorAll<HTMLElement>('td, dd, span')].filter(
        (e) => e.children.length === 0 && e.textContent?.trim() === '—',
      )
      return {
        words: /\b(null|undefined|NaN)\b/.test(text),
        blanks,
        dashes: dash.length,
        wrongDash: dash.filter((e) => getComputedStyle(e).color !== mutedRgb).length,
      }
    })
    expect(r.words, `${row.name} shows null, undefined or NaN`).toBe(false)
    expect(r.blanks, `${row.name} has an empty figure`).toBe(0)
    expect(r.wrongDash, `${row.name} has a dash that is not grey`).toBe(0)
    dashes += r.dashes
  }
  expect(dashes, 'some screen of the matrix shows an absent datum').toBeGreaterThan(0)
})

// Annex C 4: one red mark per object: a row, a card or a state carries at most one thing in the negative colour.
test('Annex C 4: no row, card or state holds two red marks', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  for (const theme of ['light', 'dark'])
    for (const row of ROWS.filter((r) => !r.preset)) {
      await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
      await page.goto(row.path)
      await expect(row.ready(page)).toBeVisible()
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
      const worst = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement)
        const colour = (v: string) => {
          const p = Object.assign(document.createElement('span'), {
            style: `color:${css.getPropertyValue(v)}`,
          })
          document.body.append(p)
          const c = getComputedStyle(p).color
          p.remove()
          return c
        }
        const red = new Set([colour('--negative'), colour('--pill-negative-ink')])
        const redGround = colour('--pill-negative-bg')
        const isRed = (e: Element) => {
          const cs = getComputedStyle(e)
          return (
            (red.has(cs.color) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) ||
            cs.backgroundColor === redGround
          )
        }
        let top = { n: 0, where: '' }
        for (const o of document.querySelectorAll(
          'main li, main tr, main .card, main .state, main .op-card',
        )) {
          // Marks of this object, not of an object nested in it.
          const mine = [o, ...o.querySelectorAll('*')].filter(
            (e) => isRed(e) && e.closest('li, tr, .card, .state, .op-card') === o,
          )
          // A pill and the word inside it are one mark.
          const marks = mine.filter(
            (e) =>
              !mine.some(
                (m) => m !== e && m.contains(e) && getComputedStyle(m).backgroundColor === redGround,
              ),
          )
          if (marks.length > top.n)
            top = { n: marks.length, where: `${o.tagName.toLowerCase()}.${o.className}` }
        }
        return top
      })
      expect(worst.n, `${row.name} (${theme}): ${worst.where}`).toBeLessThanOrEqual(1)
    }
})

// Annex C 13: a logo that is light and one that is dark both show on the frame: the logo sits on a plate with an
// edge that reads at 3:1 against the frame, in each mode.
function png(rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const w = 16
  const raw = Buffer.concat(
    Array.from({ length: w }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]),
    ),
  )
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(w, 4)
  head.set([8, 2, 0, 0, 0], 8)
  // zlib "stored" block: no compression needed for a picture this small.
  const stored = Buffer.concat([Buffer.from([0x78, 0x01, 0x01]), Buffer.alloc(4), raw])
  stored.writeUInt16LE(raw.length, 3)
  stored.writeUInt16LE(~raw.length & 0xffff, 5)
  let a = 1
  let b = 0
  for (const x of raw) {
    a = (a + x) % 65521
    b = (b + a) % 65521
  }
  const adler = Buffer.alloc(4)
  adler.writeUInt32BE(((b << 16) | a) >>> 0)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', Buffer.concat([stored, adler])),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const theme of ['light', 'dark', 'contrast'] as const)
  for (const [kind, rgb] of [
    ['dark', [10, 10, 12]],
    ['light', [250, 250, 250]],
  ] as const)
    test(`Annex C 13: a ${kind} logo shows on the frame in ${theme}`, async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
      await page.route('**/v1/branding', async (route) => {
        const res = await route.fetch()
        const body = (await res.json()) as Record<string, unknown>
        await route.fulfill({
          response: res,
          json: { ...body, logo: { url: '/logo-test.png', updatedAt: '2026-10-01T10:00:00.000Z' } },
        })
      })
      await page.route('**/logo-test.png', (route) =>
        route.fulfill({ contentType: 'image/png', body: png([...rgb] as [number, number, number]) }),
      )
      await page.goto('/b/growth')
      const logo = page.locator('header.rail .brand img')
      await expect(logo).toBeVisible()
      const v = await logo.evaluate((el) => {
        const cs = getComputedStyle(el)
        return {
          edge: cs.borderTopColor,
          edgeW: Number.parseFloat(cs.borderTopWidth),
          plate: cs.backgroundColor,
          frame: getComputedStyle(document.body).backgroundColor,
        }
      })
      // The logo's own pixels against its plate: read from a picture of the logo's box.
      await expect(logo).toHaveAttribute('data-tone', /light|dark/)
      const shot = (await logo.screenshot()).toString('base64')
      const px = await page.evaluate(async (shot) => {
        const img = new Image()
        img.src = `data:image/png;base64,${shot}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d') as CanvasRenderingContext2D
        ctx.drawImage(img, 0, 0)
        const at = (x: number, y: number) => {
          const d = ctx.getImageData(x, y, 1, 1).data
          return `rgb(${d[0]}, ${d[1]}, ${d[2]})`
        }
        const s = img.width
        // The plate: the padding inside the border; the logo: the middle.
        return { plate: at(Math.floor(s / 2), 2), logo: at(Math.floor(s / 2), Math.floor(s / 2)) }
      }, shot)
      expect(
        contrast(px.logo, px.plate),
        `the logo ${px.logo} against its plate ${px.plate}`,
      ).toBeGreaterThanOrEqual(3)
      expect(v.edgeW).toBeGreaterThanOrEqual(1)
      expect(contrast(v.edge, v.frame), 'the plate edge against the frame').toBeGreaterThanOrEqual(3)
      expect(v.plate).not.toBe('rgba(0, 0, 0, 0)')
    })

// A phone: each row of tabs stays on one line and slides sideways; the current tab is in view.
for (const name of ['proposals', 'admin · people', 'settings · archive', 'page', 'sessions'])
  test(`a phone: the tabs of ${name} are one line and the current one is in view`, async ({
    page,
    context,
    baseURL,
  }) => {
    const row = ROWS.find((r) => r.name === name)
    if (!row) throw new Error(`no row ${name}`)
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(row.path)
    await expect(row.ready(page)).toBeVisible()
    await page.waitForLoadState('networkidle')
    // The row brings the current tab into view a frame or two after it appears.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const nav = document.querySelector('nav.tabs') as HTMLElement
          const cur = nav.querySelector('[aria-current]')?.getBoundingClientRect()
          const box = nav.getBoundingClientRect()
          return cur ? cur.left >= box.left - 1 && cur.right <= box.right + 1 : true
        }),
      )
      .toBe(true)
    const r = await page.evaluate(() => {
      const nav = document.querySelector('nav.tabs') as HTMLElement
      const links = [...nav.querySelectorAll<HTMLElement>('a')]
      const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)))
      const cur = nav.querySelector('[aria-current]')?.getBoundingClientRect()
      const box = nav.getBoundingClientRect()
      return {
        lines: tops.size,
        overflowing: nav.scrollWidth > nav.clientWidth + 1,
        more: nav.hasAttribute('data-more'),
        moreRight: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1,
        inView: cur ? cur.left >= box.left - 1 && cur.right <= box.right + 1 : true,
      }
    })
    expect(r.lines).toBe(1)
    expect(r.inView).toBe(true)
    // When there is more to the right, the row says so.
    expect(r.more, 'the row says so while there is more to the right').toBe(r.moreRight)
  })
