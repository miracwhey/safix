import type { CraftsmanPayoutSummary } from '../../lib/payout'
import { formatEuro } from '../../lib/shared/formatters'

type Props = {
  summary: CraftsmanPayoutSummary
  onSetup?: () => void
}

// ── Internal row primitive ────────────────────────────────────────────────────

type BucketRowProps = {
  label: string
  amount: number
  tag: string
  tagStyle: string
}

function BucketRow({ label, amount, tag, tagStyle }: BucketRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-edge last:border-0">
      <span className="text-[14px] text-ink">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${tagStyle}`}
          data-tag={tag}
        >
          {tag}
        </span>
        <span className="text-[15px] font-semibold tabular-nums text-ink">
          {formatEuro(amount)}
        </span>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Simplified craftsman payout transparency section.
 *
 * Four clear buckets max:
 * 1. In Auszahlung — released + payout eligible (Stripe Transfer created)
 * 2. Gesichert — escrow + release_pending + supplementary awaiting (merged, estimated net)
 * 3. Eingefroren — disputed (only when > 0)
 * 4. Aktion nötig — released but payout blocked (only when > 0)
 */
export default function CraftsmanPayoutSummarySection({ summary, onSetup }: Props) {
  const {
    releasedPayoutEligible,
    releasedPayoutBlocked,
    releasedPayoutReversedFailed,
    inEscrowNetEstimated,
    releasePendingNetEstimated,
    disputedGross,
    supplementaryReleased,
    supplementaryAwaitingRelease,
    platformFeeCollected,
    payoutBlockingReason,
  } = summary

  // Merged buckets
  const readyAmount = releasedPayoutEligible + supplementaryReleased
  const securedAmount = inEscrowNetEstimated + releasePendingNetEstimated + supplementaryAwaitingRelease

  return (
    <div className="space-y-3">
      {/* Blocking reason — calm informational banner, never aggressive.
          Shown for any non-ready state (no_account, onboarding, payout_blocked)
          as long as a blocking explanation is available. */}
      {payoutBlockingReason && (
        <div
          className="rounded-card bg-rose-50 px-4 py-3 ring-1 ring-rose-200"
          data-testid="payout-blocking-reason"
        >
          <p className="text-[13px] font-medium leading-snug text-rose-800">
            {payoutBlockingReason}
          </p>
          {onSetup !== undefined && (
            <button
              type="button"
              onClick={onSetup}
              className="mt-2 text-[13px] font-semibold text-rose-700 underline underline-offset-2 transition hover:text-rose-900"
            >
              Auszahlungskonto einrichten →
            </button>
          )}
        </div>
      )}

      {/* Bucket rows — max 4, clear categories */}
      <div className="rounded-card bg-surface ring-1 ring-edge shadow-subtle px-4">
        {/* In Auszahlung — released + Stripe Transfer created */}
        <BucketRow
          label="In Auszahlung"
          amount={readyAmount}
          tag="Übergeben"
          tagStyle="bg-emerald-100 text-emerald-700"
        />

        {/* Gesichert — merged escrow + release_pending + supplementary awaiting */}
        {securedAmount > 0 && (
          <BucketRow
            label="Gesichert"
            amount={securedAmount}
            tag="Sicher"
            tagStyle="bg-blue-100 text-blue-700"
          />
        )}

        {/* Eingefroren — disputed, only when active */}
        {disputedGross > 0 && (
          <BucketRow
            label="Eingefroren"
            amount={disputedGross}
            tag="Konflikt"
            tagStyle="bg-orange-100 text-orange-700"
          />
        )}

        {/* Aktion nötig — released but payout blocked, only when > 0 */}
        {releasedPayoutBlocked > 0 && (
          <BucketRow
            label="Aktion nötig"
            amount={releasedPayoutBlocked}
            tag="Blockiert"
            tagStyle="bg-rose-100 text-rose-700"
          />
        )}

        {/* In Klärung — payout failed or transfer reversed (MoneyFlowProjection
            payout_failed / transfer_reversed). NEVER shown as "In Auszahlung":
            the money is not on its way to the craftsman. */}
        {releasedPayoutReversedFailed > 0 && (
          <BucketRow
            label="In Klärung"
            amount={releasedPayoutReversedFailed}
            tag="Klärung"
            tagStyle="bg-amber-100 text-amber-700"
          />
        )}
      </div>

      {/* Estimation note — "Gesichert" amounts are estimated net after fee */}
      {securedAmount > 0 && (
        <p className="px-1 text-[12px] text-ink-muted">
          Gesicherte Beträge voraussichtlich nach Abzug der SaFix-Gebühr.
        </p>
      )}

      {/* Platform-fee transparency — only exact collected amount, no estimates */}
      {platformFeeCollected > 0 && (
        <p className="px-1 text-[12px] text-ink-muted" data-testid="platform-fee-note">
          SaFix-Gebühr: {formatEuro(platformFeeCollected)}
        </p>
      )}
    </div>
  )
}
