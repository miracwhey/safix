import { useState } from 'react'
import CorridorAction from '../system/CorridorAction'
import { getJobById, subscribeJobs, deriveProposalReadiness } from '../../lib/jobs'
import type { ProposalReadinessViewModel } from '../../lib/jobs'
import { submitProposalWorkflow, initializeExecutionWorkflow } from '../../lib/workflow'
import { performCanonicalScheduleSave, getDefaultScheduleTimes } from '../../lib/scheduling'
import { getScheduleForJob, subscribeOperations } from '../../lib/operations'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const READINESS_STYLES = {
  red: {
    badge: 'bg-rose-50 text-rose-700 ring-rose-100',
    dot: 'bg-rose-500',
    progressBar: 'bg-rose-400',
    callout: 'bg-rose-50 ring-rose-100',
    calloutText: 'text-rose-700',
    button: null,
  },
  yellow: {
    badge: 'bg-amber-50 text-amber-700 ring-amber-100',
    dot: 'bg-amber-400',
    progressBar: 'bg-amber-400',
    callout: 'bg-amber-50 ring-amber-100',
    calloutText: 'text-amber-700',
    button: null,
  },
  green: {
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    dot: 'bg-emerald-400',
    progressBar: 'bg-emerald-400',
    callout: 'bg-emerald-50 ring-emerald-100',
    calloutText: 'text-emerald-700',
    button: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  },
  blue: {
    badge: 'bg-blue-50 text-blue-700 ring-blue-100',
    dot: 'bg-blue-400',
    progressBar: 'bg-blue-400',
    callout: 'bg-blue-50 ring-blue-100',
    calloutText: 'text-blue-700',
    button: null,
  },
} as const

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function ProposalReadinessCardView({
  vm,
  hasSchedule,
  onSubmitProposal,
  onInitiateScheduling,
  isSubmitting,
  proposalError,
}: {
  vm: ProposalReadinessViewModel
  hasSchedule: boolean
  onSubmitProposal: () => void
  onInitiateScheduling: () => void
  isSubmitting: boolean
  proposalError: string | null
}) {
  const style = READINESS_STYLES[vm.readinessColor]
  const progressPct = Math.round((vm.satisfiedCount / vm.totalCount) * 100)

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Header */}
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Angebotsbereitschaft
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-[22px] font-semibold text-slate-900">
          Angebot vorbereiten
        </h2>
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1',
            style.badge,
          ].join(' ')}
        >
          <span className={['h-1.5 w-1.5 rounded-full', style.dot].join(' ')} />
          {vm.readinessLabel}
        </span>
      </div>

      <p className="mt-2 text-[14px] text-slate-500">
        {vm.readiness === 'proposal_accepted'
          ? 'Der Kunde hat das Angebot angenommen. Termin und nächste Schritte können jetzt geplant werden.'
          : vm.readiness === 'proposal_sent'
          ? 'Das Angebot wurde dem Kunden übermittelt. Auf Rückmeldung warten.'
          : vm.readiness === 'proposal_invalid'
          ? 'Der Angebotsstatus ist inkonsistent (Annahme ohne Versandzeitpunkt). Bitte Workflow prüfen und Angebot neu senden.'
          : vm.readiness === 'ready_for_proposal'
          ? 'Alle Voraussetzungen sind erfüllt. Das Angebot kann jetzt übermittelt werden.'
          : 'Noch nicht alle Informationen vorhanden, um ein vollständiges Angebot zu stellen.'}
      </p>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-[12px] text-slate-500 mb-1.5">
          <span>Voraussetzungen</span>
          <span className="font-semibold text-slate-700">
            {vm.satisfiedCount} / {vm.totalCount} erfüllt
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100">
          <div
            className={['h-full rounded-full transition-all', style.progressBar].join(' ')}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Prerequisites checklist */}
      <div className="mt-4 divide-y divide-slate-100">
        {vm.prerequisites.map((prereq) => (
          <div key={prereq.id} className="flex items-center gap-3 py-2.5">
            <div
              className={[
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                prereq.satisfied
                  ? 'bg-emerald-100 text-emerald-600'
                  : 'bg-slate-100 text-slate-400',
              ].join(' ')}
            >
              {prereq.satisfied ? '✓' : '○'}
            </div>
            <span
              className={[
                'text-[14px]',
                prereq.satisfied ? 'text-slate-700' : 'text-slate-400',
              ].join(' ')}
            >
              {prereq.label}
            </span>
          </div>
        ))}
      </div>

      {/* Proposal accepted confirmation */}
      {vm.readiness === 'proposal_accepted' && vm.proposalAcceptedLabel ? (
        <div className="mt-4 rounded-[14px] bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold text-emerald-700 mb-1">
            ✅ Angebot angenommen
          </div>
          <div className="text-[13px] text-slate-500">
            Bestätigt am {vm.proposalAcceptedLabel}
          </div>
        </div>
      ) : null}

      {/* Scheduling CTA — shown when proposal is accepted and no schedule exists yet */}
      {vm.readiness === 'proposal_accepted' && !hasSchedule ? (
        <div className="mt-4">
          <CorridorAction variant="primary" onClick={onInitiateScheduling}>
            📅 Termin einplanen
          </CorridorAction>
          {proposalError && (
            <p className="mt-2 text-[12px] text-red-500">{proposalError}</p>
          )}
        </div>
      ) : null}

      {/* Scheduled confirmation pill — shown when proposal is accepted and a schedule exists */}
      {vm.readiness === 'proposal_accepted' && hasSchedule ? (
        <div className="mt-4 rounded-[14px] bg-blue-50 px-3.5 py-3 ring-1 ring-blue-100">
          <div className="text-[12px] font-semibold text-blue-700 mb-1">
            📅 Termin eingeplant
          </div>
          <div className="text-[13px] text-slate-500">
            Das Ausführungsfenster ist eingetragen. Im Bereich Auftragsverlauf anpassen.
          </div>
        </div>
      ) : null}

      {/* Proposal sent confirmation */}
      {vm.readiness === 'proposal_sent' && vm.proposalSentLabel ? (
        <div
          className={[
            'mt-4 rounded-[14px] px-3.5 py-3 ring-1',
            style.callout,
          ].join(' ')}
        >
          <div className={['text-[12px] font-semibold mb-1', style.calloutText].join(' ')}>
            ✓ Angebot übermittelt
          </div>
          <div className="text-[13px] text-slate-500">
            Gesendet am {vm.proposalSentLabel}
          </div>
        </div>
      ) : null}

      {vm.readiness === 'proposal_invalid' ? (
        <div
          className={[
            'mt-4 rounded-[14px] px-3.5 py-3 ring-1',
            style.callout,
          ].join(' ')}
        >
          <div className={['text-[12px] font-semibold mb-1', style.calloutText].join(' ')}>
            ⚠️ Angebotsstatus ungültig
          </div>
          <div className="text-[13px] text-slate-500">
            Die Annahme ist gespeichert, aber der Versandzeitpunkt fehlt. Bitte Angebot neu senden.
          </div>
        </div>
      ) : null}

      {/* Send proposal button — only shown when ready */}
      {vm.readiness === 'ready_for_proposal' && style.button ? (
        <div className="mt-4">
          <CorridorAction
            variant="primary"
            onClick={onSubmitProposal}
            loading={isSubmitting}
          >
            {isSubmitting ? 'Wird gesendet …' : '📤 Angebot jetzt senden'}
          </CorridorAction>
          {proposalError && (
            <p className="mt-2 text-[12px] text-red-500">{proposalError}</p>
          )}
        </div>
      ) : null}

      {/* Gap callout when not ready */}
      {vm.readiness === 'needs_clarification' && vm.primaryGap ? (
        <div
          className={[
            'mt-4 rounded-[14px] px-3.5 py-3 ring-1',
            style.callout,
          ].join(' ')}
        >
          <div className={['text-[12px] font-semibold mb-1', style.calloutText].join(' ')}>
            ⚠ Noch ausstehend
          </div>
          <div className="text-[13px] text-slate-600">
            {vm.primaryGap} muss noch ergänzt werden.
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
 * Craftsman-facing proposal readiness card for jobs in `'new'` status.
 *
 * Derives a `ProposalReadinessViewModel` from the job and renders a
 * prerequisites checklist. When all prerequisites are met, a "Angebot senden"
 * button is shown that calls `submitProposalWorkflow`.
 *
 * When the proposal has been accepted, a "Termin einplanen" CTA is shown that
 * calls `initializeExecutionWorkflow` + `performCanonicalScheduleSave`, formally
 * kicking off execution preparation.
 */
export default function ProposalReadinessCard({ jobId }: Props) {
  function buildVm(): ProposalReadinessViewModel | null {
    const job = getJobById(jobId)
    if (!job) return null
    return deriveProposalReadiness(job)
  }

  const [vm, setVm] = useState<ProposalReadinessViewModel | null>(buildVm)
  const [hasSchedule, setHasSchedule] = useState(() => !!getScheduleForJob(jobId))
  const [proposalError, setProposalError] = useState<string | null>(null)

  useStoreSync([subscribeJobs, subscribeOperations], () => {
    setVm(buildVm())
    setHasSchedule(!!getScheduleForJob(jobId))
  })

  const handleSubmitProposal = () => {
    setProposalError(null)
    try {
      submitProposalWorkflow(jobId)
      setVm(buildVm())
    } catch (e) {
      console.error(e)
      setProposalError('Angebot konnte nicht gesendet werden.')
    }
  }

  const handleInitiateScheduling = () => {
    const { scheduledStart, scheduledEnd } = getDefaultScheduleTimes()
    void initializeExecutionWorkflow(jobId)
      .then(() => performCanonicalScheduleSave({ jobId, scheduledStart, scheduledEnd }))
      .then((result) => {
        if (!result.success) {
          setProposalError(result.error ?? 'Termin konnte nicht gespeichert werden.')
        }
      })
      .catch((e: unknown) => {
        console.error(e)
        setProposalError('Termin konnte nicht gespeichert werden.')
      })
  }

  if (!vm) return null

  return (
    <ProposalReadinessCardView
      vm={vm}
      hasSchedule={hasSchedule}
      onSubmitProposal={handleSubmitProposal}
      onInitiateScheduling={handleInitiateScheduling}
      isSubmitting={false}
      proposalError={proposalError}
    />
  )
}
