import BottomSheet from '../ui/BottomSheet'
import type { CorrectionRequest } from '../../lib/corrections'

/**
 * Begründungs-Sheet für Push-getriggertes REJECT auf einer Korrektur.
 *
 * Workflow-Pflicht: `rejectCorrectionWorkflow` verlangt eine non-empty
 * `ownerNote`. Sheet enforced UI-seitig 10+ Zeichen, damit der User nicht
 * mit „." abgewürgte Begründungen senden kann (UX-Sanity).
 *
 * Controlled component — Parent (Screen) hält Note + Workflow-State.
 *
 * Kein One-Tap-Reject, kein silent-Reject, kein blind-money-Verlust:
 * der User MUSS eine Begründung schreiben bevor der Submit-Button enabled
 * wird. Selbst dann läuft der Server-Side Workflow-Guard nochmal drüber.
 */
export const REJECT_NOTE_MIN_LENGTH = 10

export interface CorrectionRejectSheetProps {
  open: boolean
  correction: CorrectionRequest
  workerName: string
  note: string
  isSubmitting: boolean
  errorMessage: string | null
  onNoteChange: (next: string) => void
  onConfirm: () => void
  onCancel: () => void
}

export default function CorrectionRejectSheet({
  open,
  correction,
  workerName,
  note,
  isSubmitting,
  errorMessage,
  onNoteChange,
  onConfirm,
  onCancel,
}: CorrectionRejectSheetProps) {
  const trimmedLength = note.trim().length
  const isNoteValid = trimmedLength >= REJECT_NOTE_MIN_LENGTH
  const canSubmit = isNoteValid && !isSubmitting
  const proposedValue = correction.proposedValue

  return (
    <BottomSheet
      open={open}
      onClose={isSubmitting ? () => {} : onCancel}
      title="Korrektur ablehnen"
      description="Bitte begründe kurz, damit der Mitarbeiter sie nachvollziehen kann."
    >
      <div data-testid="correction-reject-sheet" className="mt-3 space-y-4">
        <div className="rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Mitarbeiter
          </div>
          <div className="mt-0.5 text-[13px] text-slate-700">{workerName}</div>
        </div>

        {proposedValue && (
          <div className="rounded-[14px] border border-slate-200 bg-white px-3.5 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Vorschlag
            </div>
            <div className="mt-0.5 text-[13px] text-slate-700">{proposedValue}</div>
          </div>
        )}

        <div>
          <label
            htmlFor="correction-reject-sheet-note"
            className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-2"
          >
            Begründung{' '}
            <span className="font-normal normal-case tracking-normal text-slate-300">
              (mind. {REJECT_NOTE_MIN_LENGTH} Zeichen)
            </span>
          </label>
          <textarea
            id="correction-reject-sheet-note"
            data-testid="correction-reject-sheet-note"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="Warum wird der Vorschlag abgelehnt?"
            rows={4}
            disabled={isSubmitting}
            autoFocus
            className="w-full rounded-[14px] bg-slate-50 px-3.5 py-3 text-[13px] text-slate-700 ring-1 ring-slate-100 outline-none focus:ring-slate-300 disabled:opacity-50"
          />
          <div className="mt-1.5 text-right text-[11px] text-slate-400">
            {trimmedLength}/{REJECT_NOTE_MIN_LENGTH}+
          </div>
        </div>

        {errorMessage && (
          <div
            data-testid="correction-reject-sheet-error"
            className="rounded-[12px] bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700"
          >
            {errorMessage}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            data-testid="correction-reject-sheet-confirm"
            onClick={onConfirm}
            disabled={!canSubmit}
            className="h-12 rounded-[14px] bg-red-600 text-white text-[15px] font-semibold disabled:opacity-40"
          >
            {isSubmitting ? 'Wird gesendet…' : 'Ablehnen senden'}
          </button>
          <button
            type="button"
            data-testid="correction-reject-sheet-cancel"
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
