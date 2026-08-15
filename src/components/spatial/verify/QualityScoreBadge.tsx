/**
 * Spatial · Verify · QualityScoreBadge (Phase 3 · Block 3.2 · VF-1)
 *
 * The simplified Quality-Score display for the Stage-1 Welcome card (VF-1):
 * ONE number (0-100) + ONE German label. Tapping it opens the Detail-Sheet
 * (Mockup 14) — wired by a future block; the `onOpenDetail` prop is the seam.
 *
 * "Simplified" (VF-1 · binding) means: no inline rule-list, no per-warning
 * breakdown — just the score + label. The full warning report stays available
 * through the tap-through detail sheet.
 *
 * The score itself is NOT computed here — it comes from the canonical
 * `runQualityEngine` via `deriveVerifySceneSummary`. This component is pure
 * presentation over a {@link QualityResult}.
 */

import type { ReactElement } from 'react'

import type { QualityResult } from '../../../lib/spatial/quality/qualityEngine'

export interface QualityScoreBadgeProps {
  /** The simplified quality result (score + bucket). */
  quality: QualityResult
  /** German label for the bucket (e.g. "Gut"). */
  label: string
  /**
   * Open the Quality-Detail sheet (Mockup 14). When omitted the badge is
   * non-interactive — it still shows the score, just without the tap-through.
   */
  onOpenDetail?: () => void
}

/** Tailwind colour set per bucket — green/teal high, amber mid, rose low. */
const BUCKET_THEME: Record<
  QualityResult['bucket'],
  { ring: string; bg: string; score: string }
> = {
  excellent: { ring: 'border-teal-700/20', bg: 'bg-teal-700/[0.08]', score: 'text-teal-700' },
  good: { ring: 'border-teal-700/20', bg: 'bg-teal-700/[0.08]', score: 'text-teal-700' },
  fair: { ring: 'border-amber-600/25', bg: 'bg-amber-500/10', score: 'text-amber-700' },
  poor: { ring: 'border-rose-600/25', bg: 'bg-rose-500/10', score: 'text-rose-700' },
}

export function QualityScoreBadge({
  quality,
  label,
  onOpenDetail,
}: QualityScoreBadgeProps): ReactElement {
  const theme = BUCKET_THEME[quality.bucket]
  const interactive = typeof onOpenDetail === 'function'

  const content = (
    <>
      <div className="shrink-0">
        <div className={`text-[28px] font-extrabold leading-none ${theme.score}`}>
          {quality.score}
        </div>
        <div className="mt-0.5 text-[11px] uppercase tracking-[1px] text-slate-400">
          / 100
        </div>
      </div>
      <div className="flex-1 text-[13px] font-medium leading-tight text-slate-500">
        <strong className="font-bold text-slate-900">{label}</strong>
        {' · Aufmaß-Qualität'}
      </div>
      {interactive && (
        <span aria-hidden="true" className="text-[15px] text-slate-400">
          ›
        </span>
      )}
    </>
  )

  const className = `flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left ${theme.ring} ${theme.bg}`

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onOpenDetail}
        className={`${className} transition active:scale-[0.99]`}
        aria-label={`Aufmaß-Qualität ${quality.score} von 100 · ${label} · Details öffnen`}
        data-testid="quality-score-badge"
      >
        {content}
      </button>
    )
  }

  return (
    <div
      className={className}
      aria-label={`Aufmaß-Qualität ${quality.score} von 100 · ${label}`}
      data-testid="quality-score-badge"
    >
      {content}
    </div>
  )
}
