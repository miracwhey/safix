import CraftsmanSectionCard from '../CraftsmanSectionCard'
import InvoiceStatusBadge from '../InvoiceStatusBadge'
import { formatInvoiceEuro, type Invoice } from '../../lib/invoices'

type Props = {
  invoices: Invoice[]
}

export default function FinanceInvoicesSection({ invoices }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Rechnungen"
      title="Invoice-Stand"
      subtitle="Rechnungen und Zahlungsfluss laufen hier zusammen."
    >
      <div className="space-y-3">
        {invoices.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
            <div className="text-[16px] font-semibold text-slate-900">
              Keine Rechnungen vorhanden
            </div>
            <div className="mt-1 text-[14px] text-slate-500">
              Rechnungen werden automatisch aus relevanten Jobs erzeugt.
            </div>
          </div>
        ) : (
          invoices.map((invoice) => (
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
                    Job: {invoice.jobId}
                  </div>
                </div>

                <InvoiceStatusBadge status={invoice.status} />
              </div>

              <div className="mt-4 text-[14px] font-semibold text-slate-900">
                {formatInvoiceEuro(invoice.amounts.grossAmount)}
              </div>
            </div>
          ))
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
