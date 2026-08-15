import { useCallback, useState } from 'react'
import { useDraftPersistence } from '../../hooks/useDraftPersistence'
import type { DisputeReason } from '../../lib/disputes/types'
import { getDisputeReasonLabel } from '../../lib/disputes/disputeSelectors'
import { openDisputeWorkflow } from '../../lib/workflow'
import { useSession } from '../../hooks/useSession'
import { useCorridorAction } from '../../hooks/useCorridorAction'
import CorridorAction from '../system/CorridorAction'

type Props = {
  jobId: string
  onDisputeOpened?: () => void
}

const REASON_OPTIONS: DisputeReason[] = [
  'work_quality',
  'scope_conflict',
  'delay',
  'payment_conflict',
  'other',
]

export default function CustomerOpenDisputeCard({ jobId, onDisputeOpened }: Props) {
  const { user } = useSession()
  const [expanded, setExpanded] = useState(false)
  const [reason, setReason] = useState<DisputeReason>('work_quality')
  // Draft persistence (Resume-Robustness Block 4): the description is legally
  // relevant long-form text — it survives unmount/reload, keyed by job (the
  // dispute does not exist yet while composing). Cleared only after a
  // successful submit. Restoring never submits.
  const {
    value: description,
    setValue: setDescription,
    clear: clearDescriptionDraft,
  } = useDraftPersistence(`fixup.dispute.open.${jobId}`)

  const submitAction = useCallback(async () => {
    const trimmed = description.trim()
    if (!trimmed) return
    const title = `${getDisputeReasonLabel(reason)} – Konflikt`
    await openDisputeWorkflow({
      jobId,
      reason,
      title,
      description: trimmed,
      raisedBy: user?.id,
    })
  }, [jobId, reason, description, user?.id])

  const { execute: handleSubmit, isLoading: submitting } = useCorridorAction(
    submitAction,
    {
      successMessage: 'Konfliktfall eingereicht',
      errorMessage: 'Konfliktfall konnte nicht eingereicht werden',
      onSuccess: () => {
        setExpanded(false)
        clearDescriptionDraft()
        onDisputeOpened?.()
      },
    }
  )

  if (!expanded) {
    return (
      <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-slate-900">
              Konflikt melden
            </div>
            <div className="mt-1 text-[13px] text-slate-500">
              Wenn Leistung, Qualität oder Termin nicht stimmen, können Sie hier einen Fall eröffnen.
            </div>
          </div>
          <div className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
            SaFix Schutz
          </div>
        </div>
        <CorridorAction
          variant="secondary"
          size="sm"
          onClick={() => setExpanded(true)}
          className="mt-4"
        >
          Konfliktfall eröffnen
        </CorridorAction>
      </div>
    )
  }

  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-amber-200 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14px] font-semibold text-slate-900">
          Konfliktfall eröffnen
        </div>
        <CorridorAction
          variant="ghost"
          size="sm"
          block={false}
          onClick={() => setExpanded(false)}
        >
          Abbrechen
        </CorridorAction>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-400">
            Grund
          </div>
          <div className="grid grid-cols-2 gap-2">
            {REASON_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`rounded-xl px-3 py-2 text-[12px] font-semibold transition ${
                  reason === r
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-50 text-slate-600 ring-1 ring-slate-200/70'
                }`}
              >
                {getDisputeReasonLabel(r)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-400">
            Beschreibung
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Beschreiben Sie den Sachverhalt kurz und sachlich …"
            rows={4}
            className="w-full resize-none rounded-[18px] bg-slate-50 px-4 py-3 text-[13px] text-slate-900 ring-1 ring-slate-200/70 placeholder:text-slate-400 focus:outline-none focus:ring-slate-400"
          />
        </div>

        <CorridorAction
          variant="destructive"
          size="sm"
          disabled={!description.trim()}
          loading={submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Wird eingereicht …' : 'Fall einreichen'}
        </CorridorAction>
      </div>

      <div className="mt-3 rounded-[18px] bg-blue-50 px-4 py-3 ring-1 ring-blue-100">
        <div className="text-[12px] text-blue-700">
          SaFix prüft Ihren Fall und hält den Zahlungsbetrag bis zur Klärung eingefroren.
        </div>
      </div>
    </div>
  )
}
