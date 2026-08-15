export type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'sent'
  | 'paid'
  | 'cancelled'

/**
 * Block 7.1B4 — Belegart gemäß §14 Abs. 6 UStG.
 *
 *   - `invoice`      — Originalrechnung. Default für Bestand und Neuanlagen.
 *   - `cancellation` — Stornorechnung über den vollen Bruttobetrag (Full Refund).
 *                      Macht das Original buchhalterisch nichtig, ohne dessen
 *                      Status zu mutieren (Audit-Trail-Erhalt).
 *   - `credit_note`  — Gutschrift über einen Teilbetrag (Partial/Split Refund).
 *                      Original bleibt issued/sent/paid; Δ-Betrag mindert die
 *                      Forderung um den refundierten Anteil.
 */
export type InvoiceKind = 'invoice' | 'cancellation' | 'credit_note'

/**
 * Position-Kategorie für §35a-EStG-Hinweise und PDF-Spaltierung. `travel`
 * wird als eigene Kategorie geführt, weil Anfahrt zwar Lohn-anrechenbar
 * ist, aber separat ausgewiesen werden muss; `material` ist nicht §35a-fähig.
 */
export type InvoiceLineItemCategory = 'labor' | 'material' | 'travel' | 'other'

export type InvoiceLineItem = {
  id: string
  label: string
  quantity: number
  unitPrice: number
  /** Net total = quantity × unitPrice. Used as the §14-konforme Netto-Spalte. */
  total: number
  /**
   * Position-Kategorie. Treibt §35a-EStG-Hinweis (labor/travel begünstigt,
   * material nicht) und PDF-Spaltierung. Optional in draft, Pflicht ab issued
   * (Snapshot-Builder setzt Default aus Offer-LineItem-Kategorie).
   */
  category?: InvoiceLineItemCategory
  /**
   * Mehrwertsteuersatz dieser Position in Prozent (0, 7, 19). Pro Position
   * persistiert, weil Mischrechnungen (Material 19 % + Anfahrt 7 % o. ä.)
   * möglich sein müssen. Optional in draft, Pflicht ab issued.
   */
  vatRate?: number
  /** Steuerbetrag dieser Position in Euro. Pflicht ab issued. */
  vatAmount?: number
  /** Bruttobetrag dieser Position in Euro = total + vatAmount. Pflicht ab issued. */
  gross?: number
}

export type InvoiceAmounts = {
  netAmount: number
  taxAmount: number
  grossAmount: number
}

export type InvoiceParties = {
  issuerName: string
  /** Physical address of the issuing party (required before issuance). */
  issuerAddress: string
  customerName: string
}

/**
 * Provider-Snapshot, eingefroren beim draft → issued Übergang. Spiegel der
 * §14-pflichtigen Aussteller-Angaben aus dem Provider Tax & Bank Profile (B1)
 * plus Pflicht-Anschrift. Niemals nach Issuance retroaktiv ändern — Korrekturen
 * laufen über einen separaten Storno-/Gutschrift-Workflow (out of scope B3).
 */
export type ProviderInvoiceSnapshot = {
  /** providers.id zur Audit-Verlinkung. */
  providerId: string
  companyName: string
  /** Vollständige Geschäftsanschrift (`Straße Nr, PLZ Stadt`). */
  businessAddress: string
  taxNumber: string | null
  vatId: string | null
  legalForm: string | null
  isKleinunternehmer: boolean
  defaultVatRate: number
  iban: string | null
  bic: string | null
}

/**
 * Customer-Snapshot, eingefroren beim draft → issued Übergang. Spiegel des
 * Customer Billing Profile (B2). Niemals nach Issuance retroaktiv ändern.
 */
export type CustomerInvoiceSnapshot = {
  /** customer_billing_profiles.user_id zur Audit-Verlinkung. */
  userId: string
  billingName: string
  billingAddressLine1: string
  billingAddressLine2: string | null
  billingPostalCode: string
  billingCity: string
  /** ISO-3166-1-Alpha-2. */
  billingCountry: string
  billingEmail: string | null
  billingPhone: string | null
  isBusiness: boolean
  businessName: string | null
  vatId: string | null
}

/**
 * Leistungszeitraum gemäß §14 (4) Nr. 6 UStG. `from`/`to` sind Unix-ms
 * Timestamps; `label` ist der gerenderte Text (z. B. "Leistungsdatum:
 * 12.04.2026" oder "Leistungszeitraum: 10.04.2026 – 12.04.2026").
 *
 * Wenn nur ein Datum bekannt ist (`from === to` oder nur `to`), wird es als
 * Leistungsdatum behandelt. NULL solange im Draft.
 */
export type InvoiceServicePeriod = {
  from: number | null
  to: number | null
  label: string
}

/**
 * Einzelner Block der Steuer-Aufstellung gemäß §14 (4) Nr. 7+8 UStG,
 * gruppiert nach Steuersatz. Pflicht ab issued.
 */
export type InvoiceTaxBreakdownEntry = {
  vatRate: number
  netAmount: number
  taxAmount: number
  grossAmount: number
}

export type Invoice = {
  id: string
  jobId: string
  invoiceNumber: string
  status: InvoiceStatus
  parties: InvoiceParties
  lineItems: InvoiceLineItem[]
  amounts: InvoiceAmounts
  /** Unix ms timestamp set by the engine when transitioning draft → issued. 0 while in draft. */
  issuedAt: number
  issuedAtLabel: string
  dueAtLabel: string
  /**
   * Unix ms timestamp set by the engine when transitioning issued → sent.
   * Primärer Setzer: `markInvoiceSentWorkflow`. Sekundärer Fallback:
   * `syncInvoiceWithPayment` stempelt sentAt ebenfalls, wenn der Payment-State
   * den Invoice durch `issued → sent` zieht (Block 7.1A Truth-Pass —
   * Domain-Doc + Engine-JSDoc decken sich seitdem).
   */
  sentAt: number
  /**
   * §14-Snapshot — befüllt beim draft → issued Übergang vom Snapshot-Builder.
   * NULL solange im Draft. Nach Issuance immutable.
   */
  servicePeriod: InvoiceServicePeriod | null
  taxBreakdown: InvoiceTaxBreakdownEntry[] | null
  /** Steuerhinweis (z. B. §19 UStG bei Kleinunternehmer). NULL wenn keine Hinweispflicht. */
  taxNote: string | null
  providerSnapshot: ProviderInvoiceSnapshot | null
  customerSnapshot: CustomerInvoiceSnapshot | null
  /** ID des Offers, der die kommerzielle Basis war. */
  sourceOfferId: string | null
  /** IDs aller akzeptierten ChangeOrders, die in den Snapshot eingegangen sind. */
  sourceChangeOrderIds: string[]
  /**
   * IDs aller SupplementaryPaymentRequests, die mit den ChangeOrders verknüpft
   * sind. Audit-Spur — werden NICHT zusätzlich auf die Summe addiert
   * (Doppelzählung-Vermeidung; Supplementary-Payment ist nur der Geldfluss-
   * Spiegel des ChangeOrders, nicht eine eigene Position).
   */
  sourceSupplementaryPaymentIds: string[]
  /**
   * Block 7.1B4 — Belegart. Default `'invoice'` für alle Originalrechnungen
   * und Bestandsdaten vor B4. Korrekturbelege setzen `'cancellation'` oder
   * `'credit_note'` und tragen Pflichtwerte in den Korrektur-Feldern unten.
   */
  kind: InvoiceKind
  /** ID der Originalrechnung. NULL für `kind='invoice'`. */
  originalInvoiceId: string | null
  /** Begründung des Korrekturbelegs. NULL für `kind='invoice'`. */
  correctionReason: string | null
  /**
   * Δ-Bruttobetrag in Cent. Bei `kind='cancellation'` der negierte volle
   * Bruttobetrag der Originalrechnung; bei `kind='credit_note'` der negierte
   * Teilbetrag, der dem Kunden refundiert wurde. NULL für `kind='invoice'`.
   */
  correctionAmountCents: number | null
  /**
   * Snapshot der Originalbelegnummer beim Anlegen des Korrekturbelegs.
   * Erlaubt dem PDF-Renderer, den §14-pflichtigen Bezug auf die
   * Originalrechnung zu drucken, ohne den Original-Datensatz nachladen zu
   * müssen. NULL für `kind='invoice'`.
   */
  originalInvoiceNumber: string | null
  /** Snapshot des Originals-Ausstellungsdatums (UI-Label). NULL für `kind='invoice'`. */
  originalInvoiceIssuedAtLabel: string | null
  /** Optionaler Audit-Anker auf das auslösende Refund-/Dispute-Event. */
  refundEventId: string | null
  createdAt: number
  updatedAt: number
}
