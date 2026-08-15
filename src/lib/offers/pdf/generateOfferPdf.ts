/**
 * Offer-PDF Generator — Spatial C-10 · C10.8
 *
 * Client-side PDF builder for `Offer` records. Pattern mirrors
 * `src/lib/invoices/artifactGenerator.ts` (jsPDF) but leaner — an Offer is a
 * pre-contractual price proposal, not a §14-UStG invoice, so the layout
 * focuses on:
 *   - Brand-style header (Angebot / Kostenvoranschlag, anchored to documentType).
 *   - Provider snapshot (craftsmanNameSnapshot) + Customer recipient block.
 *   - Offer reference + issue date + optional valid-until.
 *   - Scope: scopeSummary, scopeIncluded, scopeExcluded, assumptions.
 *   - Line-items table (label / qty / unit / net) summed to net / VAT / gross.
 *   - Optional Spatial-Origin badge ("Vom 3D-Aufmaß erstellt") when
 *     `isSpatialOffer(offer)`.
 *   - Footer with offer.id (audit trail) + brand label.
 *
 * V1 scope: client-only Blob — caller decides whether to trigger a download,
 * attach to email, or hand to a future server-side upload. No Storage write
 * here. The `offer.pdf_url` column (added in migration 20260523120055)
 * remains NULL until Phase 2's storage path lands.
 */

import type { Offer } from '../types'
import { isSpatialOffer } from '../types'
import { isNative } from '../../platform'
import {
  createCursor,
  ensureSpace,
  renderPageFooters,
  type PdfCursor,
} from '../../pdf/paginate'

// ── Layout constants ─────────────────────────────────────────────────────────

const PAGE_MARGIN_X = 14
const PAGE_MARGIN_Y_TOP = 18
const LINE_HEIGHT = 5.2
const SECTION_GAP = 6
const BRAND_HEX = '#2563EB' // matches Tailwind brand

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

/** Plain DE-locale number (max 2 decimals) — for measurements, not money. */
function formatNum(n: number): string {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(n)
}

function documentTypeLabel(offer: Offer): string {
  if (offer.documentType === 'cost_estimate') return 'KOSTENVORANSCHLAG'
  if (offer.documentType === 'estimate') return 'SCHÄTZUNG'
  if (offer.documentType === 'diagnosis') return 'DIAGNOSE-AUFTRAG'
  // binding_offer is the V1 default
  return 'ANGEBOT'
}

/** Short noun form — for the footer + download filename (so a Kostenvoranschlag
 *  is not mislabeled as "Angebot"). */
function documentTypeNoun(offer: Offer): string {
  if (offer.documentType === 'cost_estimate') return 'Kostenvoranschlag'
  if (offer.documentType === 'estimate') return 'Schätzung'
  if (offer.documentType === 'diagnosis') return 'Diagnose-Auftrag'
  return 'Angebot'
}

export class OfferExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfferExportError'
  }
}

/** Mirrors the invoice export contract: a draft is not a sendable document. The
 *  missing-customer-snapshot guard is deferred with the snapshot data-model fix
 *  (blocking it now would regress offers that currently export with a UUID). */
function assertOfferExportable(offer: Offer): void {
  if (offer.status === 'draft') {
    throw new OfferExportError('Entwurf kann nicht exportiert werden — bitte das Angebot erst senden.')
  }
}

// ── Section helpers ──────────────────────────────────────────────────────────

type DrawCtx = PdfCursor

function drawTextLine(ctx: DrawCtx, text: string, opts?: { bold?: boolean; size?: number }): void {
  ctx.doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal')
  ctx.doc.setFontSize(opts?.size ?? 10)
  ctx.doc.setTextColor(0, 0, 0)
  ctx.doc.text(text, PAGE_MARGIN_X, ctx.y)
  ctx.y += LINE_HEIGHT
}

function drawHeader(ctx: DrawCtx, offer: Offer): void {
  ctx.doc.setFont('helvetica', 'bold')
  ctx.doc.setFontSize(22)
  ctx.doc.setTextColor(BRAND_HEX)
  ctx.doc.text(documentTypeLabel(offer), PAGE_MARGIN_X, ctx.y)
  ctx.y += 9

  if (offer.offerRef) {
    ctx.doc.setFont('helvetica', 'normal')
    ctx.doc.setFontSize(11)
    ctx.doc.setTextColor(60, 60, 60)
    ctx.doc.text(`Referenz: ${offer.offerRef}`, PAGE_MARGIN_X, ctx.y)
    ctx.y += 6
  }

  ctx.doc.setFont('helvetica', 'normal')
  ctx.doc.setFontSize(10)
  ctx.doc.setTextColor(90, 90, 90)
  const issueDate = formatDate(offer.sentAt ?? offer.createdAt)
  const validUntil = offer.validUntil ? ` · Gültig bis ${offer.validUntil}` : ''
  ctx.doc.text(`Ausgestellt am ${issueDate}${validUntil}`, PAGE_MARGIN_X, ctx.y)
  ctx.y += 4

  if (isSpatialOffer(offer)) {
    // Subtle brand-tone badge: "Vom 3D-Aufmaß erstellt"
    ctx.doc.setFillColor(239, 246, 255) // bg-blue-50
    ctx.doc.setTextColor(BRAND_HEX)
    ctx.doc.setFont('helvetica', 'bold')
    ctx.doc.setFontSize(9)
    const badgeText = 'Vom 3D-Aufmaß erstellt'
    const tw = ctx.doc.getTextWidth(badgeText)
    ctx.doc.roundedRect(PAGE_MARGIN_X, ctx.y, tw + 6, 5.5, 1.5, 1.5, 'F')
    ctx.doc.text(badgeText, PAGE_MARGIN_X + 3, ctx.y + 4)
    ctx.y += 9
  }

  ctx.y += SECTION_GAP
}

function drawParties(ctx: DrawCtx, offer: Offer, customerName?: string | null): void {
  const colWidth = (ctx.pageWidth - PAGE_MARGIN_X * 2) / 2

  // Raw user ids must never appear in the exported document — a party column
  // renders only when a human-readable name is available.
  const providerName = offer.craftsmanNameSnapshot?.trim() || null
  const recipientName = customerName?.trim() || null

  ctx.doc.setFont('helvetica', 'bold')
  ctx.doc.setFontSize(9)
  ctx.doc.setTextColor(110, 110, 110)
  if (providerName) ctx.doc.text('VON', PAGE_MARGIN_X, ctx.y)
  if (recipientName) ctx.doc.text('FÜR', PAGE_MARGIN_X + colWidth, ctx.y)
  ctx.y += 5

  ctx.doc.setFont('helvetica', 'normal')
  ctx.doc.setFontSize(11)
  ctx.doc.setTextColor(0, 0, 0)
  if (providerName) ctx.doc.text(providerName, PAGE_MARGIN_X, ctx.y)
  if (recipientName) ctx.doc.text(recipientName, PAGE_MARGIN_X + colWidth, ctx.y)
  ctx.y += 7

  if (offer.projectTitleSnapshot || offer.locationSnapshot) {
    ctx.doc.setFontSize(10)
    ctx.doc.setTextColor(80, 80, 80)
    const projectLine = [offer.projectTitleSnapshot, offer.locationSnapshot]
      .filter((s) => typeof s === 'string' && s.length > 0)
      .join(' · ')
    if (projectLine) {
      ctx.doc.text(`Projekt: ${projectLine}`, PAGE_MARGIN_X, ctx.y)
      ctx.y += 5
    }
  }

  ctx.y += SECTION_GAP
}

function drawScope(ctx: DrawCtx, offer: Offer): void {
  const scopeFields: Array<{ label: string; text?: string }> = [
    { label: 'Leistungsumfang', text: offer.scopeSummary ?? offer.description },
    { label: 'Inklusive', text: offer.scopeIncluded },
    { label: 'Nicht inklusive', text: offer.scopeExcluded },
    { label: 'Annahmen', text: offer.assumptions },
  ]
  let any = false
  for (const field of scopeFields) {
    if (!field.text || field.text.length === 0) continue
    any = true
    ensureSpace(ctx, 16)
    drawTextLine(ctx, field.label.toUpperCase(), { bold: true, size: 9 })
    const wrapped = ctx.doc.splitTextToSize(field.text, ctx.pageWidth - PAGE_MARGIN_X * 2)
    for (const line of wrapped as string[]) {
      ensureSpace(ctx, LINE_HEIGHT)
      ctx.doc.setFont('helvetica', 'normal')
      ctx.doc.setFontSize(10)
      ctx.doc.setTextColor(40, 40, 40)
      ctx.doc.text(line, PAGE_MARGIN_X, ctx.y)
      ctx.y += LINE_HEIGHT
    }
    ctx.y += 2
  }
  if (any) ctx.y += SECTION_GAP - 2
}

/**
 * Spatial aufmaß section — the floor-plan (drawn as jsPDF vector lines from the
 * normalised 0–100 ring, no raster) + a measurement table that makes the wall
 * net-area deduction (Brutto / −Öffnungen / Menge) explicit. Renders only when
 * the offer carries `spatial_metadata.aufmass`; a no-op otherwise. This is what
 * turns the Spatial-Offer from a bare price list into a document the customer
 * trusts ("das wurde gemessen").
 */
function drawAufmass(ctx: DrawCtx, offer: Offer): void {
  const aufmass = offer.spatialMetadata?.aufmass
  if (!aufmass) return

  ensureSpace(ctx, 24)
  drawTextLine(ctx, 'AUFMASS', { bold: true, size: 9 })

  // Room metrics line.
  ctx.doc.setFont('helvetica', 'normal')
  ctx.doc.setFontSize(10)
  ctx.doc.setTextColor(40, 40, 40)
  const metrics = [
    `Fläche ${formatNum(aufmass.areaM2)} m²`,
    `Volumen ${formatNum(aufmass.volumeM3)} m³`,
    `Raumhöhe ${formatNum(aufmass.ceilingHeightM)} m`,
    `Umfang ${formatNum(aufmass.perimeterM)} m`,
    `${aufmass.wallCount} Wände`,
  ].join('  ·  ')
  ctx.doc.text(metrics, PAGE_MARGIN_X, ctx.y)
  ctx.y += LINE_HEIGHT + 1

  // Floor-plan — normalised 0–100 ring scaled into a square box, vector lines.
  const poly = aufmass.floorPolygon
  if (poly.length >= 3) {
    const boxSize = 58 // mm
    ensureSpace(ctx, boxSize + 5)
    const boxX = PAGE_MARGIN_X
    const boxY = ctx.y
    const px = (p: { xPct: number; yPct: number }): number => boxX + (p.xPct / 100) * boxSize
    const py = (p: { xPct: number; yPct: number }): number => boxY + (p.yPct / 100) * boxSize
    ctx.doc.setDrawColor(BRAND_HEX)
    ctx.doc.setLineWidth(0.5)
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      ctx.doc.line(px(a), py(a), px(b), py(b))
    }
    ctx.doc.setLineWidth(0.2)
    ctx.y = boxY + boxSize + 4
  }

  // Measurement table.
  ensureSpace(ctx, 14)
  const cols = {
    label: PAGE_MARGIN_X,
    gross: ctx.pageWidth - PAGE_MARGIN_X - 68,
    deduct: ctx.pageWidth - PAGE_MARGIN_X - 38,
    net: ctx.pageWidth - PAGE_MARGIN_X - 5,
  }
  ctx.doc.setFont('helvetica', 'bold')
  ctx.doc.setFontSize(9)
  ctx.doc.setTextColor(110, 110, 110)
  ctx.doc.text('Fläche / Bauteil', cols.label, ctx.y)
  ctx.doc.text('Brutto', cols.gross, ctx.y, { align: 'right' })
  ctx.doc.text('- Öffn.', cols.deduct, ctx.y, { align: 'right' })
  // "Netto" (the measured net geometry) — deliberately distinct from the
  // POSITIONEN "Menge" column, which bills the effective/override quantity. When
  // a craftsman übermisst (gross), the two legitimately differ; the label makes
  // the AUFMASS table read as the measurement, not the billed amount.
  ctx.doc.text('Netto', cols.net, ctx.y, { align: 'right' })
  ctx.y += 4
  ctx.doc.setDrawColor(220, 220, 220)
  ctx.doc.line(PAGE_MARGIN_X, ctx.y, ctx.pageWidth - PAGE_MARGIN_X, ctx.y)
  ctx.y += 4

  ctx.doc.setFont('helvetica', 'normal')
  ctx.doc.setFontSize(10)
  ctx.doc.setTextColor(20, 20, 20)
  for (const m of aufmass.measurements) {
    ensureSpace(ctx, LINE_HEIGHT)
    const labelLines = ctx.doc.splitTextToSize(m.label, 75) as string[]
    ctx.doc.text(labelLines[0] ?? '', cols.label, ctx.y)
    if (m.kind === 'wall' && m.grossM2 != null) {
      ctx.doc.text(formatNum(m.grossM2), cols.gross, ctx.y, { align: 'right' })
      ctx.doc.text(m.openingsM2 ? formatNum(m.openingsM2) : '-', cols.deduct, ctx.y, { align: 'right' })
    } else {
      ctx.doc.text('-', cols.gross, ctx.y, { align: 'right' })
      ctx.doc.text('-', cols.deduct, ctx.y, { align: 'right' })
    }
    const unitLabel = m.unit === 'm2' ? 'm²' : 'lfm'
    ctx.doc.text(`${formatNum(m.value)} ${unitLabel}`, cols.net, ctx.y, { align: 'right' })
    ctx.y += LINE_HEIGHT
  }
  ctx.y += SECTION_GAP - 2
}

interface OfferItemCols {
  label: number
  qty: number
  unit: number
  total: number
}

/** POSITIONEN column header — drawn initially and re-emitted on every page
 *  break, so a continuation page never shows headerless rows. */
function drawOfferItemsHeader(ctx: DrawCtx, cols: OfferItemCols): void {
  ctx.doc.setFont('helvetica', 'bold')
  ctx.doc.setFontSize(9)
  ctx.doc.setTextColor(110, 110, 110)
  ctx.doc.text('Beschreibung', cols.label, ctx.y)
  ctx.doc.text('Menge', cols.qty, ctx.y, { align: 'right' })
  ctx.doc.text('Einheit', cols.unit, ctx.y)
  ctx.doc.text('Netto', cols.total, ctx.y, { align: 'right' })
  ctx.y += 4
  ctx.doc.setDrawColor(220, 220, 220)
  ctx.doc.line(PAGE_MARGIN_X, ctx.y, ctx.pageWidth - PAGE_MARGIN_X, ctx.y)
  ctx.y += 4
}

function drawLineItems(ctx: DrawCtx, offer: Offer): void {
  if (!offer.lineItems || offer.lineItems.length === 0) return
  ensureSpace(ctx, 20)

  drawTextLine(ctx, 'POSITIONEN', { bold: true, size: 9 })

  // Column layout — simple monospace-aligned (no jsPDF-autotable dep).
  // Widths chosen for A4 portrait (210mm) with the configured margins.
  const cols: OfferItemCols = {
    label: PAGE_MARGIN_X,
    qty: ctx.pageWidth - PAGE_MARGIN_X - 60,
    unit: ctx.pageWidth - PAGE_MARGIN_X - 45,
    total: ctx.pageWidth - PAGE_MARGIN_X - 5,
  }
  drawOfferItemsHeader(ctx, cols)

  const resetRowFont = (c: PdfCursor): void => {
    c.doc.setFont('helvetica', 'normal')
    c.doc.setFontSize(10)
    c.doc.setTextColor(20, 20, 20)
  }
  const onBreak = (c: PdfCursor): void => {
    drawOfferItemsHeader(c, cols)
    resetRowFont(c)
  }
  resetRowFont(ctx)
  for (const item of offer.lineItems) {
    const labelLines = ctx.doc.splitTextToSize(item.label, 90) as string[]
    ensureSpace(ctx, LINE_HEIGHT + 1, onBreak)
    ctx.doc.text(labelLines[0] ?? '', cols.label, ctx.y)
    ctx.doc.text(String(item.quantity), cols.qty, ctx.y, { align: 'right' })
    ctx.doc.text(item.unit ?? '—', cols.unit, ctx.y)
    ctx.doc.text(formatEur(item.netAmount), cols.total, ctx.y, { align: 'right' })
    ctx.y += LINE_HEIGHT
    // wrap continuation
    for (let i = 1; i < labelLines.length; i += 1) {
      ensureSpace(ctx, LINE_HEIGHT, onBreak)
      ctx.doc.text(labelLines[i], cols.label, ctx.y)
      ctx.y += LINE_HEIGHT
    }
  }
  ctx.y += 2
}

function drawTotals(ctx: DrawCtx, offer: Offer): void {
  ensureSpace(ctx, 22)
  ctx.doc.setDrawColor(60, 60, 60)
  ctx.doc.line(PAGE_MARGIN_X, ctx.y, ctx.pageWidth - PAGE_MARGIN_X, ctx.y)
  ctx.y += 5

  const rows: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: 'Summe Netto', value: formatEur(offer.netTotal) },
    {
      label: offer.vatRate != null ? `MwSt ${offer.vatRate} %` : 'MwSt',
      value: formatEur(offer.vatAmount),
    },
    { label: 'Gesamtbetrag', value: formatEur(offer.grossTotal), bold: true },
  ]
  for (const row of rows) {
    ensureSpace(ctx, LINE_HEIGHT)
    ctx.doc.setFont('helvetica', row.bold ? 'bold' : 'normal')
    ctx.doc.setFontSize(row.bold ? 12 : 10)
    ctx.doc.setTextColor(0, 0, 0)
    ctx.doc.text(row.label, PAGE_MARGIN_X, ctx.y)
    ctx.doc.text(row.value, ctx.pageWidth - PAGE_MARGIN_X - 5, ctx.y, { align: 'right' })
    ctx.y += row.bold ? LINE_HEIGHT + 1 : LINE_HEIGHT
  }
  ctx.y += SECTION_GAP
}

function drawConditions(ctx: DrawCtx, offer: Offer): void {
  const fields: Array<{ label: string; text?: string }> = [
    { label: 'Zahlungsbedingungen', text: offer.paymentTerms },
    { label: 'Stornobedingungen', text: offer.cancellationTerms },
  ]
  for (const field of fields) {
    if (!field.text || field.text.length === 0) continue
    ensureSpace(ctx, 12)
    drawTextLine(ctx, field.label.toUpperCase(), { bold: true, size: 9 })
    const wrapped = ctx.doc.splitTextToSize(field.text, ctx.pageWidth - PAGE_MARGIN_X * 2)
    for (const line of wrapped as string[]) {
      ensureSpace(ctx, LINE_HEIGHT)
      ctx.doc.setFont('helvetica', 'normal')
      ctx.doc.setFontSize(10)
      ctx.doc.setTextColor(40, 40, 40)
      ctx.doc.text(line, PAGE_MARGIN_X, ctx.y)
      ctx.y += LINE_HEIGHT
    }
    ctx.y += 2
  }
}

function drawFooter(ctx: DrawCtx, offer: Offer): void {
  const footerY = ctx.pageHeight - 10
  renderPageFooters(ctx, (page, pageCount) => {
    ctx.doc.setFont('helvetica', 'normal')
    ctx.doc.setFontSize(8)
    ctx.doc.setTextColor(140, 140, 140)
    ctx.doc.text(`SaFix · ${documentTypeNoun(offer)} ${offer.id}`, PAGE_MARGIN_X, footerY)
    ctx.doc.text(`Seite ${page} von ${pageCount}`, ctx.pageWidth - PAGE_MARGIN_X, footerY, {
      align: 'right',
    })
  })
  ctx.doc.setTextColor(0, 0, 0)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds a PDF document for the given offer and returns the rendered Blob.
 * Pure: no Storage upload, no Download trigger — caller decides what to do
 * with the Blob.
 */
export interface OfferPdfOptions {
  /**
   * Human-readable recipient name (thread display metadata). The Offer only
   * carries the customer's user id — a raw id must never appear in the
   * exported document; without a name the FÜR column is omitted.
   */
  customerName?: string | null
}

export async function generateOfferPdf(offer: Offer, opts: OfferPdfOptions = {}): Promise<Blob> {
  assertOfferExportable(offer)
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const ctx: DrawCtx = createCursor({
    doc,
    marginX: PAGE_MARGIN_X,
    topY: PAGE_MARGIN_Y_TOP,
    marginBottom: 18,
  })

  drawHeader(ctx, offer)
  drawParties(ctx, offer, opts.customerName)
  drawScope(ctx, offer)
  drawAufmass(ctx, offer)
  drawLineItems(ctx, offer)
  drawTotals(ctx, offer)
  drawConditions(ctx, offer)
  drawFooter(ctx, offer)

  return doc.output('blob')
}

/**
 * Returns a deterministic filename for the offer PDF — used by the Download
 * button + future Storage-upload path. Format:
 *   `Angebot-{offerRef-or-id}.pdf`
 */
export function offerPdfFilename(offer: Offer): string {
  const ref = offer.offerRef ?? offer.id.slice(0, 8)
  return `${documentTypeNoun(offer)}-${ref}.pdf`
}

/**
 * Browser helper: generate the PDF + trigger a download. Kept out of the
 * screen component (QuoteDetailScreen.tsx) so the screen file stays free of
 * `setTimeout` — its loading-decision determinism is enforced by a regression
 * guard (tests/quotes/quoteOpenPath.test.ts).
 *
 * Cleanup window: 2s is the cross-browser-safe minimum for `URL.revokeObjectURL`
 * after triggering an anchor-click download (Firefox in particular needs a beat
 * before the blob URL is detached).
 */
export async function downloadOfferPdf(offer: Offer, opts: OfferPdfOptions = {}): Promise<void> {
  const blob = await generateOfferPdf(offer, opts)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = offerPdfFilename(offer)
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Chunked Blob → base64 (8 KiB chunks · call-stack-safe for any PDF size). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)) as number[],
    )
  }
  return btoa(binary)
}

/**
 * Generate the offer PDF and hand it to the platform: the native share sheet on
 * Capacitor (save to Files / AirDrop / WhatsApp / email / print), a hidden-anchor
 * download on web. Mirrors `downloadInvoicePdf`. The craftsman triggers this
 * after sending the offer to share the floor-plan-rich document outside the app.
 *
 * Does NOT mark anything sent — export and send are separate explicit actions.
 */
export async function shareOrDownloadOfferPdf(offer: Offer, opts: OfferPdfOptions = {}): Promise<void> {
  const blob = await generateOfferPdf(offer, opts)
  const filename = offerPdfFilename(offer)

  if (isNative()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    const { Share } = await import('@capacitor/share')
    const base64 = await blobToBase64(blob)
    const writeResult = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache,
    })
    await Share.share({
      title: filename,
      files: [writeResult.uri],
      dialogTitle: 'Angebot teilen oder speichern',
    })
    return
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 250)
}
