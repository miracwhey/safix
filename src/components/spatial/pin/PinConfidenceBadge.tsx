/**
 * Spatial Core · Block F.8 · Re-Scan Confidence Badge
 *
 * Visualises the D2 anchor-confidence state of a pin. Four levels:
 *
 *   - `high`   — green-solid, no noise; pin is on-anchor and trustworthy.
 *   - `medium` — amber-pulse-border + `?` icon; needs operator confirmation.
 *   - `low`    — rose-dashed + `!` icon; pin moved past drift threshold.
 *   - `lost`   — rose-dashed + `!` icon, greyed; surface no longer in scene.
 *
 * Click handler emits the badge id so the parent (PinDetailSheet or a
 * sweep-flow top banner) can open the appropriate disambiguation sheet.
 */

import type { ScanAnchorConfidence } from '../../../lib/spatial/types'

export interface PinConfidenceBadgeProps {
  confidence: ScanAnchorConfidence
  /** Optional click handler — opens the disambiguation sheet. */
  onClick?: () => void
  /** Compact mode for inline use (e.g. in the pin-list row). */
  compact?: boolean
}

interface BadgeStyle {
  copy: string
  icon: string
  classes: string
  pulse?: boolean
}

const STYLES: Record<ScanAnchorConfidence, BadgeStyle> = {
  high: {
    copy: 'sicher',
    icon: '●',
    classes: 'border-emerald-400 bg-emerald-50 text-emerald-700',
  },
  medium: {
    copy: 'prüfen',
    icon: '?',
    classes: 'border-amber-400 bg-amber-50 text-amber-700',
    pulse: true,
  },
  low: {
    copy: 'unsicher',
    icon: '!',
    classes:
      'border-dashed border-rose-400 bg-rose-50 text-rose-700 opacity-90',
  },
  lost: {
    copy: 'verloren',
    icon: '!',
    classes:
      'border-dashed border-rose-500 bg-neutral-100 text-rose-700 opacity-60',
  },
}

export function PinConfidenceBadge(props: PinConfidenceBadgeProps) {
  const style = STYLES[props.confidence]
  const size = props.compact ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-[11px]'
  const pulseRing = style.pulse ? 'animate-pulse' : ''
  const base = `inline-flex items-center gap-1 rounded-full border font-medium ${size} ${pulseRing} ${style.classes}`

  if (props.onClick) {
    return (
      <button
        type="button"
        onClick={props.onClick}
        className={base + ' hover:opacity-90'}
        aria-label={`Anker-Status: ${style.copy}`}
      >
        <span aria-hidden="true">{style.icon}</span>
        {style.copy}
      </button>
    )
  }
  return (
    <span className={base} aria-label={`Anker-Status: ${style.copy}`}>
      <span aria-hidden="true">{style.icon}</span>
      {style.copy}
    </span>
  )
}

/**
 * Top-banner aggregator — counts confidence levels and renders a single
 * "X Pins benötigen Bestätigung" CTA when the count is non-zero. The
 * sweep-flow itself (sequential walk) is parent-orchestrated to keep this
 * component pure.
 */
export interface ConfidenceSummaryBannerProps {
  counts: Record<ScanAnchorConfidence, number>
  onStartSweep?: () => void
}

export function ConfidenceSummaryBanner(props: ConfidenceSummaryBannerProps) {
  const reviewable =
    props.counts.medium + props.counts.low + props.counts.lost
  if (reviewable === 0) return null
  return (
    <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
      <span className="text-amber-800">
        {reviewable} Pin{reviewable === 1 ? '' : 's'} benötigen Bestätigung
      </span>
      {props.onStartSweep ? (
        <button
          type="button"
          onClick={props.onStartSweep}
          className="rounded-md bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-700"
        >
          Jetzt prüfen
        </button>
      ) : null}
    </div>
  )
}
