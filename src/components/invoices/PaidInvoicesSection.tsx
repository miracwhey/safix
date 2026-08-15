import CraftsmanSectionCard from '../CraftsmanSectionCard'
import InvoiceStatusBadge from '../InvoiceStatusBadge'
import {
  formatInvoiceEuro,
  isInvoiceLogicallyCancelled,
  getCorrectionsForInvoice,
  type Invoice,
} from '../../lib/invoices'

type Props = {
  invoices: Invoice[]
  /**
   * Vollständige Invoice-Liste — wird zur Ableitung von `Storniert"-Badges
   * und zur Korrekturen-Aufzählung pro Karte gebraucht. PaidInvoicesSection
   * filtert aus dieser Liste die zugehörigen Korrekturbelege.
   */
  allInvoices?: Invoice[]
  hiddenCount?: number
  onShowMore?: () => void
  /** Called when the craftsman downloads the invoice PDF artifact. */
  onDownload?: (invoice: Invoice) => void
  /**
   * Block 7.1B4 — Aufruf, wenn der Handwerker Storno- oder Gutschriftbeleg
   * für eine bezahlte Originalrechnung anlegen will. Eltern-Komponente öffnet
   * das `InvoiceCorrectionSheet`. NULL/undefined verbirgt den Button (z. B.
   * im UI-Test ohne Handler).
   */
  onCreateCorrection?: (invoice: Invoice) => void
}

export default function PaidInvoicesSection({
  invoices,
  allInvoices,
  hiddenCount,
  onShowMore,
  onDownload,
  onCreateCorrection,
}: Props) {
  const lookupCorpus = allInvoices ?? invoices
  return (
    <CraftsmanSectionCard
      eyebrow="Historie"
      title="Bezahlte Rechnungen"
      subtitle="Bereits abgeschlossene Rechnungen für Rückblick und Kontrolle."
    >
      <div className="space-y-3">
        {invoices.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
            <div className="text-[16px] font-semibold text-slate-900">
              Noch keine bezahlten Rechnungen
            </div>
            <div className="mt-1 text-[14px] text-slate-500">
              Bezahlte Rechnungen tauchen hier auf, sobald Zahlungsfluss und Invoice-Status zusammenlaufen.
            </div>
          </div>
        ) : (
          invoices.map((invoice) => {
            const cancelled = isInvoiceLogicallyCancelled(invoice, lookupCorpus)
            const corrections = getCorrectionsForInvoice(lookupCorpus, invoice.id)
            return (
              <div
                key={invoice.id}
                className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[16px] font-semibold text-slate-900">
                      {invoice.invoiceNumber}
                    </div>
                    <div className="mt-1 text-[14px] text-slate-500">
                      {invoice.parties.customerName}
                    </div>
                    <div className="mt-1 text-[13px] text-slate-400">
                      Ausgestellt: {invoice.issuedAtLabel}
                    </div>
                  </div>

                  <InvoiceStatusBadge
                    status={invoice.status}
                    kind={invoice.kind}
                    cancelledByCorrection={cancelled}
                  />
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="text-[14px] font-semibold text-slate-900">
                    {formatInvoiceEuro(invoice.amounts.grossAmount)}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-[13px] text-slate-400">
                      Job: {invoice.jobId}
                    </div>
                    {onDownload && (
                      <button
                        onClick={() => onDownload(invoice)}
                        className="rounded-[14px] bg-slate-100 px-3 py-1.5 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 transition active:bg-slate-200"
                      >
                        PDF herunterladen
                      </button>
                    )}
                  </div>
                </div>

                {corrections.length > 0 && (
                  <ul className="mt-3 space-y-1.5 rounded-[14px] bg-slate-50 px-3 py-2 text-[12px] text-slate-600 ring-1 ring-slate-200">
                    {corrections.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2">
                        <span>
                          {c.kind === 'cancellation' ? 'Storno' : 'Gutschrift'}{' '}
                          {c.invoiceNumber}
                        </span>
                        <span className="font-semibold text-slate-700">
                          {formatInvoiceEuro(c.amounts.grossAmount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {onCreateCorrection && !cancelled && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    <button
                      onClick={() => onCreateCorrection(invoice)}
                      className="rounded-xl bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-200 transition active:scale-[0.97]"
                    >
                      Storno / Gutschrift
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
        {(hiddenCount ?? 0) > 0 && onShowMore && (
          <button
            onClick={onShowMore}
            className="w-full rounded-[18px] bg-slate-50 px-4 py-3 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition active:bg-slate-100"
          >
            Weitere anzeigen ({hiddenCount} weitere)
          </button>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
