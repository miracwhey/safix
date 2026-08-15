import BottomSheet from '../ui/BottomSheet'
import type { CorrectionRequest } from '../../lib/corrections'

/**
 * Confirm-Sheet für Push-getriggertes APPROVE auf einer Korrektur.
 *
 * Mount-Trigger: `CraftsmanKorrekturDetailScreen` liest `?action=approve`
 * aus der URL und mountet diesen Sheet. Der Push-Action-Dispatcher (Layer 2)
 * setzt den Param, nachdem er Schema/Expiry/Role/Idempotenz validiert hat —
 * das Sheet selbst macht KEINE Sicherheits-Checks mehr, sondern verlässt
 * sich auf den Workflow-Layer-Guard (`assertOwnerRole`) im Caller.
 *
 * Sicherheits-Default: Confirm-Sheet ist Pflicht auch bei APPROVE — schützt
 * vor Lockscreen-Versehen, geringe UX-Reibung. Kein One-Tap-Approve.
 *
 * Controlled component: Parent (Screen) hält den Workflow-State (loading,
 * error). Sheet rendert nur das, was Parent vorgibt. So ist die Sheet-Logik
 * konsistent mit dem manuellen Approve-Pfad im KorrekturDetail-Screen.
 */
export interface CorrectionApproveSheetProps {
  open: boolean
  correction: CorrectionRequest
  workerName: string
  isSubmitting: boolean
  errorMessage: string | null
  onConfirm: () => void
  onCancel: () => void
}

export default function CorrectionApproveSheet({
  open,
  correction,
  workerName,
  isSubmitting,
  errorMessage,
  onConfirm,
  onCancel,
}: CorrectionApproveSheetProps) {
  const proposedValue = correction.proposedValue
  const currentValue = correction.currentValue

  return (
    <BottomSheet
      open={open}
      onClose={isSubmitting ? () => {} : onCancel}
      title="Korrektur annehmen?"
      description="Der Vorschlag wird übernommen und der Mitarbeiter informiert."
    >
      <div data-testid="correction-approve-sheet" className="mt-3 space-y-4">
        <div className="rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Mitarbeiter
          </div>
          <div className="mt-0.5 text-[13px] text-slate-700">{workerName}</div>
        </div>

        {(currentValue || proposedValue) && (
          <div className="space-y-2">
            {currentValue && (
              <div className="rounded-[14px] border border-red-200 bg-red-50 px-3.5 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-red-500">
                  Aktuell
                </div>
                <div className="mt-0.5 text-[13px] font-semibold text-red-700">
                  {currentValue}
                </div>
              </div>
            )}
            {proposedValue && (
              <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 px-3.5 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
                  Vorschlag
                </div>
                <div className="mt-0.5 text-[13px] font-semibold text-emerald-700">
                  {proposedValue}
                </div>
              </div>
            )}
          </div>
        )}

        {errorMessage && (
          <div
            data-testid="correction-approve-sheet-error"
            className="rounded-[12px] bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700"
          >
            {errorMessage}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            data-testid="correction-approve-sheet-confirm"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="h-12 rounded-[14px] bg-emerald-600 text-white text-[15px] font-semibold disabled:opacity-50"
          >
            {isSubmitting ? 'Wird übernommen…' : 'Annehmen'}
          </button>
          <button
            type="button"
            data-testid="correction-approve-sheet-cancel"
            onClick={onCancel}
            disabled={isSubmitting}
            className="h-12 rounded-[14px] bg-slate-100 text-slate-700 text-[15px] font-medium disabled:opacity-50"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
