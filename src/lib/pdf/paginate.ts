/**
 * Shared PDF pagination primitives.
 *
 * Every FixUp PDF generator (invoice §14 renderer, offer/KV/diagnosis, change
 * order) lays content out top-down on A4 and must never silently clip a block
 * off the bottom of the sheet — for invoices that is a §14-UStG correctness
 * defect (a dropped Gesamtbetrag or Steueraufstellung), for offers/Nachträge a
 * trust defect. Each generator previously carried its own `newPageIfNeeded`
 * copy and only stamped a footer once on the final page, so multi-page
 * documents lost their page numbers.
 *
 * This module is the single source of truth for the layout cursor, the
 * anti-clip page-break, line-by-line text flow (so an arbitrarily long block
 * can never overflow), and the per-page footer pass. It is the pagination
 * sibling of `shareOrDownloadPdf.ts` (shared delivery).
 *
 * Pure layout math + jsPDF calls — no Storage, no DOM, no Browser APIs.
 */

import type { jsPDF } from 'jspdf'

/** Mutable layout cursor threaded through a paginated render. */
export interface PdfCursor {
  doc: jsPDF
  /** Current vertical write position in mm. */
  y: number
  /** Page width in mm (cached — constant across A4 pages). */
  pageWidth: number
  /** Page height in mm (cached). */
  pageHeight: number
  /** Left/right content margin in mm. */
  marginX: number
  /** Keep-clear band at the bottom; footers live below it. */
  marginBottom: number
  /** Y the cursor resets to at the top of a fresh page. */
  topY: number
}

export interface PdfCursorInit {
  doc: jsPDF
  marginX: number
  topY: number
  /** Defaults to 16mm — enough room for the per-page footer. */
  marginBottom?: number
}

/** Builds a cursor, caching the page geometry from the jsPDF instance. */
export function createCursor(init: PdfCursorInit): PdfCursor {
  const { doc, marginX, topY, marginBottom = 16 } = init
  return {
    doc,
    y: topY,
    pageWidth: doc.internal.pageSize.getWidth(),
    pageHeight: doc.internal.pageSize.getHeight(),
    marginX,
    marginBottom,
    topY,
  }
}

/**
 * Reserve `needed` mm of vertical space. If it would overflow the bottom
 * margin, start a new page, reset the cursor to the top, and (optionally)
 * re-emit a header — e.g. a table's column row — on the fresh page. Returns
 * true when a page break happened.
 *
 * This is the core anti-clip primitive: every block that writes downward calls
 * this first, so content is never silently pushed off the sheet regardless of
 * line-item count, wrapped-text length, or totals-block height.
 */
export function ensureSpace(
  cursor: PdfCursor,
  needed: number,
  onNewPage?: (cursor: PdfCursor) => void,
): boolean {
  if (cursor.y + needed <= cursor.pageHeight - cursor.marginBottom) return false
  cursor.doc.addPage()
  cursor.y = cursor.topY
  onNewPage?.(cursor)
  return true
}

/**
 * Flow pre-wrapped text lines down the page, breaking across pages
 * line-by-line, so an arbitrarily long block (terms, legal notes, scope text)
 * can never be clipped. `draw(line, y)` paints one line at the given y;
 * `lineHeight` advances the cursor. `onNewPage` re-emits any header after a
 * break.
 */
export function flowLines(
  cursor: PdfCursor,
  lines: string[],
  lineHeight: number,
  draw: (line: string, y: number) => void,
  onNewPage?: (cursor: PdfCursor) => void,
): void {
  for (const line of lines) {
    ensureSpace(cursor, lineHeight, onNewPage)
    draw(line, cursor.y)
    cursor.y += lineHeight
  }
}

/**
 * After the body is laid out and the final page count is known, paint a footer
 * on every page. `draw(pageNumber, pageCount)` runs once per page with the doc
 * already positioned on that page. Restores the active page to the last one.
 */
export function renderPageFooters(
  cursor: PdfCursor,
  draw: (pageNumber: number, pageCount: number) => void,
): void {
  const pageCount = cursor.doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p += 1) {
    cursor.doc.setPage(p)
    draw(p, pageCount)
  }
}
