/**
 * Shared PDF pagination primitives — invariant tests.
 *
 * Das System verspricht: „content is never silently pushed off the sheet
 * regardless of line-item count, wrapped-text length, or totals-block height".
 * Diese Tests prüfen genau diese Garantie auf Primitiv-Ebene (echtes jsPDF):
 * KEIN Draw landet je unterhalb des druckbaren Bandes (pageHeight − marginBottom),
 * egal wie lang die Eingabe — der diskriminierende Beweis gegen den §14-Clip,
 * den eine reine String-im-Stream-Prüfung NICHT fangen kann.
 */

import { describe, it, expect } from 'vitest'
import { jsPDF } from 'jspdf'
import {
  createCursor,
  ensureSpace,
  flowLines,
  renderPageFooters,
} from '../../../src/lib/pdf/paginate'

function freshCursor(marginBottom = 16, topY = 22) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  return createCursor({ doc, marginX: 14, topY, marginBottom })
}

describe('createCursor', () => {
  it('caches A4 geometry + starts at topY', () => {
    const c = freshCursor()
    expect(Math.round(c.pageWidth)).toBe(210)
    expect(Math.round(c.pageHeight)).toBe(297)
    expect(c.y).toBe(22)
  })
})

describe('ensureSpace', () => {
  it('does not break when the content fits', () => {
    const c = freshCursor()
    expect(ensureSpace(c, 10)).toBe(false)
    expect(c.y).toBe(22)
  })

  it('breaks + resets to topY when the content would overflow the band', () => {
    const c = freshCursor()
    c.y = 290 // below the 281mm band
    expect(ensureSpace(c, 10)).toBe(true)
    expect(c.y).toBe(c.topY)
  })

  it('runs the onNewPage callback exactly on a break', () => {
    const c = freshCursor()
    let calls = 0
    c.y = 290
    ensureSpace(c, 10, () => { calls += 1 })
    expect(calls).toBe(1)
    ensureSpace(c, 10, () => { calls += 1 }) // fits now → no call
    expect(calls).toBe(1)
  })

  it('INVARIANT: a long draw loop never positions content below the printable band', () => {
    const c = freshCursor()
    const band = c.pageHeight - c.marginBottom
    const ys: number[] = []
    for (let i = 0; i < 400; i += 1) {
      ensureSpace(c, 5)
      ys.push(c.y) // the y a caller would draw at
      c.y += 5
    }
    expect(Math.max(...ys)).toBeLessThanOrEqual(band)
    expect(c.doc.getNumberOfPages()).toBeGreaterThan(1)
  })
})

describe('flowLines', () => {
  it('INVARIANT: arbitrarily long text never draws below the band', () => {
    const c = freshCursor()
    const band = c.pageHeight - c.marginBottom
    const drawnYs: number[] = []
    const lines = Array.from({ length: 500 }, (_, i) => `Zeile ${i}`)
    flowLines(c, lines, 4, (_line, y) => { drawnYs.push(y) })
    expect(drawnYs).toHaveLength(500)
    expect(Math.max(...drawnYs)).toBeLessThanOrEqual(band)
    expect(c.doc.getNumberOfPages()).toBeGreaterThan(1)
  })

  it('re-emits a header on each page break', () => {
    const c = freshCursor()
    let headerCount = 0
    const lines = Array.from({ length: 200 }, (_, i) => `Z${i}`)
    flowLines(c, lines, 4, () => {}, () => { headerCount += 1 })
    // 200 lines × 4mm spans multiple pages → at least one re-emit.
    expect(headerCount).toBeGreaterThanOrEqual(1)
    expect(headerCount).toBe(c.doc.getNumberOfPages() - 1)
  })
})

describe('renderPageFooters', () => {
  it('draws once per page with the true page count + leaves the last page active', () => {
    const c = freshCursor()
    c.doc.addPage()
    c.doc.addPage() // 3 pages total
    const seen: Array<[number, number]> = []
    renderPageFooters(c, (page, pageCount) => { seen.push([page, pageCount]) })
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]])
    expect(c.doc.getCurrentPageInfo().pageNumber).toBe(3)
  })
})
