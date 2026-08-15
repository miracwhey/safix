/**
 * Spatial V1.6.1 · Item #3 · CaptureResumeSheet
 *
 * Bottom-sheet mounted on Customer-Hub when a previous LiDAR session left a
 * cached USDZ blob behind (mid-scan crash, app-kill before upload, network
 * drop). Three terminal actions, matching the V1.5.1 HW Resume sheet's
 * mental model but skinned + worded for the customer surface
 * (feedback_customer_skin_no_feature_loss — no feature-loss vs HW, just
 * customer wording).
 *
 *   - Fortsetzen — runs `resumePendingCustomerCapture()` against the cached
 *     blob; a brand-new scan row + storage upload is produced.
 *   - Verwerfen — drops the cache entry. Inline confirmation (a second tap
 *     within 4 s) so a stray double-tap can't delete user-work silently.
 *   - Schließen — defers the decision to the next mount. ESC + backdrop
 *     also map here so the user always has a passive escape.
 *
 * Wording lock (per V1.6.1 plan):
 *   - Headline   "Letzten Scan fortsetzen?"
 *   - Body       "Du hast einen Scan-Versuch begonnen. Soll der fortgesetzt
 *                 oder verworfen werden?"
 *
 * Mockup-coherent visual: dark glass like CaptureDsgvoConsentSheet (same
 * navy panel, same border + blur), not the V1.5.1 light Hub sheet — the
 * V1.6 Customer Hub is dark by default and a light sheet on top would jar.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import BottomSheet from '../../ui/BottomSheet'

export interface CaptureResumeSheetProps {
  open: boolean
  /** Optional human-readable "started X ago" hint. Falls back to "vorhin"
   *  when omitted so the sheet still renders for cache rows without a
   *  formatted timestamp. */
  startedLabel?: string | null
  /** Optional room-label rendered above the body — comes from the scan
   *  row's quality_label-derived sub-title. Hidden when null. */
  roomLabel?: string | null
  /** True while the resume workflow is in-flight — disables the primary CTA. */
  resuming?: boolean
  /** True while the discard call is in-flight — disables the secondary CTA. */
  discarding?: boolean
  onResume: () => void
  onDiscard: () => void
  onDismiss: () => void
}

/**
 * 4 s inline-confirm window for the destructive discard tap. Matches the
 * pattern from the HW ResumePendingScanSheet so the two surfaces stay
 * mentally coherent for ops.
 */
const DISCARD_CONFIRM_WINDOW_MS = 4_000

export default function CaptureResumeSheet({
  open,
  startedLabel,
  roomLabel,
  resuming = false,
  discarding = false,
  onResume,
  onDiscard,
  onDismiss,
}: CaptureResumeSheetProps) {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const [discardArmed, setDiscardArmed] = useState(false)

  // Auto-focus the primary CTA on open — keyboard parity + reduces a-double-
  // tap-needed UX friction on iPad. Mirrors CaptureDsgvoConsentSheet.
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (alive) primaryButtonRef.current?.focus()
    })
    return () => {
      alive = false
    }
  }, [open])

  // Reset the armed-state whenever the sheet closes so a re-open never
  // starts mid-confirm. Pushed off the synchronous effect tick to satisfy
  // `react-hooks/set-state-in-effect` (matches the Hub's existing pattern).
  useEffect(() => {
    if (open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (alive) setDiscardArmed(false)
    })
    return () => {
      alive = false
    }
  }, [open])

  // Disarm the discard-confirm automatically after the 4-s window so a
  // user who hesitated has to opt in again. The effect cleans itself up
  // on next change.
  useEffect(() => {
    if (!discardArmed) return
    const handle = window.setTimeout(
      () => setDiscardArmed(false),
      DISCARD_CONFIRM_WINDOW_MS,
    )
    return () => window.clearTimeout(handle)
  }, [discardArmed])

  const handleDiscardClick = useCallback(() => {
    if (!discardArmed) {
      setDiscardArmed(true)
      return
    }
    onDiscard()
  }, [discardArmed, onDiscard])

  const handleResumeClick = useCallback(() => {
    setDiscardArmed(false)
    onResume()
  }, [onResume])

  return (
    <BottomSheet
      open={open}
      onClose={onDismiss}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="capture-resume-title">
        <h3 id="capture-resume-title" className="text-base font-bold text-white">
          Letzten Scan fortsetzen?
        </h3>
        <p className="mt-1 text-xs text-white/65">
          Du hast einen Scan-Versuch begonnen. Soll der fortgesetzt oder verworfen werden?
        </p>

        <div
          className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4"
          data-testid="capture-resume-meta"
        >
          <div className="text-[13px] font-semibold text-white">
            {roomLabel ?? 'Dein 3D-Aufmaß'}
          </div>
          <div className="mt-0.5 text-[12px] text-white/60">
            Begonnen {startedLabel ?? 'vorhin'} · noch nicht hochgeladen
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2.5">
          <button
            ref={primaryButtonRef}
            type="button"
            onClick={handleResumeClick}
            disabled={resuming || discarding}
            data-testid="capture-resume-primary"
            className="w-full rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-sky-900/40 transition hover:from-sky-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-sky-300/60 disabled:opacity-60"
          >
            {resuming ? 'Wird hochgeladen …' : 'Fortsetzen'}
          </button>
          <button
            type="button"
            onClick={handleDiscardClick}
            disabled={resuming || discarding}
            aria-pressed={discardArmed}
            data-testid="capture-resume-discard"
            className={
              'w-full rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:opacity-60 ' +
              (discardArmed
                ? 'bg-rose-600/90 text-white border border-rose-400/40 hover:bg-rose-600'
                : 'border border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/[0.08]')
            }
          >
            {discardArmed ? 'Wirklich verwerfen?' : 'Verwerfen'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            data-testid="capture-resume-dismiss"
            className="mx-auto rounded-full px-3 py-1.5 text-[12.5px] font-medium text-white/55 transition hover:text-white/80"
          >
            Später entscheiden
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
