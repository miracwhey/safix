import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  gmv: string
  revenue: string
  payouts: string
  refunds: string
  openEscrow: string
  disputeSettlements: string
  disputeHold: string
}

export default function FinanceKPICard({
  gmv,
  revenue,
  payouts,
  refunds,
  openEscrow,
  disputeSettlements,
  disputeHold,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="KPIs"
      title="Plattform-Kennzahlen"
      subtitle="Diese Werte werden direkt aus dem Payment Ledger berechnet."
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[20px] bg-blue-50 p-4 ring-1 ring-blue-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-blue-600">
            GMV
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {gmv}
          </div>
        </div>

        <div className="rounded-[20px] bg-emerald-50 p-4 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
            Revenue
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {revenue}
          </div>
        </div>

        <div className="rounded-[20px] bg-violet-50 p-4 ring-1 ring-violet-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-violet-600">
            Payouts
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {payouts}
          </div>
        </div>

        <div className="rounded-[20px] bg-rose-50 p-4 ring-1 ring-rose-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-rose-600">
            Refunds
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {refunds}
          </div>
        </div>

        <div className="rounded-[20px] bg-orange-50 p-4 ring-1 ring-orange-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-orange-600">
            Streitbeilegungen
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {disputeSettlements}
          </div>
        </div>

        <div className="rounded-[20px] bg-amber-50 p-4 ring-1 ring-amber-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-600">
            Open Escrow
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {openEscrow}
          </div>
        </div>

        <div className="rounded-[20px] bg-red-50 p-4 ring-1 ring-red-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-red-600">
            Dispute Holds
          </div>
          <div className="mt-2 text-[18px] font-semibold text-slate-900">
            {disputeHold}
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
