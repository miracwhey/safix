/**
 * Spatial · Lane 3 V1.6 Block 2 · ConfirmShareDialog
 *
 * Confirm-step for the HW "Mit Kundin teilen" toggle on
 * `CraftsmanJobSpatialDetailScreen`. Surfaces the DSGVO-Hinweis required for
 * App-Store-Review (the Customer becomes able to see the 3D-Aufmaß, Maße,
 * Material, and freigegebene Pins).
 *
 * Persistence (Block 2 D3 · per-job einmalig): the parent (JobSpatialShareToggle)
 * gates whether to open this dialog at all via a `localStorage` flag keyed by
 * jobId — folge-Shares im selben Job laufen ohne Dialog. This component is
 * deliberately presentational; it does not write the flag.
 *
 * Pattern reference: PresalesJobConversionModal (V1.5 Phase B-P3) — glass-
 * modal + focus-trap + Escape-dismiss + DSGVO-hint + Cancel/Confirm row.
 */

import { useCallback, useEffect, useRef } from 'react'
import { ShieldCheck } from 'lucide-react'

import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'
import { useHaptics } from '../../../hooks/useHaptics'

const MODAL_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.92)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 24px 60px rgba(15,23,42,0.28), 0 1px 0 rgba(255,255,255,0.6) inset',
}

export interface ConfirmShareDialogProps {
  /** Customer first name for the body copy (falls back to "der Kundin"). */
  customerLabel?: string | null
  /** True while the parent's mutation is in flight — Cancel/Confirm disable. */
  submitting?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmShareDialog({
  customerLabel,
  submitting = false,
  onCancel,
  onConfirm,
}: ConfirmShareDialogProps) {
  const haptics = useHaptics()
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  // Escape dismisses unless submitting (mirrors PresalesJobConversionModal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [submitting, onCancel])

  const handleConfirm = useCallback(() => {
    if (submitting) return
    haptics.success()
    onConfirm()
  }, [submitting, haptics, onConfirm])

  const handleCancel = useCallback(() => {
    if (submitting) return
    haptics.selection()
    onCancel()
  }, [submitting, haptics, onCancel])

  const whoCopy = customerLabel?.trim()
    ? `${customerLabel.trim()}`
    : 'die Kundin'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(3px)' }}
      onClick={handleCancel}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="spatial-share-confirm-title"
        aria-describedby="spatial-share-confirm-body"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[460px] flex-col rounded-t-[28px] px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 sm:rounded-[24px]"
        style={MODAL_GLASS}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15 sm:hidden" />

        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
            <ShieldCheck size={20} />
          </span>
          <div className="min-w-0">
            <h2
              id="spatial-share-confirm-title"
              className="text-[18px] font-bold tracking-tight text-slate-900"
            >
              Aufmaß freigeben?
            </h2>
            <p
              id="spatial-share-confirm-body"
              className="mt-1 text-[13px] leading-snug text-slate-600"
            >
              {whoCopy} kann anschließend das 3D-Modell, die Maße,
              ausgewählte Materialien und alle für sie freigegebenen Pins
              sehen. Du kannst die Freigabe jederzeit zurückziehen.
            </p>
          </div>
        </div>

        <div
          role="note"
          className="mt-4 flex items-start gap-2 rounded-xl bg-slate-100/80 px-3 py-2 text-[11.5px] leading-snug text-slate-600 ring-1 ring-slate-200"
        >
          <svg viewBox="0 0 20 20" className="mt-px size-3.5 shrink-0 text-slate-500" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 2.5a1.5 1.5 0 0 0-1.5 1.5v.7a6.5 6.5 0 0 0-3.55 11.31l-.7.7a.75.75 0 1 0 1.05 1.07l.74-.7A6.5 6.5 0 0 0 14 16.83l.7.7a.75.75 0 1 0 1.06-1.06l-.7-.7A6.5 6.5 0 0 0 11.5 4.7V4A1.5 1.5 0 0 0 10 2.5Zm-.75 5.75a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0v-3ZM10 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            Die Datenübertragung erfolgt im Rahmen des Auftrags (DSGVO
            Art. 6 Abs. 1 lit. b). Private Pins, interne Notizen und nicht
            freigegebene Materialien bleiben verborgen.
          </span>
        </div>

        <div className="mt-4 flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            className="flex-1 rounded-[13px] border border-slate-200 bg-white/80 py-3 text-[14px] font-semibold text-slate-700 active:scale-[0.98] disabled:opacity-40"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="flex-1 rounded-[13px] bg-slate-900 py-3 text-[14px] font-bold text-white shadow-md active:scale-[0.98] disabled:opacity-60"
          >
            {submitting ? 'Gebe frei …' : 'Freigeben'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmShareDialog
