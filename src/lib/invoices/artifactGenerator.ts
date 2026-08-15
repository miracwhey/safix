import type { jsPDF } from 'jspdf'
import type { Invoice, InvoiceKind, InvoiceLineItemCategory } from './types'
import {
  KNOWN_PLACEHOLDER_ISSUER_ADDRESSES,
  KNOWN_PLACEHOLDER_ISSUER_NAMES,
} from './invoiceValidation'
import {
  createCursor,
  ensureSpace,
  flowLines,
  renderPageFooters,
  type PdfCursor,
} from '../pdf/paginate'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Strukturierte Render-Daten für die Invoice-PDF.
 *
 * Pure-Output — keine jsPDF-Aufrufe, keine Browser-APIs.
 *
 * Block 7.1B3: dual-mode.
 *
 *   - `mode = 'snapshot'` — vollständige §14-UStG-Pflichtangaben (Provider-/
 *     Customer-Snapshot, Leistungszeitraum, Tax-Breakdown, §19/§35a-Hinweise).
 *     Ist der Pflicht-Pfad für alle ab B3 ausgestellten Rechnungen.
 *
 *   - `mode = 'legacy'` — minimaler Render-Pfad für bereits ausgestellte
 *     Rechnungen, die vor B3 ohne Snapshot in die DB gegangen sind. Liefert
 *     nur die Basisdaten aus `parties` + `amounts`. Wird nicht für Neu-
 *     ausstellungen verwendet.
 */
export type InvoiceRenderData =
  | InvoiceRenderDataLegacy
  | InvoiceRenderDataSnapshot

export type InvoiceRenderDataLegacy = {
  mode: 'legacy'
  invoiceNumber: string
  issuedAtLabel: string
  dueAtLabel: string
  issuerName: string
  issuerAddress: string
  customerName: string
  lineItems: Array<{
    label: string
    quantity: number
    unitPrice: string
    total: string
  }>
  netAmount: string
  taxAmount: string
  grossAmount: string
}

export type InvoiceRenderDataSnapshot = {
  mode: 'snapshot'
  /**
   * Block 7.1B4 — Belegart steuert Kopfzeile, Footer und §35a-Logik.
   *   `invoice`      → „RECHNUNG"
   *   `cancellation` → „STORNORECHNUNG" mit negativen Beträgen + Originalbezug
   *   `credit_note`  → „GUTSCHRIFT" mit Δ-Beträgen + Originalbezug
   */
  documentKind: InvoiceKind
  invoiceNumber: string
  issuedAtLabel: string
  servicePeriodLabel: string

  /**
   * Bezug auf die Originalrechnung (nur für Korrekturbelege gesetzt). Wird im
   * Header der PDF gerendert: „Bezug auf Rechnung Nr. {invoiceNumber} vom
   * {issuedAtLabel}".
   */
  originalInvoiceReference: {
    invoiceNumber: string
    issuedAtLabel: string
  } | null

  /** Begründung des Korrekturbelegs. Nur für Korrekturbelege gesetzt. */
  correctionReason: string | null

  // Aussteller
  issuerName: string
  issuerAddress: string
  issuerTaxLine: string | null
  issuerLegalForm: string | null
  issuerBank: string | null

  // Empfänger
  customerName: string
  customerAddressLine1: string
  customerAddressLine2: string | null
  customerPostalCity: string
  customerCountry: string
  customerVatLine: string | null

  // Positionen
  lineItems: Array<{
    label: string
    quantity: number
    category: InvoiceLineItemCategory
    unitPrice: string
    netTotal: string
    vatRateLabel: string
    vatAmount: string
    grossTotal: string
  }>

  netAmount: string
  taxAmount: string
  grossAmount: string

  taxBreakdown: Array<{
    vatRateLabel: string
    netAmount: string
    taxAmount: string
    grossAmount: string
  }>

  taxNote: string | null
  par35aHint: { laborGross: string; travelGross: string } | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEuro(amount: number): string {
  return amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}

function formatVatRate(rate: number): string {
  if (Number.isInteger(rate)) return `${rate} %`
  return `${rate.toFixed(2)} %`
}

function buildIssuerTaxLine(invoice: Invoice): string | null {
  const provider = invoice.providerSnapshot
  if (!provider) return null
  const parts: string[] = []
  if (provider.taxNumber) parts.push(`Steuernummer ${provider.taxNumber}`)
  if (provider.vatId) parts.push(`USt-IdNr. ${provider.vatId}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function buildIssuerBankLine(invoice: Invoice): string | null {
  const provider = invoice.providerSnapshot
  if (!provider?.iban) return null
  return provider.bic
    ? `IBAN ${provider.iban} · BIC ${provider.bic}`
    : `IBAN ${provider.iban}`
}

function buildCustomerVatLine(invoice: Invoice): string | null {
  const c = invoice.customerSnapshot
  if (!c) return null
  if (c.isBusiness && c.businessName) {
    return c.vatId
      ? `${c.businessName} · USt-IdNr. ${c.vatId}`
      : c.businessName
  }
  return null
}

function buildPar35aHint(
  invoice: Invoice,
): { laborGross: string; travelGross: string } | null {
  let labor = 0
  let travel = 0
  for (const item of invoice.lineItems) {
    const gross = item.gross ?? item.total
    if (item.category === 'labor') labor += gross
    else if (item.category === 'travel') travel += gross
  }
  if (labor === 0 && travel === 0) return null
  return {
    laborGross: formatEuro(labor),
    travelGross: formatEuro(travel),
  }
}

function assertCommonGuards(invoice: Invoice): void {
  if (invoice.status === 'draft') {
    throw new Error(
      `Invoice "${invoice.id}" is still a draft and cannot be exported. ` +
        'Issue the invoice before downloading.',
    )
  }
  if (!invoice.invoiceNumber) {
    throw new Error(
      `Invoice "${invoice.id}" has no invoice number assigned. ` +
        'The invoice must be issued before downloading.',
    )
  }
  if (!invoice.parties.issuerName || invoice.parties.issuerName.trim() === '') {
    throw new Error(`Invoice "${invoice.id}" is missing issuerName.`)
  }
  if (KNOWN_PLACEHOLDER_ISSUER_NAMES.has(invoice.parties.issuerName)) {
    throw new Error(
      `Invoice "${invoice.id}" still carries a placeholder issuerName. ` +
        'Set your business name in your profile before downloading.',
    )
  }
  if (!invoice.parties.issuerAddress || invoice.parties.issuerAddress.trim() === '') {
    throw new Error(`Invoice "${invoice.id}" is missing issuerAddress.`)
  }
  if (KNOWN_PLACEHOLDER_ISSUER_ADDRESSES.has(invoice.parties.issuerAddress)) {
    throw new Error(
      `Invoice "${invoice.id}" still carries a placeholder issuerAddress. ` +
        'Set your business address in your profile before downloading.',
    )
  }
  if (!invoice.parties.issuerAddress.includes(',')) {
    throw new Error(
      `Invoice "${invoice.id}" has an incomplete issuerAddress (city-only). ` +
        'A full address including street and postal code is required.',
    )
  }
  if (!invoice.parties.customerName || invoice.parties.customerName.trim() === '') {
    throw new Error(`Invoice "${invoice.id}" is missing customerName.`)
  }
  if (invoice.lineItems.length === 0) {
    throw new Error(`Invoice "${invoice.id}" has no line items.`)
  }
  // Block 7.1B4 — Korrekturbelege tragen negative Bruttobeträge; nur „echte"
  // Originalrechnungen (kind = 'invoice') müssen positiv sein. Korrekturbelege
  // dürfen nicht 0 sein.
  if (invoice.kind === 'cancellation' || invoice.kind === 'credit_note') {
    if (invoice.amounts.grossAmount === 0) {
      throw new Error(
        `Invoice "${invoice.id}" correction has a zero gross amount.`,
      )
    }
  } else if (invoice.amounts.grossAmount <= 0) {
    throw new Error(`Invoice "${invoice.id}" has a zero or negative gross amount.`)
  }
}

// ── Core: pure render data extraction ────────────────────────────────────────

export function buildInvoiceRenderData(invoice: Invoice): InvoiceRenderData {
  assertCommonGuards(invoice)

  // Snapshot-Pfad ist Pflicht für alle ab B3 ausgestellten Rechnungen. Wenn
  // einer der Snapshot-Bausteine fehlt, fällt der Renderer auf den Legacy-
  // Pfad zurück, damit pre-B3 Rechnungen noch downloadbar bleiben.
  const hasFullSnapshot =
    !!invoice.providerSnapshot &&
    !!invoice.customerSnapshot &&
    !!invoice.servicePeriod &&
    Array.isArray(invoice.taxBreakdown) &&
    invoice.taxBreakdown.length > 0

  if (!hasFullSnapshot) {
    return {
      mode: 'legacy',
      invoiceNumber: invoice.invoiceNumber,
      issuedAtLabel: invoice.issuedAtLabel,
      dueAtLabel: invoice.dueAtLabel,
      issuerName: invoice.parties.issuerName,
      issuerAddress: invoice.parties.issuerAddress,
      customerName: invoice.parties.customerName,
      lineItems: invoice.lineItems.map((li) => ({
        label: li.label,
        quantity: li.quantity,
        unitPrice: formatEuro(li.unitPrice),
        total: formatEuro(li.total),
      })),
      netAmount: formatEuro(invoice.amounts.netAmount),
      taxAmount: formatEuro(invoice.amounts.taxAmount),
      grossAmount: formatEuro(invoice.amounts.grossAmount),
    }
  }

  const provider = invoice.providerSnapshot!
  const customer = invoice.customerSnapshot!

  const documentKind: InvoiceKind = invoice.kind ?? 'invoice'

  let originalInvoiceReference: {
    invoiceNumber: string
    issuedAtLabel: string
  } | null = null
  if (
    (documentKind === 'cancellation' || documentKind === 'credit_note') &&
    invoice.originalInvoiceNumber
  ) {
    originalInvoiceReference = {
      invoiceNumber: invoice.originalInvoiceNumber,
      issuedAtLabel: invoice.originalInvoiceIssuedAtLabel ?? '',
    }
  }

  return {
    mode: 'snapshot',
    documentKind,
    invoiceNumber: invoice.invoiceNumber,
    issuedAtLabel: invoice.issuedAtLabel,
    servicePeriodLabel: invoice.servicePeriod!.label,
    originalInvoiceReference,
    correctionReason: invoice.correctionReason ?? null,

    issuerName: provider.companyName,
    issuerAddress: provider.businessAddress,
    issuerTaxLine: buildIssuerTaxLine(invoice),
    issuerLegalForm: provider.legalForm,
    issuerBank: buildIssuerBankLine(invoice),

    customerName: customer.billingName,
    customerAddressLine1: customer.billingAddressLine1,
    customerAddressLine2: customer.billingAddressLine2 ?? null,
    customerPostalCity: `${customer.billingPostalCode} ${customer.billingCity}`.trim(),
    customerCountry: customer.billingCountry,
    customerVatLine: buildCustomerVatLine(invoice),

    lineItems: invoice.lineItems.map((li) => {
      const rate = li.vatRate ?? 19
      const gross = li.gross ?? li.total
      const vatAmount = li.vatAmount ?? gross - li.total
      return {
        label: li.label,
        quantity: li.quantity,
        category: li.category ?? 'labor',
        unitPrice: formatEuro(li.unitPrice),
        netTotal: formatEuro(li.total),
        vatRateLabel: formatVatRate(rate),
        vatAmount: formatEuro(vatAmount),
        grossTotal: formatEuro(gross),
      }
    }),

    netAmount: formatEuro(invoice.amounts.netAmount),
    taxAmount: formatEuro(invoice.amounts.taxAmount),
    grossAmount: formatEuro(invoice.amounts.grossAmount),

    taxBreakdown: invoice.taxBreakdown!.map((entry) => ({
      vatRateLabel: formatVatRate(entry.vatRate),
      netAmount: formatEuro(entry.netAmount),
      taxAmount: formatEuro(entry.taxAmount),
      grossAmount: formatEuro(entry.grossAmount),
    })),

    taxNote: invoice.taxNote && invoice.taxNote.trim() ? invoice.taxNote : null,
    par35aHint: buildPar35aHint(invoice),
  }
}

// ── PDF renderer ──────────────────────────────────────────────────────────────

/** Invoice layout cursor — the shared pagination cursor plus the column-layout
 *  geometry every invoice block reads. */
interface InvoiceCursor extends PdfCursor {
  margin: number
  contentWidth: number
  rightEdge: number
}

interface SnapshotCols {
  desc: number
  qty: number
  net: number
  vat: number
  gross: number
}

interface LegacyCols {
  desc: number
  qty: number
  unit: number
  total: number
}

const INVOICE_MARGIN = 18
const INVOICE_TOP_Y = 22

function makeInvoiceCursor(doc: jsPDF): InvoiceCursor {
  const base = createCursor({ doc, marginX: INVOICE_MARGIN, topY: INVOICE_TOP_Y })
  const contentWidth = base.pageWidth - 2 * INVOICE_MARGIN
  return {
    ...base,
    margin: INVOICE_MARGIN,
    contentWidth,
    rightEdge: base.pageWidth - INVOICE_MARGIN,
  }
}

/**
 * Per-page footer: „Seite X von Y" + Rechnungsnummer als Audit-Anker. Läuft
 * zuletzt, wenn die Seitenzahl endgültig feststeht.
 */
function drawInvoiceFooters(ctx: InvoiceCursor, invoiceNumber: string): void {
  const footerY = ctx.pageHeight - 8
  renderPageFooters(ctx, (page, pageCount) => {
    ctx.doc.setFont('helvetica', 'normal')
    ctx.doc.setFontSize(8)
    ctx.doc.text(`Rechnung ${invoiceNumber}`, ctx.margin, footerY)
    ctx.doc.text(`Seite ${page} von ${pageCount}`, ctx.rightEdge, footerY, {
      align: 'right',
    })
  })
}

export async function generateInvoicePdf(invoice: Invoice): Promise<Blob> {
  const data = buildInvoiceRenderData(invoice)

  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })

  if (data.mode === 'legacy') {
    return renderLegacyInvoice(doc, data)
  }
  return renderSnapshotInvoice(doc, data)
}

// ── Legacy renderer (pre-B3 Bestände) ────────────────────────────────────────

function drawLegacyTableHeader(ctx: InvoiceCursor, col: LegacyCols): void {
  const { doc, margin, contentWidth, rightEdge } = ctx
  doc.setFillColor(245, 245, 245)
  doc.rect(margin, ctx.y - 5, contentWidth, 8, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text('Beschreibung', col.desc, ctx.y)
  doc.text('Menge', col.qty, ctx.y)
  doc.text('Einzelpreis', col.unit, ctx.y)
  doc.text('Gesamt', col.total, ctx.y, { align: 'right' })
  doc.setDrawColor(200, 200, 200)
  doc.line(margin, ctx.y + 2, rightEdge, ctx.y + 2)
  ctx.y += 9
}

function renderLegacyInvoice(doc: jsPDF, data: InvoiceRenderDataLegacy): Blob {
  const ctx = makeInvoiceCursor(doc)
  const { margin, rightEdge } = ctx

  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text(data.issuerName, margin, 25)

  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text(data.issuerAddress, margin, 31)

  doc.setFontSize(10)
  doc.text(`Rechnungsnr.: ${data.invoiceNumber}`, rightEdge, 25, {
    align: 'right',
  })
  doc.text(`Ausgestellt am: ${data.issuedAtLabel}`, rightEdge, 31, {
    align: 'right',
  })

  doc.setFontSize(18)
  doc.setFont('helvetica', 'bold')
  doc.text('RECHNUNG', margin, 55)

  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text('Rechnungsempfänger:', margin, 70)
  doc.setFont('helvetica', 'bold')
  doc.text(data.customerName, margin, 76)

  const col: LegacyCols = {
    desc: margin + 2,
    qty: margin + ctx.contentWidth * 0.6,
    unit: margin + ctx.contentWidth * 0.75,
    total: rightEdge,
  }

  ctx.y = 92
  drawLegacyTableHeader(ctx, col)

  const onLegacyBreak = (c: PdfCursor): void => {
    drawLegacyTableHeader(c as InvoiceCursor, col)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
  }
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  for (const item of data.lineItems) {
    // Label zeilenweise — kein atomarer Off-Page-Clip bei langem Label.
    const labelLines = doc.splitTextToSize(item.label, ctx.contentWidth * 0.55) as string[]
    ensureSpace(ctx, 6, onLegacyBreak)
    doc.text(labelLines[0] ?? '', col.desc, ctx.y)
    doc.text(String(item.quantity), col.qty, ctx.y)
    doc.text(item.unitPrice, col.unit, ctx.y)
    doc.text(item.total, col.total, ctx.y, { align: 'right' })
    ctx.y += labelLines.length > 1 ? 5 : 6
    for (let i = 1; i < labelLines.length; i += 1) {
      ensureSpace(ctx, 5, onLegacyBreak)
      doc.text(labelLines[i], col.desc, ctx.y)
      ctx.y += 5
    }
  }

  // Summen-Block (Trennlinie + Netto + MwSt + Gesamtbetrag) als Einheit.
  ensureSpace(ctx, 26)
  doc.line(margin, ctx.y + 2, rightEdge, ctx.y + 2)
  ctx.y += 10

  const labelX = rightEdge - 60
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text('Nettobetrag:', labelX, ctx.y)
  doc.text(data.netAmount, rightEdge, ctx.y, { align: 'right' })
  ctx.y += 6
  doc.text('MwSt.:', labelX, ctx.y)
  doc.text(data.taxAmount, rightEdge, ctx.y, { align: 'right' })
  ctx.y += 8
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('Gesamtbetrag:', labelX - 5, ctx.y)
  doc.text(data.grossAmount, rightEdge, ctx.y, { align: 'right' })

  drawInvoiceFooters(ctx, data.invoiceNumber)
  return doc.output('blob')
}

// ── Snapshot renderer (B3 §14-konform) ───────────────────────────────────────

function drawSnapshotTableHeader(ctx: InvoiceCursor, col: SnapshotCols): void {
  const { doc, margin, contentWidth, rightEdge } = ctx
  doc.setFillColor(245, 245, 245)
  doc.rect(margin, ctx.y - 5, contentWidth, 8, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.text('Beschreibung', col.desc, ctx.y)
  doc.text('Menge', col.qty, ctx.y)
  doc.text('Netto', col.net, ctx.y)
  doc.text('USt', col.vat, ctx.y)
  doc.text('Brutto', col.gross, ctx.y, { align: 'right' })
  doc.setDrawColor(200, 200, 200)
  doc.line(margin, ctx.y + 2, rightEdge, ctx.y + 2)
  ctx.y += 8
}

function renderSnapshotInvoice(doc: jsPDF, data: InvoiceRenderDataSnapshot): Blob {
  const ctx = makeInvoiceCursor(doc)
  const { margin, contentWidth, rightEdge } = ctx

  // ── Kopf (Seite 1): Aussteller / Meta / Belegart / Empfänger ──
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text(data.issuerName, margin, 22)

  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text(data.issuerAddress, margin, 27)
  let issuerY = 32
  if (data.issuerTaxLine) {
    doc.text(data.issuerTaxLine, margin, issuerY)
    issuerY += 4
  }
  if (data.issuerLegalForm) {
    doc.text(`Rechtsform: ${data.issuerLegalForm}`, margin, issuerY)
    issuerY += 4
  }

  doc.setFontSize(10)
  doc.text(`Rechnungsnr.: ${data.invoiceNumber}`, rightEdge, 22, {
    align: 'right',
  })
  doc.text(`Ausgestellt am: ${data.issuedAtLabel}`, rightEdge, 27, {
    align: 'right',
  })
  doc.setFontSize(9)
  doc.text(data.servicePeriodLabel, rightEdge, 32, { align: 'right' })

  doc.setFontSize(18)
  doc.setFont('helvetica', 'bold')
  const headerLabel =
    data.documentKind === 'cancellation'
      ? 'STORNORECHNUNG'
      : data.documentKind === 'credit_note'
        ? 'GUTSCHRIFT'
        : 'RECHNUNG'
  doc.text(headerLabel, margin, 50)

  // Block 7.1B4 — §14 Abs. 6 UStG: Korrekturbelege müssen den Bezug zur
  // Originalrechnung tragen. Bezug + die (unbegrenzt lange) Begründung fließen
  // über den Cursor, damit ein langer Grund den Empfängerblock — eine
  // §14-Pflichtangabe — nicht von der ersten Seite drückt.
  ctx.y = 56
  if (data.originalInvoiceReference) {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    const ref = data.originalInvoiceReference
    const issuedSuffix = ref.issuedAtLabel ? ` vom ${ref.issuedAtLabel}` : ''
    doc.text(
      `Bezug auf Rechnung Nr. ${ref.invoiceNumber}${issuedSuffix}`,
      margin,
      ctx.y,
    )
    ctx.y += 4
    if (data.correctionReason) {
      const reasonLines = doc.splitTextToSize(
        `Grund: ${data.correctionReason}`,
        contentWidth,
      ) as string[]
      flowLines(ctx, reasonLines, 4, (line, y) => {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        doc.text(line, margin, y)
      })
    }
  }

  // Empfängerblock — §14 Abs. 4 Nr. 1 Pflichtangabe; als Einheit reserviert,
  // damit er nie zwischen Seiten zerrissen oder geclippt wird.
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  ctx.y = Math.max(62, ctx.y + 4)
  ensureSpace(ctx, 26)
  doc.text('Rechnungsempfänger:', margin, ctx.y)
  doc.setFont('helvetica', 'bold')
  doc.text(data.customerName, margin, ctx.y + 5)
  doc.setFont('helvetica', 'normal')
  ctx.y += 10
  doc.text(data.customerAddressLine1, margin, ctx.y)
  ctx.y += 4
  if (data.customerAddressLine2) {
    doc.text(data.customerAddressLine2, margin, ctx.y)
    ctx.y += 4
  }
  doc.text(`${data.customerPostalCity} · ${data.customerCountry}`, margin, ctx.y)
  ctx.y += 4
  if (data.customerVatLine) {
    doc.text(data.customerVatLine, margin, ctx.y)
    ctx.y += 4
  }

  // ── Positionen (paginiert, Spaltenkopf-Repeat auf Folgeseiten) ──
  const col: SnapshotCols = {
    desc: margin + 2,
    qty: margin + contentWidth * 0.42,
    net: margin + contentWidth * 0.55,
    vat: margin + contentWidth * 0.72,
    gross: rightEdge,
  }
  ctx.y = Math.max(95, ctx.y + 6)
  ensureSpace(ctx, 14)
  drawSnapshotTableHeader(ctx, col)

  const resetSnapshotRowFont = (): void => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
  }
  const onSnapshotBreak = (c: PdfCursor): void => {
    drawSnapshotTableHeader(c as InvoiceCursor, col)
    resetSnapshotRowFont()
  }
  resetSnapshotRowFont()
  for (const item of data.lineItems) {
    // Label zeilenweise — eine Position mit beliebig langem Label kann so nie
    // atomar über die Seite hinaus gezeichnet (geclippt) werden.
    const labelLines = doc.splitTextToSize(item.label, contentWidth * 0.38) as string[]
    ensureSpace(ctx, 5, onSnapshotBreak)
    doc.text(labelLines[0] ?? '', col.desc, ctx.y)
    doc.text(String(item.quantity), col.qty, ctx.y)
    doc.text(item.netTotal, col.net, ctx.y)
    doc.text(item.vatRateLabel, col.vat, ctx.y)
    doc.text(item.grossTotal, col.gross, ctx.y, { align: 'right' })
    ctx.y += labelLines.length > 1 ? 4 : 5
    for (let i = 1; i < labelLines.length; i += 1) {
      ensureSpace(ctx, 4, onSnapshotBreak)
      doc.text(labelLines[i], col.desc, ctx.y)
      ctx.y += 4
    }
  }

  // ── Summen-Block (Netto / USt / Gesamtbetrag) — als Einheit, nie gesplittet ──
  ensureSpace(ctx, 26)
  doc.line(margin, ctx.y + 1, rightEdge, ctx.y + 1)
  ctx.y += 7
  const labelX = rightEdge - 60
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text('Nettobetrag:', labelX, ctx.y)
  doc.text(data.netAmount, rightEdge, ctx.y, { align: 'right' })
  ctx.y += 5
  doc.text('USt:', labelX, ctx.y)
  doc.text(data.taxAmount, rightEdge, ctx.y, { align: 'right' })
  ctx.y += 7
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('Gesamtbetrag:', labelX - 5, ctx.y)
  doc.text(data.grossAmount, rightEdge, ctx.y, { align: 'right' })
  ctx.y += 10

  // ── Steueraufstellung — Kopf + Zeilen zusammenhalten ──
  ensureSpace(ctx, 10 + data.taxBreakdown.length * 4)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text('Steueraufstellung', margin, ctx.y)
  ctx.y += 5
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.text('Steuersatz', margin, ctx.y)
  doc.text('Netto', margin + contentWidth * 0.35, ctx.y)
  doc.text('USt', margin + contentWidth * 0.6, ctx.y)
  doc.text('Brutto', rightEdge, ctx.y, { align: 'right' })
  ctx.y += 1
  doc.line(margin, ctx.y, rightEdge, ctx.y)
  ctx.y += 4
  // Falls die Aufstellung (mehrere USt-Sätze) über eine Seitengrenze läuft,
  // wird der Spaltenkopf auf der Folgeseite wiederholt — keine kopflosen Zeilen.
  const drawBreakdownHeader = (c: PdfCursor): void => {
    c.doc.setFont('helvetica', 'bold')
    c.doc.setFontSize(9)
    c.doc.text('Steueraufstellung (Forts.)', margin, c.y)
    c.y += 5
    c.doc.setFont('helvetica', 'normal')
    c.doc.setFontSize(8.5)
    c.doc.text('Steuersatz', margin, c.y)
    c.doc.text('Netto', margin + contentWidth * 0.35, c.y)
    c.doc.text('USt', margin + contentWidth * 0.6, c.y)
    c.doc.text('Brutto', rightEdge, c.y, { align: 'right' })
    c.y += 1
    c.doc.line(margin, c.y, rightEdge, c.y)
    c.y += 4
  }
  for (const entry of data.taxBreakdown) {
    if (ensureSpace(ctx, 4, drawBreakdownHeader)) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
    }
    doc.text(entry.vatRateLabel, margin, ctx.y)
    doc.text(entry.netAmount, margin + contentWidth * 0.35, ctx.y)
    doc.text(entry.taxAmount, margin + contentWidth * 0.6, ctx.y)
    doc.text(entry.grossAmount, rightEdge, ctx.y, { align: 'right' })
    ctx.y += 4
  }
  ctx.y += 4

  // Free-text Hinweise fließen zeilenweise — ein langer §14/§19-Hinweis kann so
  // nie über die Seite hinauslaufen.
  if (data.taxNote) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(9)
    const noteLines = doc.splitTextToSize(data.taxNote, contentWidth) as string[]
    flowLines(ctx, noteLines, 4, (line, y) => {
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9)
      doc.text(line, margin, y)
    })
    ctx.y += 4
  }

  if (data.par35aHint) {
    const hint =
      'Hinweis §35a EStG: Im Bruttobetrag enthaltener Lohn-/Anfahrtsanteil ' +
      `(steuerlich begünstigt für Privatkunden): Lohn ${data.par35aHint.laborGross}, ` +
      `Anfahrt ${data.par35aHint.travelGross}.`
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    const lines = doc.splitTextToSize(hint, contentWidth) as string[]
    flowLines(ctx, lines, 4, (line, y) => {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
      doc.text(line, margin, y)
    })
    ctx.y += 4
  }

  if (data.issuerBank) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    ensureSpace(ctx, 6)
    doc.text(data.issuerBank, margin, ctx.y)
  }

  drawInvoiceFooters(ctx, data.invoiceNumber)
  return doc.output('blob')
}
