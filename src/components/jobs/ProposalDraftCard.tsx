import { useState, useEffect } from 'react'
import { getJobById, subscribeJobs, derivePrefillFromIntake } from '../../lib/jobs'
import type { ProposalDraftPrefill } from '../../lib/jobs'
import { prepareProposalDraftWorkflow } from '../../lib/workflow'
import { useStoreSync } from '../../lib/reactive'
import CorridorAction from '../system/CorridorAction'

type Props = {
  jobId: string
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function ProposalDraftCardView({
  jobId,
  prefill,
  isSaved,
  onSave,
}: {
  jobId: string
  prefill: ProposalDraftPrefill
  isSaved: boolean
  onSave: (draft: { amount: string; description: string; proposalTimingNote: string }) => void
}) {
  const [amount, setAmount] = useState(prefill.amount)
  const [description, setDescription] = useState(prefill.description)
  const [timingNote, setTimingNote] = useState(prefill.timingNote)
  const [dirty, setDirty] = useState(false)

  // Sync local state when external prefill changes (e.g. after a store reload)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAmount(prefill.amount)
    setDescription(prefill.description)
    setTimingNote(prefill.timingNote)
    setDirty(false)
  }, [prefill.amount, prefill.description, prefill.timingNote])

  const handleSave = () => {
    onSave({ amount, description, proposalTimingNote: timingNote })
    setDirty(false)
  }

  const canSave = dirty && (amount.trim().length > 0 || description.trim().length > 0)

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Header */}
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Angebotsentwurf
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-[22px] font-semibold text-slate-900">Angebot erstellen</h2>
        {isSaved && !dirty ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-100">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Entwurf gespeichert
          </span>
        ) : dirty ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-100">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Nicht gespeichert
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-[14px] text-slate-500">
        Preis, Leistungsbeschreibung und Zeitrahmen festlegen, bevor das Angebot abgeschickt wird.
      </p>

      {/* Form fields */}
      <div className="mt-4 space-y-4">
        {/* Amount */}
        <div>
          <label
            htmlFor={`proposal-amount-${jobId}`}
            className="mb-1.5 block text-[13px] font-semibold text-slate-700"
          >
            Angebotspreis
          </label>
          <input
            id={`proposal-amount-${jobId}`}
            type="text"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              setDirty(true)
            }}
            placeholder="z. B. 850 €"
            className="w-full rounded-[14px] border-0 bg-slate-50 px-4 py-3 text-[15px] text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Description / scope */}
        <div>
          <label
            htmlFor={`proposal-desc-${jobId}`}
            className="mb-1.5 block text-[13px] font-semibold text-slate-700"
          >
            Leistungsbeschreibung
          </label>
          <textarea
            id={`proposal-desc-${jobId}`}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setDirty(true)
            }}
            placeholder="Umfang der Arbeiten kurz beschreiben …"
            rows={4}
            className="w-full resize-none rounded-[14px] border-0 bg-slate-50 px-4 py-3 text-[15px] text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Timing note */}
        <div>
          <label
            htmlFor={`proposal-timing-${jobId}`}
            className="mb-1.5 block text-[13px] font-semibold text-slate-700"
          >
            Zeitrahmen / Verfügbarkeit
            <span className="ml-1.5 text-[11px] font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id={`proposal-timing-${jobId}`}
            type="text"
            value={timingNote}
            onChange={(e) => {
              setTimingNote(e.target.value)
              setDirty(true)
            }}
            placeholder="z. B. Umsetzung in 1–2 Tagen, ab nächster Woche"
            className="w-full rounded-[14px] border-0 bg-slate-50 px-4 py-3 text-[15px] text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Save button — hidden once saved and clean, so it doesn't compete
           with ProposalReadinessCard's "Send" primary below this card. */}
      {dirty ? (
        <div className="mt-5">
          <CorridorAction
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
          >
            💾 Entwurf speichern
          </CorridorAction>
        </div>
      ) : null}

      {/* Saved confirmation — visible when saved and clean */}
      {isSaved && !dirty ? (
        <div className="mt-4 rounded-[14px] bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold text-emerald-700 mb-0.5">
            ✓ Entwurf gespeichert
          </div>
          <div className="text-[13px] text-slate-500">
            Preis und Beschreibung sind hinterlegt. Das Angebot kann jetzt abgeschickt werden.
          </div>
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * Craftsman-facing proposal draft card for jobs in `'new'` status.
 *
 * Renders editable fields for the proposal price, scope description, and
 * timing note. Pre-populates values from the job's `intakeContext` (requested
 * budget, description, duration) and any previously saved draft values.
 *
 * Saving calls `prepareProposalDraftWorkflow`, which persists the fields to the
 * job store and adds a draft-saved activity log entry. Once saved, the
 * `ProposalReadinessCard` prerequisite checks will reflect the updated values.
 *
 * Only rendered before a proposal has been sent (`!job.proposalSentAt`).
 */
export default function ProposalDraftCard({ jobId }: Props) {
  function buildPrefill(): ProposalDraftPrefill | null {
    const job = getJobById(jobId)
    if (!job) return null
    return derivePrefillFromIntake(job)
  }

  function hasSavedDraft(): boolean {
    const job = getJobById(jobId)
    if (!job) return false
    return Boolean(job.amount?.trim()) || Boolean(job.description?.trim())
  }

  const [prefill, setPrefill] = useState<ProposalDraftPrefill | null>(buildPrefill)
  const [isSaved, setIsSaved] = useState(hasSavedDraft)

  useStoreSync([subscribeJobs], () => {
    setPrefill(buildPrefill())
    setIsSaved(hasSavedDraft())
  })

  const handleSave = (draft: {
    amount: string
    description: string
    proposalTimingNote: string
  }) => {
    prepareProposalDraftWorkflow(jobId, draft)
    setIsSaved(true)
    setPrefill(buildPrefill())
  }

  if (!prefill) return null

  return (
    <ProposalDraftCardView
      jobId={jobId}
      prefill={prefill}
      isSaved={isSaved}
      onSave={handleSave}
    />
  )
}
