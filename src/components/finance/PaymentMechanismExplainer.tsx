import { Info } from 'lucide-react'
import type { CraftsmanPayoutSummary } from '../../lib/payout'

type Props = {
  summary: CraftsmanPayoutSummary | null
}

/**
 * Contextual one-liner explaining how the craftsman's money flows.
 *
 * Answers the global questions:
 * - Ist mein Geld sicher?
 * - Wird automatisch zur Auszahlung übergeben?
 * - Wohin geht das Geld?
 *
 * Derives text from existing payoutSummary — no new calculations.
 */
export default function PaymentMechanismExplainer({ summary }: Props) {
  const text = deriveExplanation(summary)
  if (!text) return null

  return (
    <div className="flex items-start gap-2.5 rounded-card bg-blue-50/60 px-4 py-3 ring-1 ring-blue-100">
      <Info size={16} className="mt-0.5 shrink-0 text-blue-400" aria-hidden />
      <p className="text-[13px] leading-snug text-blue-800">
        {text}
      </p>
    </div>
  )
}

function deriveExplanation(summary: CraftsmanPayoutSummary | null): string | null {
  if (!summary) return null

  const secured =
    summary.inEscrowNetEstimated +
    summary.releasePendingNetEstimated +
    summary.supplementaryAwaitingRelease

  const ready =
    summary.releasedPayoutEligible +
    summary.supplementaryReleased

  const blocked = summary.releasedPayoutBlocked
  const reversedFailed = summary.releasedPayoutReversedFailed
  const disputed = summary.disputedGross

  // Payout failed or transfer reversed (MoneyFlowProjection outcome truth) takes
  // priority over any concurrent paid-out money — never claim a handover happened
  // while a failure is unresolved (failure dominates, mirroring derivePayoutStatus).
  if (reversedFailed > 0) {
    return 'Eine Auszahlung konnte nicht abgeschlossen werden. SaFix prüft den Fall — dein Geld ist sicher verwahrt.'
  }

  // Both paid out and secured money exists
  if (ready > 0 && secured > 0) {
    return 'Freigegebenes Geld wurde an das Auszahlungskonto übergeben — Bankauszahlung erfolgt nach Stripe-Zeitplan. Gesichertes Geld wird nach Abschluss ebenfalls freigegeben.'
  }

  // Money already paid out
  if (ready > 0) {
    return 'Dein Geld wurde an das Auszahlungskonto übergeben. Bankauszahlung erfolgt nach Stripe-Zeitplan.'
  }

  // Money secured but payout blocked
  if (blocked > 0 && secured === 0) {
    return 'Dein Geld ist freigegeben, kann aber erst zur Auszahlung übergeben werden, wenn dein Auszahlungskonto bereit ist.'
  }

  // Money secured in escrow
  if (secured > 0) {
    return 'Kundengeld ist sicher verwahrt. Nach Abschluss und Freigabe wird automatisch zur Auszahlung übergeben.'
  }

  // Only disputed money
  if (disputed > 0) {
    return 'Das betroffene Geld ist eingefroren, bis der Konflikt geklärt ist.'
  }

  // No money in system
  return null
}
