/**
 * ChangeOrder (Nachtrag) PDF generator.
 *
 * A Nachtrag is a priced, customer-acceptable amendment to an existing job —
 * a first-class commercial document. It is simpler than an Offer (single
 * scope change + delta amount, no line-item table), so this mirrors the lean
 * jsPDF pattern of `src/lib/offers/pdf/generateOfferPdf.ts` rather than the
 * full §14 invoice renderer.
 *
 * The ChangeOrder entity carries no name/project snapshots, so party + project
 * context is enriched from the source Offer (craftsmanNameSnapshot,
 * projectTitleSnapshot, locationSnapshot) and the Job title when available.
 * The recipient still falls back to the customer UUID when no name snapshot
 * exists — same known limitation as the offer path (a frozen customer snapshot
 * is a separate data-model follow-up).
 */

import type { ChangeOrder } from '../types'
import type { Offer } from '../../offers/types'
import { shareOrDownloadPdf } from '../../pdf/shareOrDownloadPdf'
import {
  createCursor,
  ensureSpace,
  renderPageFooters,
  type PdfCursor,
} from '../../pdf/paginate'

// ── Layout constants (mirrors generateOfferPdf) ──────────────────────────────

const PAGE_MARGIN_X = 14
const PAGE_MARGIN_Y_TOP = 18
const LINE_HEIGHT = 5.2
const SECTION_GAP = 6
const BRAND_HEX = '#2563EB'

export interface ChangeOrderPdfContext {
  /** Original accepted offer — supplies party + project context + base total. */
  sourceOffer?: Offer | null
  /** Job being modified — supplies the reference title. */
  job?: { title?: string | null; description?: string | null } | null
  /**
   * Human-readable recipient name (thread display metadata). The ChangeOrder
   * itself only carries the customer's user id — a raw id must never appear
   * in the exported document; without a name the FÜR column is omitted.
   */
  customerName?: string | null
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatEur(cents: number | undefined): string {
  if (cents == null) return '—'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function formatDate(millis: number): string {
  return new Date(millis).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/** Splits the structured description (Leistung / Grund / Termin) the composer writes. */
function parseStructuredDescription(desc: string): {
  leistung: string
  ursache: string | null
  termin: string | null
} {
  const grundIdx = desc.indexOf('\n\nGrund: ')
  if (grundIdx === -1) return { leistung: desc, ursache: null, termin: null }
  const leistung = desc.slice(0, grundIdx)
  const rest = desc.slice(grundIdx + '\n\nGrund: '.length)
  const terminIdx = rest.indexOf('\n\nTermin: ')
  if (terminIdx === -1) return { leistung, ursache: rest, termin: null }
  return {
    leistung,
    ursache: rest.slice(0, terminIdx),
    termin: rest.slice(terminIdx + '\n\nTermin: '.length),
  }
}

// ── Draw helpers ─────────────────────────────────────────────────────────────

type DrawCtx = PdfCursor

function drawSection(ctx: DrawCtx, label: string, text: string): void {
  if (!text || text.length === 0) return
  ensureSpace(ctx, 14)
  ctx.doc.setFont('helvetica', 'bold')
  ctx.doc.setFontSize(9)
  ctx.doc.setTextColor(110, 110, 110)
  ctx.doc.text(label.toUpperCase(), PAGE_MARGIN_X, ctx.y)
  ctx.y += LINE_HEIGHT
  const wrapped = ctx.doc.splitTextToSize(text, ctx.pageWidth - PAGE_MARGIN_X * 2) as string[]
  ctx.doc.setFont('helvetica', 'normal')
  ctx.doc.setFontSize(10)
  ctx.doc.setTextColor(40, 40, 40)
  for (const line of wrapped) {
    ensureSpace(ctx, LINE_HEIGHT)
    ctx.doc.text(line, PAGE_MARGIN_X, ctx.y)
    ctx.y += LINE_HEIGHT
  }
  ctx.y += SECTION_GAP - 2
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateChangeOrderPdf(
  co: ChangeOrder,
  context: ChangeOrderPdfContext = {},
): Promise<Blob> {
  const { sourceOffer, job } = context
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const ctx: DrawCtx = createCursor({
    doc,
    marginX: PAGE_MARGIN_X,
    topY: PAGE_MARGIN_Y_TOP,
    marginBottom: 18,
  })

  // Header
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(BRAND_HEX)
  doc.text('NACHTRAG', PAGE_MARGIN_X, ctx.y)
  ctx.y += 9

  if (sourceOffer?.offerRef) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    doc.setTextColor(60, 60, 60)
    doc.text(`Bezug: Angebot ${sourceOffer.offerRef}`, PAGE_MARGIN_X, ctx.y)
    ctx.y += 6
  }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(90, 90, 90)
  doc.text(`Ausgestellt am ${formatDate(co.sentAt ?? co.createdAt)}`, PAGE_MARGIN_X, ctx.y)
  ctx.y += LINE_HEIGHT + SECTION_GAP

  // Parties — VON / FÜR. Raw user ids must never appear in the exported
  // document — each party column renders only when a display name exists.
  const providerName = sourceOffer?.craftsmanNameSnapshot?.trim() || null
  const customerName = context.customerName?.trim() || null
  const colWidth = (pageWidth - PAGE_MARGIN_X * 2) / 2
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(110, 110, 110)
  if (providerName) doc.text('VON', PAGE_MARGIN_X, ctx.y)
  if (customerName) doc.text('FÜR', PAGE_MARGIN_X + colWidth, ctx.y)
  ctx.y += 5
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(0, 0, 0)
  if (providerName) doc.text(providerName, PAGE_MARGIN_X, ctx.y)
  if (customerName) doc.text(customerName, PAGE_MARGIN_X + colWidth, ctx.y)
  ctx.y += 7

  const projectLine = [sourceOffer?.projectTitleSnapshot, sourceOffer?.locationSnapshot]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' · ')
  const referenceLine = projectLine || job?.title || job?.description
  if (referenceLine) {
    doc.setFontSize(10)
    doc.setTextColor(80, 80, 80)
    doc.text(`Bezugsauftrag: ${referenceLine}`, PAGE_MARGIN_X, ctx.y)
    ctx.y += 5
  }
  ctx.y += SECTION_GAP

  // Scope change
  const parsed = parseStructuredDescription(co.description)
  drawSection(ctx, 'Leistungsänderung', parsed.leistung)
  if (parsed.ursache) drawSection(ctx, 'Grund', parsed.ursache)
  if (parsed.termin) drawSection(ctx, 'Terminauswirkung', parsed.termin)

  // Amount block
  ensureSpace(ctx, 30)
  doc.setDrawColor(60, 60, 60)
  doc.line(PAGE_MARGIN_X, ctx.y, pageWidth - PAGE_MARGIN_X, ctx.y)
  ctx.y += 5

  const rightX = pageWidth - PAGE_MARGIN_X - 5
  if (co.grossTotal != null) {
    // Only show the Netto + MwSt breakdown when both are present — the
    // production composer path sets grossTotal only, so rendering "Netto —,
    // MwSt —" would put two em-dashes on a customer-facing document. Mirrors
    // ChangeOrderDetailScreen's gated Steuerinfo block.
    const rows: Array<{ label: string; value: string; bold?: boolean }> = []
    if (co.netTotal != null) {
      rows.push({ label: 'Nachtrag Netto', value: formatEur(co.netTotal) })
      rows.push({
        label: co.vatRate != null ? `MwSt ${co.vatRate} %` : 'MwSt',
        value: formatEur(co.grossTotal - co.netTotal),
      })
    }
    rows.push({ label: 'Nachtragsbetrag', value: formatEur(co.grossTotal), bold: true })
    for (const row of rows) {
      ensureSpace(ctx, LINE_HEIGHT)
      doc.setFont('helvetica', row.bold ? 'bold' : 'normal')
      doc.setFontSize(row.bold ? 12 : 10)
      doc.setTextColor(0, 0, 0)
      doc.text(row.label, PAGE_MARGIN_X, ctx.y)
      doc.text(row.value, rightX, ctx.y, { align: 'right' })
      ctx.y += row.bold ? LINE_HEIGHT + 1 : LINE_HEIGHT
    }
    // New total = base offer + delta, when both known.
    if (sourceOffer?.grossTotal != null) {
      ctx.y += 1
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(90, 90, 90)
      doc.text('Neuer Gesamtbetrag (Auftrag + Nachtrag)', PAGE_MARGIN_X, ctx.y)
      doc.text(formatEur(sourceOffer.grossTotal + co.grossTotal), rightX, ctx.y, { align: 'right' })
      ctx.y += LINE_HEIGHT
    }
  } else {
    // No structured amount — fall back to the human-readable price string.
    ensureSpace(ctx, LINE_HEIGHT)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(0, 0, 0)
    doc.text('Nachtragsbetrag', PAGE_MARGIN_X, ctx.y)
    doc.text(co.price, rightX, ctx.y, { align: 'right' })
    ctx.y += LINE_HEIGHT + 1
  }

  // Per-page footer (Seite X von Y) — shared with the offer/invoice generators.
  const footerY = ctx.pageHeight - 10
  renderPageFooters(ctx, (page, pageCount) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(140, 140, 140)
    doc.text(`SaFix · Nachtrag ${co.id}`, PAGE_MARGIN_X, footerY)
    doc.text(`Seite ${page} von ${pageCount}`, pageWidth - PAGE_MARGIN_X, footerY, {
      align: 'right',
    })
  })
  doc.setTextColor(0, 0, 0)

  return doc.output('blob')
}

export function changeOrderPdfFilename(co: ChangeOrder): string {
  return `Nachtrag-${co.id.slice(0, 8)}.pdf`
}

/**
 * Generate + hand to the platform (native share sheet / web download).
 * Mirrors shareOrDownloadOfferPdf via the shared delivery helper.
 */
export async function shareOrDownloadChangeOrderPdf(
  co: ChangeOrder,
  context: ChangeOrderPdfContext = {},
): Promise<void> {
  const blob = await generateChangeOrderPdf(co, context)
  await shareOrDownloadPdf(blob, changeOrderPdfFilename(co), 'Nachtrag teilen oder speichern')
}
