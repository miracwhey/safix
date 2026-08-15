import { useCallback, useState } from 'react'
import { useDraftPersistence } from '../../hooks/useDraftPersistence'
import { submitDisputeResponseWorkflow } from '../../lib/workflow/disputeResponseWorkflow'
import {
  formatResponseDeadlineLabel,
  isDisputeResponseDeadlineUrgent,
} from '../../lib/disputes/disputeResponseSelectors'
import { mapDisputeResponseSubmitError } from './disputeResponseErrorMessages'
import InlineFeedback from '../system/InlineFeedback'

type ComposerStep = 'idle' | 'editing' | 'confirming' | 'submitting'

type Props = {
  jobId: string
  /** Display-only deadline; never a workflow trigger. */
  deadline?: Date | null
  /**
   * Called after a successful submit so the parent can scroll/flash a banner.
   * The composer collapses itself back to `idle` regardless.
   */
  onSubmitted?: () => void
  /**
   * Test-only / preview-only override: open the composer in a non-`idle`
   * step. Production callers leave this undefined.
   */
  initialStep?: ComposerStep
}

const MAX_LENGTH = 4000

export default function DisputeResponseComposer({
  jobId,
  deadline,
  onSubmitted,
  initialStep = 'idle',
}: Props) {
  const [step, setStep] = useState<ComposerStep>(initialStep)
  // Draft persistence (Resume-Robustness Block 4): the statement is legally
  // relevant long-form text — it survives unmount/reload, keyed by job (the
  // composer has no disputeId). Restored at mount, cleared only after a
  // successful submit or an explicit cancel. Restoring never submits.
  const {
    value: statement,
    setValue: setStatement,
    clear: clearDraft,
  } = useDraftPersistence(`fixup.dispute.response.${jobId}`)
  const [error, setError] = useState<string | null>(null)

  const trimmed = statement.trim()
  const charCount = statement.length

  const startEditing = useCallback(() => {
    setError(null)
    setStep('editing')
  }, [])

  const cancel = useCallback(() => {
    // Explicit user discard — drop the persisted draft too.
    clearDraft()
    setError(null)
    setStep('idle')
  }, [clearDraft])

  const goBackToEditing = useCallback(() => {
    setError(null)
    setStep('editing')
  }, [])

  const goToConfirm = useCallback(() => {
    if (trimmed.length === 0) return
    setError(null)
    setStep('confirming')
  }, [trimmed])

  const submit = useCallback(async () => {
    setError(null)
    setStep('submitting')
    try {
      await submitDisputeResponseWorkflow({ jobId, statement: trimmed })
      clearDraft()
      setStep('idle')
      onSubmitted?.()
    } catch (e) {
      setError(mapDisputeResponseSubmitError(e))
      setStep('editing')
    }
  }, [jobId, trimmed, clearDraft, onSubmitted])

  const deadlineLabel = deadline ? formatResponseDeadlineLabel(deadline) : null
  const deadlineUrgent = deadline ? isDisputeResponseDeadlineUrgent(deadline) : false
  const deadlineDisplay = deadline
    ? deadline.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  if (step === 'idle') {
    return (
      <div className="mt-4 rounded-[18px] bg-amber-50 p-4 ring-1 ring-amber-200/70">
        <div className="text-[13px] font-semibold text-amber-900">
          SaFix wartet auf deine Stellungnahme
        </div>
        {deadlineLabel && deadlineDisplay ? (
          <div className="mt-1 text-[12px] text-amber-700">
            Bitte bis {deadlineDisplay} antworten · {deadlineLabel}
          </div>
        ) : null}
        <div className="mt-1 text-[12px] text-amber-800/80">
          An SaFix/Operator — wird vom Streit-Team geprüft.
        </div>
        <button
          type="button"
          onClick={startEditing}
          className="mt-3 w-full rounded-xl bg-slate-900 px-3 py-2 text-[13px] font-semibold text-white transition active:scale-[0.97]"
        >
          Stellungnahme schreiben
        </button>
      </div>
    )
  }

  if (step === 'editing' || step === 'submitting') {
    const isSubmitting = step === 'submitting'
    return (
      <div className="mt-4 rounded-[18px] bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[13px] font-semibold text-slate-900">
              Deine Stellungnahme an SaFix
            </div>
            {deadlineLabel && deadlineDisplay ? (
              <div
                className={`mt-0.5 text-[12px] ${
                  deadlineUrgent ? 'text-rose-700' : 'text-slate-500'
                }`}
              >
                Bitte bis {deadlineDisplay} antworten · {deadlineLabel}
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <InlineFeedback className="mt-3" error={error} onDismiss={() => setError(null)} />
        ) : null}

        <textarea
          aria-label="Stellungnahme"
          placeholder="Beschreibe Sicht der Dinge — was lief ab, welche Belege gibt es, was wurde mit der Gegenseite vereinbart…"
          value={statement}
          onChange={(e) => setStatement(e.target.value.slice(0, MAX_LENGTH))}
          disabled={isSubmitting}
          rows={6}
          className="mt-3 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
        />

        <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
          <span>Tipp: Sei sachlich. SaFix entscheidet anhand beider Stellungnahmen.</span>
          <span className="font-semibold">
            {charCount} / {MAX_LENGTH}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={isSubmitting}
            className="rounded-xl bg-slate-100 px-3 py-2 text-[13px] font-semibold text-slate-700 transition active:scale-[0.97] disabled:opacity-60"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={goToConfirm}
            disabled={isSubmitting || trimmed.length === 0}
            className="rounded-xl bg-slate-900 px-3 py-2 text-[13px] font-semibold text-white transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? 'Wird gesendet…' : 'Weiter'}
          </button>
        </div>
      </div>
    )
  }

  // confirming
  return (
    <div className="mt-4 rounded-[18px] bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="text-[13px] font-semibold text-slate-900">
        Bestätigen — an SaFix/Operator senden
      </div>
      <div className="mt-2 rounded-[12px] bg-amber-50 px-3 py-2 text-[12px] text-amber-900 ring-1 ring-amber-200/70">
        <strong>Hinweis:</strong> Nach dem Senden kannst du diese Stellungnahme
        nicht mehr ändern. SaFix prüft den Fall und entscheidet.
      </div>

      <div className="mt-3 rounded-[12px] border border-slate-200 bg-white px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-indigo-700">
          Vorschau · deine Stellungnahme
        </div>
        <div className="mt-1 whitespace-pre-wrap text-[13px] text-slate-700">
          {trimmed}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={goBackToEditing}
          className="rounded-xl bg-slate-100 px-3 py-2 text-[13px] font-semibold text-slate-700 transition active:scale-[0.97]"
        >
          Zurück
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          className="rounded-xl bg-rose-600 px-3 py-2 text-[13px] font-semibold text-white transition active:scale-[0.97]"
        >
          Bestätigen &amp; Senden
        </button>
      </div>
    </div>
  )
}
