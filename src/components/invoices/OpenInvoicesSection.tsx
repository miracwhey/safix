import CraftsmanSectionCard from '../CraftsmanSectionCard'
import InvoiceStatusBadge from '../InvoiceStatusBadge'
import ProActionGuard from '../subscription/ProActionGuard'
import { resolveActiveWorkContextForJob } from '../../lib/subscription/activeWorkContext'
import type { EffectiveSubscriptionStatus, SubscriptionScope } from '../../lib/subscription'
import {
  formatInvoiceEuro,
  isInvoiceLogicallyCancelled,
  type Invoice,
} from '../../lib/invoices'

type Props = {
  invoices: Invoice[]
  /**
   * Block 7.1F — Vollständige Invoice-Liste zur Ableitung von „Storniert"-
   * Badges. Eine ausgestellte Originalrechnung mit existierender Storno-
   * Korrektur bleibt DB-seitig in Status `issued/sent`, muss in der UI aber
   * konsistent zur PaidInvoicesSection als storniert erscheinen.
   */
  allInvoices?: Invoice[]
  hiddenCount?: number
  onShowMore?: () => void
  /** Called when the craftsman explicitly issues a draft invoice. */
  onIssueInvoice?: (invoice: Invoice) => void
  /** Called when the craftsman marks an issued invoice as sent to the customer. */
  onMarkSent?: (invoice: Invoice) => void
  /** Called when the craftsman downloads the invoice PDF artifact. */
  onDownload?: (invoice: Invoice) => void
  /** Error message to display inline above the invoice list. */
  errorMessage?: string | null
  /** Subscription state for gating issue_invoice action. */
  effectiveState?: EffectiveSubscriptionStatus | null
  scope?: SubscriptionScope
  onTrialStarted?: () => void
}

export default function OpenInvoicesSection({
  invoices,
  allInvoices,
  hiddenCount,
  onShowMore,
  onIssueInvoice,
  onMarkSent,
  onDownload,
  errorMessage,
  effectiveState,
  scope,
  onTrialStarted,
}: Props) {
  const lookupCorpus = allInvoices ?? invoices
  return (
    <CraftsmanSectionCard
      eyebrow="Workflow"
      title="Aktuelle Rechnungen"
      subtitle="Belege im Workflow — Beträge sind über Stripe bereits abgesichert."
    >
      <div className="space-y-3">
        {errorMessage && (
          <div className="rounded-[16px] bg-red-50 px-4 py-3 ring-1 ring-red-200/80">
            <p className="text-[13px] font-medium text-red-700">{errorMessage}</p>
          </div>
        )}
        {invoices.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
            <div className="text-[16px] font-semibold text-slate-900">
              Noch keine Rechnungen
            </div>
            <div className="mt-1 text-[14px] text-slate-500">
              Sobald ein Auftrag abgerechnet wird, erscheint hier automatisch der Beleg.
            </div>
          </div>
        ) : (
          invoices.map((invoice) => {
            const cancelled = isInvoiceLogicallyCancelled(invoice, lookupCorpus)
            return (
            <div
              key={invoice.id}
              className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[16px] font-semibold text-slate-900">
                    {invoice.invoiceNumber || invoice.jobId}
                  </div>
                  <div className="mt-1 text-[14px] text-slate-500">
                    {invoice.parties.customerName}
                  </div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    Ausgestellt: {invoice.issuedAtLabel || '—'}
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
                  {invoice.status === 'draft' && onIssueInvoice && (
                    <ProActionGuard
                      action="issue_invoice"
                      effectiveState={effectiveState ?? null}
                      scope={scope ?? 'not_applicable'}
                      jobContext={resolveActiveWorkContextForJob(invoice.jobId) ?? undefined}
                      onAction={() => onIssueInvoice(invoice)}
                      onTrialStarted={onTrialStarted}
                    >
                      {(guardedOnClick) => (
                        <button
                          onClick={guardedOnClick}
                          className="rounded-[14px] bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white transition active:bg-slate-700"
                        >
                          Ausstellen
                        </button>
                      )}
                    </ProActionGuard>
                  )}
                  {(invoice.status === 'issued' || invoice.status === 'sent') && onDownload && (
                    <button
                      onClick={() => onDownload(invoice)}
                      className="rounded-[14px] bg-slate-100 px-3 py-1.5 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 transition active:bg-slate-200"
                    >
                      PDF herunterladen
                    </button>
                  )}
                  {invoice.status === 'issued' && onMarkSent && (
                    <button
                      onClick={() => onMarkSent(invoice)}
                      className="rounded-[14px] bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white transition active:bg-slate-700"
                    >
                      Als gesendet markieren
                    </button>
                  )}
                </div>
              </div>
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
