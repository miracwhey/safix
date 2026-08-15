import type { LedgerEntry, LedgerEntryType } from '../../lib/payments/ledger/ledgerTypes'
import { formatEuro, formatRelativeTime } from '../../lib/shared/formatters'
import ContentSection from '../primitives/ContentSection'

const ENTRY_CONFIG: Record<
  LedgerEntryType,
  { label: string; dotColor: string; sign: '+' | '-' } | null
> = {
  payout: { label: 'Zur Auszahlung übergeben', dotColor: 'bg-emerald-500', sign: '+' },
  escrow_created: { label: 'Zahlung eingegangen', dotColor: 'bg-blue-500', sign: '+' },
  deposit_paid: { label: 'Anzahlung erhalten', dotColor: 'bg-blue-500', sign: '+' },
  final_paid: { label: 'Restzahlung erhalten', dotColor: 'bg-blue-500', sign: '+' },
  platform_fee: { label: 'Plattformgebühr', dotColor: 'bg-slate-400', sign: '-' },
  dispute_hold: { label: 'Betrag eingefroren', dotColor: 'bg-orange-500', sign: '-' },
  dispute_resolved_release: { label: 'Konflikt gelöst — Auszahlung', dotColor: 'bg-emerald-500', sign: '+' },
  dispute_resolved_refund: { label: 'Konflikt gelöst — Rückerstattung', dotColor: 'bg-rose-500', sign: '-' },
  refund: { label: 'Rückerstattung', dotColor: 'bg-rose-500', sign: '-' },
  supplementary_created: { label: 'Nachzahlungsbedarf (Nachtrag)', dotColor: 'bg-amber-500', sign: '+' },
  supplementary_funded: { label: 'Nachzahlung eingegangen', dotColor: 'bg-blue-500', sign: '+' },
  supplementary_platform_fee: { label: 'Plattformgebühr (Nachtrag)', dotColor: 'bg-slate-400', sign: '-' },
  supplementary_payout: { label: 'Nachtrag zur Auszahlung übergeben', dotColor: 'bg-emerald-500', sign: '+' },
  transfer_reversal: { label: 'Überweisung storniert — Klärung läuft', dotColor: 'bg-amber-500', sign: '-' },
}

const MAX_ENTRIES = 5

type RecentActivitySectionProps = {
  entries: LedgerEntry[]
  craftsmanPaymentIds: Set<string>
}

export default function RecentActivitySection({
  entries,
  craftsmanPaymentIds,
}: RecentActivitySectionProps) {
  const relevant = entries
    .filter((e) => craftsmanPaymentIds.has(e.paymentId) && ENTRY_CONFIG[e.type])
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)

  if (relevant.length === 0) {
    // No ledger entries at all → hide section entirely
    if (craftsmanPaymentIds.size === 0) return null

    // Payments exist but no ledger entries yet → truthful empty state
    return (
      <ContentSection eyebrow="Aktivität" title="Letzte Bewegungen">
        <p className="text-[13px] text-ink-muted">
          Verlauf startet nach der ersten Geldbewegung.
        </p>
      </ContentSection>
    )
  }

  return (
    <ContentSection eyebrow="Aktivität" title="Letzte Bewegungen">
      <div className="space-y-3">
        {relevant.map((entry) => {
          const config = ENTRY_CONFIG[entry.type]!
          return (
            <div key={entry.id} className="flex items-center gap-3">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${config.dotColor}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{config.label}</p>
                <p className="text-[11px] text-ink-muted">
                  {formatRelativeTime(entry.createdAt)}
                </p>
              </div>
              <span
                className={`shrink-0 text-[14px] font-semibold ${
                  config.sign === '+' ? 'text-emerald-600' : 'text-ink-muted'
                }`}
              >
                {config.sign}
                {formatEuro(entry.amount)}
              </span>
            </div>
          )
        })}
      </div>
    </ContentSection>
  )
}
