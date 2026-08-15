import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  /** Block 7.1B5: zählt nur Originalrechnungen — Storno/Gutschrift werden separat ausgewiesen. */
  totalInvoices: number
  openInvoices: number
  /** Block 7.1B5: Anzahl Storno- + Gutschriftbelege; wenn > 0, wird ein zusätzlicher Subtext gerendert. */
  correctionsCount?: number
}

export default function InvoicesOverviewCard({
  totalInvoices,
  openInvoices,
  correctionsCount = 0,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Backoffice"
      title="Rechnungen"
      subtitle="Rechnungen werden aus rechnungsrelevanten Jobs automatisch vorbereitet und hier sichtbar."
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[22px] bg-[#2563EB] p-4 text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/75">
            Gesamt
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none">
            {totalInvoices}
          </div>
          <div className="mt-2 text-[13px] text-white/80">
            Originalrechnungen
          </div>
          {correctionsCount > 0 && (
            <div className="mt-1 text-[12px] text-white/70">
              + {correctionsCount} Korrekturbeleg{correctionsCount === 1 ? '' : 'e'}
            </div>
          )}
        </div>

        <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Offen
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {openInvoices}
          </div>
          <div className="mt-2 text-[13px] text-slate-500">
            Noch nicht bezahlt
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
