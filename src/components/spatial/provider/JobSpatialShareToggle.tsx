/**
 * Spatial · Lane 3 V1.6 Block 2 · JobSpatialShareToggle
 *
 * Card-Component for the HW Job-Spatial shell-header. Surfaces:
 *
 *   - Status-Pill showing `Privat` (default) vs `Mit Kundin geteilt` + the
 *     `shared_at` timestamp once shared.
 *   - Toggle-Button "Mit Kundin teilen" / "Freigabe zurückziehen".
 *   - On first share per job (D3 · per-job einmalig), opens
 *     `ConfirmShareDialog` with the DSGVO-Hinweis. Subsequent shares within
 *     the same job skip the dialog (sticky `localStorage` flag).
 *   - Empty-State (D5): when `scan === null` the card stays mounted but
 *     disables the toggle + shows a hint "3D-Aufmaß erforderlich vor Teilen"
 *     (chose Discoverability over hiding — explicit handover doc decision).
 *
 * Granularity (D2 · 1 Toggle pro Scan): the component takes exactly one
 * `Scan` and toggles that scan's `shared_with_customer` column. Multi-scan
 * jobs render multiple cards rather than a job-wide master toggle.
 *
 * Push (D4): the workflow emits `spatial_shared_with_customer` ONLY on a
 * meaningful share→true transition. Unshare is silent. The Toggle does not
 * need to know about push — that's wired in the workflow.
 *
 * Pattern reference: SpatialOfferStatusCard (tone-based status pill +
 * icon-circle + headline + sub-label).
 */

import { useCallback, useMemo, useState } from 'react'
import { Lock, Share2, ShieldCheck, AlertCircle } from 'lucide-react'

import { useHaptics } from '../../../hooks/useHaptics'
import { useToast } from '../../../hooks/useToast'
import { useShareScanWithCustomer } from '../../../lib/spatial/hooks/useShareScanWithCustomer'
import type { Scan } from '../../../lib/spatial/types'
import { ConfirmShareDialog } from './ConfirmShareDialog'

export interface JobSpatialShareToggleProps {
  /**
   * The job-anchored scan to toggle. `null` while the job has no scan yet —
   * the card renders its disabled empty-state instead of hiding.
   */
  scan: Scan | null
  /** Job id (used both as RBAC anchor for the workflow + localStorage key). */
  jobId: string
  /** Customer first name for the dialog body (falls back to "die Kundin"). */
  customerLabel?: string | null
  /**
   * Called after a successful flip — host can refresh the scene/scans hook
   * so the Realtime path is not the only refresh signal. Optional.
   */
  onSuccess?: (next: Scan) => void
}

const LS_PREFIX = 'spatial-share-confirmed:'

function alreadyConfirmedForJob(jobId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LS_PREFIX + jobId) === '1'
  } catch {
    return false
  }
}

function markConfirmedForJob(jobId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LS_PREFIX + jobId, '1')
  } catch {
    // localStorage may be full or disabled (private mode) — failing the write
    // is acceptable; the next share simply re-opens the dialog.
  }
}

function formatShareTimestamp(ms: number | null): string {
  if (!ms) return ''
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

export function JobSpatialShareToggle({
  scan,
  jobId,
  customerLabel,
  onSuccess,
}: JobSpatialShareToggleProps) {
  const haptics = useHaptics()
  const toast = useToast()
  const { toggle, busy } = useShareScanWithCustomer()
  const [dialogOpen, setDialogOpen] = useState(false)

  const shared = scan?.sharedWithCustomer === true
  const disabled = scan === null || busy

  const performToggle = useCallback(
    async (value: boolean) => {
      if (!scan) return
      const result = await toggle({ scanId: scan.id, value })
      if (!result.ok) {
        toast.error(result.message)
        haptics.error()
        return
      }
      if (value && result.changed) {
        markConfirmedForJob(jobId)
        toast.info('Aufmaß ist jetzt für die Kundin sichtbar.')
        haptics.success()
      } else if (!value && result.changed) {
        toast.info('Freigabe zurückgezogen.')
        haptics.selection()
      }
      onSuccess?.(result.scan)
    },
    [scan, toggle, toast, haptics, jobId, onSuccess],
  )

  const onToggleClick = useCallback(() => {
    if (!scan || busy) return
    if (shared) {
      void performToggle(false)
      return
    }
    if (alreadyConfirmedForJob(jobId)) {
      void performToggle(true)
      return
    }
    haptics.selection()
    setDialogOpen(true)
  }, [scan, busy, shared, jobId, haptics, performToggle])

  const onDialogConfirm = useCallback(async () => {
    await performToggle(true)
    setDialogOpen(false)
  }, [performToggle])

  const onDialogCancel = useCallback(() => {
    setDialogOpen(false)
  }, [])

  const statusLabel = useMemo(() => {
    if (scan === null) return 'Noch kein Aufmaß'
    if (shared) return 'Mit Kundin geteilt'
    return 'Privat'
  }, [scan, shared])

  const sublabel = useMemo(() => {
    if (scan === null) {
      return '3D-Aufmaß erforderlich, bevor du es teilen kannst.'
    }
    if (shared) {
      const ts = formatShareTimestamp(scan.sharedAt)
      return ts
        ? `Freigegeben am ${ts}. Kundin sieht 3D + Maße + freigegebene Pins.`
        : 'Kundin sieht 3D + Maße + freigegebene Pins.'
    }
    return 'Aufmaß ist privat. Tippe „Mit Kundin teilen", um es freizugeben.'
  }, [scan, shared])

  const toneClasses =
    scan === null
      ? 'border-edge bg-surface'
      : shared
        ? 'border-[#A7F3D0] bg-[#ECFDF5]'
        : 'border-[#DBEAFE] bg-[#EFF6FF]'

  const iconWrapClasses =
    scan === null
      ? 'bg-slate-100 text-ink-muted'
      : shared
        ? 'bg-[#D1FAE5] text-[#047857]'
        : 'bg-white text-brand'

  const Icon = scan === null ? AlertCircle : shared ? ShieldCheck : Lock

  const buttonLabel = shared
    ? 'Freigabe zurückziehen'
    : scan === null
      ? 'Aufmaß fehlt'
      : 'Mit Kundin teilen'

  const buttonClasses = shared
    ? 'border border-[#A7F3D0] bg-white text-[#065F46] hover:bg-[#F0FDF4]'
    : 'border border-brand/30 bg-brand text-white hover:opacity-95'

  return (
    <>
      <div
        role="group"
        aria-label="Aufmaß-Freigabe"
        className={`mx-3 mb-2 flex items-start gap-[10px] rounded-[14px] border px-[12px] py-[10px] ${toneClasses}`}
      >
        <span
          className={`mt-[1px] flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full ${iconWrapClasses}`}
          aria-hidden="true"
        >
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-bold leading-snug text-ink">{statusLabel}</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-sub">{sublabel}</p>
        </div>
        <button
          type="button"
          onClick={onToggleClick}
          disabled={disabled}
          aria-pressed={shared}
          className={`shrink-0 rounded-[10px] px-3 py-1.5 text-[11.5px] font-bold transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${buttonClasses}`}
        >
          <span className="inline-flex items-center gap-1">
            {!shared && scan !== null && <Share2 size={11} aria-hidden="true" />}
            {buttonLabel}
          </span>
        </button>
      </div>

      {dialogOpen && (
        <ConfirmShareDialog
          customerLabel={customerLabel}
          submitting={busy}
          onCancel={onDialogCancel}
          onConfirm={onDialogConfirm}
        />
      )}
    </>
  )
}

export default JobSpatialShareToggle
