import { mockInvoices } from '../mockData'
import type { Invoice } from '../types'
import type { InvoiceRepository } from './InvoiceRepository'

type Listener = () => void

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private invoices: Invoice[]
  private readonly listeners = new Set<Listener>()
  /**
   * Per-instance sequential counters für Belegnummern. Mirror der DB-Triggers
   * (`generate_invoice_number`) inkl. der mit Block 7.1B4 eingeführten
   * separaten Sequenzen für Korrekturbelege.
   *   _nextInvoiceNumber       → FX-YYYY-NNNN     (Originalrechnung)
   *   _nextCancellationNumber  → FX-S-YYYY-NNNN   (Stornorechnung)
   *   _nextCreditNoteNumber    → FX-G-YYYY-NNNN   (Gutschrift)
   */
  private _nextInvoiceNumber: number
  private _nextCancellationNumber: number
  private _nextCreditNoteNumber: number

  constructor(initialData: Invoice[] = [...mockInvoices]) {
    this.invoices = initialData
    const reduceMaxSeq = (regex: RegExp): number =>
      initialData.reduce((max, inv) => {
        const match = inv.invoiceNumber.match(regex)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)
    this._nextInvoiceNumber = reduceMaxSeq(/^FX-\d{4}-(\d{4})$/) + 1
    this._nextCancellationNumber = reduceMaxSeq(/^FX-S-\d{4}-(\d{4})$/) + 1
    this._nextCreditNoteNumber = reduceMaxSeq(/^FX-G-\d{4}-(\d{4})$/) + 1
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    return true
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Invoice[] {
    return [...this.invoices]
  }

  getByJobId(jobId: string): Invoice | undefined {
    return this.invoices.find((invoice) => invoice.jobId === jobId)
  }

  ensureLoaded(): Promise<void> {
    // In-memory cache already holds every invoice — nothing to lazy-load.
    return Promise.resolve()
  }

  ensureLoadedByJobId(): Promise<void> {
    // In-memory cache already holds every invoice — nothing to lazy-load.
    return Promise.resolve()
  }

  serverDrivesPaidStatus(): boolean {
    // No server in in-memory/mock mode — the client drives invoice→'paid'.
    return false
  }

  async add(invoice: Invoice): Promise<void> {
    const alreadyExists = this.invoices.some((inv) => inv.id === invoice.id)
    if (alreadyExists) return

    // Mirror der DB-Trigger-Pflicht: BEFORE INSERT vergibt eine Belegnummer,
    // wenn ein bereits ausgestellter Beleg eingefügt wird (z. B. wenn ein
    // hypothetischer Workflow Korrekturbelege atomar als `issued` einfügen
    // möchte). In Praxis nutzt der `invoiceCorrectionWorkflow` heute den
    // draft → issued Pfad, dieser Codepfad bleibt aber als Sicherheitsnetz.
    const numbered =
      invoice.status === 'issued' && !invoice.invoiceNumber
        ? { ...invoice, invoiceNumber: this.allocateInvoiceNumber(invoice.kind) }
        : invoice

    this.invoices = [numbered, ...this.invoices]
    this.notify()
  }

  async update(invoiceId: string, updater: (invoice: Invoice) => Invoice): Promise<void> {
    this.invoices = this.invoices.map((invoice) => {
      if (invoice.id !== invoiceId) return invoice

      const updated = updater(invoice)

      // Assign a kind-aware sequential invoice number on draft → issued
      // transition, mirroring the DB trigger (`generate_invoice_number`).
      if (
        updated.status === 'issued' &&
        invoice.status === 'draft' &&
        !updated.invoiceNumber
      ) {
        return { ...updated, invoiceNumber: this.allocateInvoiceNumber(updated.kind) }
      }

      return updated
    })
    this.notify()
  }

  private allocateInvoiceNumber(kind: Invoice['kind']): string {
    const year = new Date().getFullYear()
    if (kind === 'cancellation') {
      const seq = String(this._nextCancellationNumber++).padStart(4, '0')
      return `FX-S-${year}-${seq}`
    }
    if (kind === 'credit_note') {
      const seq = String(this._nextCreditNoteNumber++).padStart(4, '0')
      return `FX-G-${year}-${seq}`
    }
    const seq = String(this._nextInvoiceNumber++).padStart(4, '0')
    return `FX-${year}-${seq}`
  }
}
