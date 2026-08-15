import { useState } from 'react'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import { formatEuro } from '../../lib/payments/selectors'
import type { LedgerEntry } from '../../lib/payments/ledger'

// Maximum ledger entries shown before the "show more" toggle appears.
const LEDGER_INITIAL = 20

type Props = {
  entries: LedgerEntry[]
}
function getLabel(type: LedgerEntry['type']) {
  switch (type) {
    case 'escrow_created':
      return 'Zahlung erstellt'
    case 'deposit_paid':
      return 'Einzahlung bestätigt'
    case 'final_paid':
      return 'Restzahlung'
    case 'platform_fee':
      return 'SaFix Provision'
    case 'payout':
      return 'Auszahlung Betrieb'
    case 'refund':
      return 'Rückerstattung'
    case 'dispute_resolved_release':
      return 'Freigabe nach Streitbeilegung'
    case 'dispute_resolved_refund':
      return 'Erstattung nach Streitbeilegung'
    default:
      return type
  }
}

export default function FinanceLedgerSection({ entries }: Props) {
  const [showAll, setShowAll] = useState(false)

  const visibleEntries = showAll ? entries : entries.slice(0, LEDGER_INITIAL)
  const hiddenCount = entries.length - visibleEntries.length

  return (
    <CraftsmanSectionCard
      eyebrow="Ledger"
      title="Geldbewegungen"
      subtitle="Neueste finanzielle Bewegungen der Plattform."
    >
      <div className="space-y-3">
        {entries.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70">
            <div className="text-[16px] font-semibold text-slate-900">
              Noch keine Buchungen
            </div>
            <div className="mt-1 text-[14px] text-slate-500">
              Ledger-Einträge erscheinen automatisch, sobald Zahlungen entstehen.
            </div>
          </div>
        ) : (
          <>
            {visibleEntries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_12px_30px_-20px_rgba(0,0,0,0.2)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[14px] font-semibold text-slate-900">
                    {getLabel(entry.type)}
                  </div>

                  <div className="text-[14px] font-semibold text-slate-900">
                    {formatEuro(entry.amount)}
                  </div>
                </div>

                <div className="mt-2 text-[12px] text-slate-500">
                  Job: {entry.jobId}
                </div>

                {entry.note ? (
                  <div className="mt-1 text-[12px] text-slate-400">
                    {entry.note}
                  </div>
                ) : null}
              </div>
            ))}
            {hiddenCount > 0 && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full rounded-[18px] bg-slate-50 px-4 py-3 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition active:bg-slate-100"
              >
                Weitere anzeigen ({hiddenCount} weitere)
              </button>
            )}
          </>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
