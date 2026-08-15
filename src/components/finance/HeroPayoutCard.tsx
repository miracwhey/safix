import { formatEuro } from '../../lib/shared/formatters'
import type { CraftsmanPayoutSummary } from '../../lib/payout'

type HeroPayoutCardProps = {
  summary: CraftsmanPayoutSummary | null
}

export default function HeroPayoutCard({ summary }: HeroPayoutCardProps) {
  const auszahlbar =
    (summary?.releasedPayoutEligible ?? 0) +
    (summary?.supplementaryReleased ?? 0)
  // Freigabefähig = eligible_for_release tranche amounts (action available NOW)
  const freigabefaehig = summary?.releasableNetEstimated ?? 0
  // Gesichert = money safely held across escrow/release stages (NOT including auszahlbar or freigabefähig)
  const gesichert =
    (summary?.inEscrowNetEstimated ?? 0) +
    (summary?.releasePendingNetEstimated ?? 0) +
    (summary?.supplementaryAwaitingRelease ?? 0)

  // Money whose payout failed / was reversed (outcome truth from
  // MoneyFlowProjection): never counted as auszahlbar/received; surfaced as its own
  // "In Klärung" state so it is neither claimed as paid out nor hidden behind the
  // empty zero-state.
  const reversedFailed = summary?.releasedPayoutReversedFailed ?? 0

  const hasAuszahlbar = auszahlbar > 0
  const hasFreigabefaehig = freigabefaehig > 0
  const hasGesichert = gesichert > 0
  const hasReversedFailed = reversedFailed > 0

  const heroAmount = hasAuszahlbar
    ? auszahlbar
    : hasFreigabefaehig
      ? freigabefaehig
      : hasGesichert
        ? gesichert
        : reversedFailed
  const heroLabel = hasAuszahlbar
    ? 'In Auszahlung'
    : hasFreigabefaehig
      ? 'Freigabefähig'
      : hasGesichert
        ? 'Gesichert'
        : hasReversedFailed
          ? 'In Klärung'
          : ''

  return (
    <div className="rounded-card bg-brand p-5 shadow-elevated">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/60">
        Dein Geld
      </p>

      {hasGesichert || hasAuszahlbar || hasReversedFailed ? (
        <>
          <p className="mt-2 text-[32px] font-bold leading-none text-white">
            {formatEuro(heroAmount)}
          </p>
          <p className="mt-1 text-[14px] font-medium text-white/80">
            {heroLabel}
          </p>

          {hasAuszahlbar && (gesichert > 0 || freigabefaehig > 0) && (
            <p className="mt-3 border-t border-white/15 pt-3 text-[13px] text-white/55">
              {freigabefaehig > 0 && `${formatEuro(freigabefaehig)} freigabefähig`}
              {freigabefaehig > 0 && gesichert > 0 && ' · '}
              {gesichert > 0 && `${formatEuro(gesichert)} gesichert`}
              {' '}(voraussichtlich nach Gebühr)
            </p>
          )}

          {!hasAuszahlbar && hasFreigabefaehig && gesichert > 0 && (
            <p className="mt-3 border-t border-white/15 pt-3 text-[13px] text-white/55">
              {formatEuro(gesichert)} gesichert (voraussichtlich nach Gebühr)
            </p>
          )}

          {!hasAuszahlbar && !hasFreigabefaehig && hasGesichert && (
            <p className="mt-1 text-[12px] text-white/45">
              voraussichtlich nach Gebühr
            </p>
          )}

          {hasReversedFailed && (hasAuszahlbar || hasFreigabefaehig || hasGesichert) && (
            <p className="mt-3 border-t border-white/15 pt-3 text-[13px] text-amber-200/90">
              {formatEuro(reversedFailed)} in Klärung
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-[28px] font-bold leading-none text-white/80">
            {formatEuro(0)}
          </p>
          <p className="mt-2 text-[14px] text-white/60">
            Starte deinen ersten Auftrag
          </p>
        </>
      )}
    </div>
  )
}
