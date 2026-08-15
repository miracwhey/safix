import { useState } from 'react'
import {
  subscribeRatings,
  getRatingsByProviderUserId,
  deriveProviderReputation,
  formatAverageRating,
} from '../../lib/ratings'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  providerUserId: string
  /**
   * Optional display name for the provider.  When provided it is shown in the
   * tooltip / expanded view for context.
   */
  displayName?: string
  /** Controls whether the full reputation breakdown is shown (default: false). */
  expanded?: boolean
}

function StarBar({ score, count, max }: { score: number; count: number; max: number }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 text-right text-[11px] font-semibold text-slate-500">{score}</span>
      <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-slate-400 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-4 text-right text-[11px] text-slate-400">{count}</span>
    </div>
  )
}

function StarDisplay({ score }: { score: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${score} von 5 Sternen`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span
          key={s}
          className="text-[14px] leading-none"
          style={{ color: s <= Math.round(score) ? '#F59E0B' : '#CBD5E1' }}
          aria-hidden
        >
          ★
        </span>
      ))}
    </span>
  )
}

export default function ProviderReputationBadge({
  providerUserId,
  expanded = false,
}: Props) {
  const [reputation, setReputation] = useState(() =>
    deriveProviderReputation(providerUserId, getRatingsByProviderUserId(providerUserId))
  )

  useStoreSync([subscribeRatings], () => {
    setReputation(
      deriveProviderReputation(providerUserId, getRatingsByProviderUserId(providerUserId))
    )
  })

  const avgLabel = formatAverageRating(reputation)
  const hasRatings = reputation.ratingCount > 0

  if (!expanded) {
    // Compact inline badge — keep amber for universal star-rating convention
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 ring-1 ring-amber-200/80">
        <span className="text-amber-500 text-[14px] leading-none" aria-hidden>★</span>
        <span className="text-[13px] font-bold text-amber-700">{avgLabel}</span>
        {hasRatings && (
          <span className="text-[11px] text-amber-500">
            ({reputation.ratingCount})
          </span>
        )}
      </div>
    )
  }

  // ── Expanded: Empty state ────────────────────────────────────────────────
  if (!hasRatings) {
    return (
      <div className="flex items-start gap-3 border-t border-slate-100 pt-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100">
          <span className="text-[14px] leading-none" style={{ color: '#CBD5E1' }} aria-hidden>★</span>
        </div>
        <div>
          <p className="text-[14px] font-semibold text-slate-600 leading-snug">
            Noch keine Bewertungen
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">
            Kundenbewertungen erscheinen hier nach abgeschlossenen Aufträgen.
          </p>
        </div>
      </div>
    )
  }

  // ── Expanded: Summary with ratings ──────────────────────────────────────
  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_2px_12px_-4px_rgba(2,6,23,0.08)]">
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200" />

      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Bewertungen
        </span>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-slate-500">
          {reputation.ratingCount} {reputation.ratingCount === 1 ? 'BEWERTUNG' : 'BEWERTUNGEN'}
        </span>
      </div>

      {/* Score + stars */}
      <div className="mt-3 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100">
          <span className="text-[20px] leading-none" aria-hidden>⭐</span>
        </div>
        <div>
          <p className="text-[22px] font-bold text-slate-800 leading-none">
            {avgLabel}
            <span className="ml-1 text-[14px] font-normal text-slate-400">/ 5</span>
          </p>
          <StarDisplay score={reputation.averageRating} />
        </div>
      </div>

      {/* Distribution bars */}
      <div className="mt-4 space-y-1">
        {([5, 4, 3, 2, 1] as const).map((score) => (
          <StarBar
            key={score}
            score={score}
            count={reputation.ratingDistribution[score]}
            max={reputation.ratingCount}
          />
        ))}
      </div>
    </section>
  )
}
