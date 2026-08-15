import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { FinanceOverviewSummary } from '../../lib/finance'

type Props = {
  summary: FinanceOverviewSummary
}

export default function FinanceOverviewCard({ summary }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Finanzen"
      title="Zahlungsübersicht"
      subtitle="Hier laufen Zahlungsfälle, Rechnungen und Konflikte in einem Bereich zusammen."
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[22px] bg-[#2563EB] p-4 text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/75">
            Zahlungsfälle
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none">
            {summary.openPaymentCases}
          </div>
          <div className="mt-2 text-[13px] text-white/80">
            Aktiv im System
          </div>
        </div>

        <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Rechnungsvolumen
          </div>
          <div className="mt-3 text-[20px] font-semibold leading-none text-slate-900">
            {summary.invoiceVolumeLabel}
          </div>
          <div className="mt-2 text-[13px] text-slate-500">
            Gesamt brutto
          </div>
        </div>

        <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Rechnungen
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {summary.invoiceCount}
          </div>
          <div className="mt-2 text-[13px] text-slate-500">
            Im Finanzmodul
          </div>
        </div>

        <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Konflikte
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {summary.disputeCount}
          </div>
          <div className="mt-2 text-[13px] text-slate-500">
            Offene Fälle
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
