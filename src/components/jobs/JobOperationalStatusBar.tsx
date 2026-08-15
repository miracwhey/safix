import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../../lib/payments'
import { getDisputeByJobId, subscribeDisputes } from '../../lib/disputes'
import { getScheduleForJob, subscribeOperations } from '../../lib/operations'
import { getArtifactsByJobId, subscribeMedia } from '../../lib/media'
import { getTimelineSignalsForJob, subscribeTimeline } from '../../lib/timeline'
import { useStoreSync } from '../../lib/reactive'
import { getActionablePaymentState } from '../../lib/jobs/helpers'
import {
  deriveJobOperationalSummary,
  type JobOperationalSummary,
  type OperationalBlockerReason,
  type OperationalPhase,
} from '../../lib/jobs/operationalSummarySelectors'
import { getFundingRequestByJobId } from '../../lib/payments/fundingRequest'

type Props = {
  jobId: string
}


// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

type PhaseStyles = {
  bar: string
  phase: string
  dot: string
}

function getPhaseStyles(phase: OperationalPhase): PhaseStyles {
  switch (phase) {
    case 'intake':
      return {
        bar: 'bg-blue-50 ring-blue-100',
        phase: 'text-blue-600',
        dot: 'bg-blue-400',
      }
    case 'scheduling':
      return {
        bar: 'bg-blue-50 ring-blue-100',
        phase: 'text-blue-600',
        dot: 'bg-blue-400',
      }
    case 'active':
      return {
        bar: 'bg-slate-50 ring-slate-100',
        phase: 'text-slate-700',
        dot: 'bg-emerald-400',
      }
    case 'awaiting_release':
      return {
        bar: 'bg-amber-50 ring-amber-100',
        phase: 'text-amber-700',
        dot: 'bg-amber-400',
      }
    case 'in_dispute':
      return {
        bar: 'bg-rose-50 ring-rose-100',
        phase: 'text-rose-600',
        dot: 'bg-rose-500',
      }
    case 'complete':
      return {
        bar: 'bg-emerald-50 ring-emerald-100',
        phase: 'text-emerald-700',
        dot: 'bg-emerald-400',
      }
  }
}

type BlockerStyles = {
  pill: string
  text: string
}

function getBlockerStyles(reason: OperationalBlockerReason): BlockerStyles {
  switch (reason) {
    case 'awaiting_deposit':
    case 'awaiting_customer_approval':
      return {
        pill: 'bg-amber-100 ring-amber-200',
        text: 'text-amber-700',
      }
    case 'dispute_open':
    case 'dispute_evidence_required':
    case 'payment_frozen':
      return {
        pill: 'bg-rose-100 ring-rose-200',
        text: 'text-rose-700',
      }
    case 'dispute_under_review':
      return {
        pill: 'bg-violet-100 ring-violet-200',
        text: 'text-violet-700',
      }
    case 'workflow_complete':
      return {
        pill: 'bg-emerald-100 ring-emerald-200',
        text: 'text-emerald-700',
      }
    default:
      return {
        pill: 'bg-slate-100 ring-slate-200',
        text: 'text-slate-500',
      }
  }
}

// ---------------------------------------------------------------------------
// Action ownership badge
// ---------------------------------------------------------------------------

function ActionOwnerBadge({
  requiresCustomerAction,
  requiresCraftsmanAction,
  requiresAdminAction,
}: Pick<
  JobOperationalSummary,
  'requiresCustomerAction' | 'requiresCraftsmanAction' | 'requiresAdminAction'
>) {
  if (requiresAdminAction) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200">
        <span>🏢</span>
        <span>SaFix prüft</span>
      </span>
    )
  }

  if (requiresCustomerAction && requiresCraftsmanAction) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
        <span>👥</span>
        <span>Beide Parteien</span>
      </span>
    )
  }

  if (requiresCustomerAction) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
        <span>👤</span>
        <span>Kunde</span>
      </span>
    )
  }

  if (requiresCraftsmanAction) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-200">
        <span>🔨</span>
        <span>Handwerker</span>
      </span>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function JobOperationalStatusBarView({ vm }: { vm: JobOperationalSummary }) {
  const phaseStyles = getPhaseStyles(vm.phase)
  const blockerStyles = getBlockerStyles(vm.blocker.reason)

  return (
    <div
      className={`rounded-2xl px-4 py-3 ring-1 ${phaseStyles.bar}`}
      title={vm.blocker.isBlocking ? vm.blocker.description : undefined}
    >
      {/* Top row: phase dot + label + action owner + blocker pill */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <div className={`h-2 w-2 shrink-0 rounded-full ${phaseStyles.dot}`} />
          <span className={`text-[13px] font-semibold ${phaseStyles.phase}`}>
            {vm.phaseLabel}
          </span>
        </div>

        <ActionOwnerBadge
          requiresCustomerAction={vm.requiresCustomerAction}
          requiresCraftsmanAction={vm.requiresCraftsmanAction}
          requiresAdminAction={vm.requiresAdminAction}
        />

        {vm.blocker.isDisplayed && (
          <span
            className={`ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${blockerStyles.pill} ${blockerStyles.text}`}
          >
            {vm.blocker.label}
          </span>
        )}
      </div>

      {/* Timeline context note */}
      {vm.timelineContext && (
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-[11px] font-medium text-slate-400">
            {vm.timelineContext.dateLabel}
          </span>
          <span className="text-[12px] text-slate-500">
            {vm.timelineContext.description}
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

function buildSummary(jobId: string): JobOperationalSummary | null {
  const job = getJobById(jobId)
  if (!job) return null

  const payment = getPaymentForJob(jobId)
  const effectivePaymentState = getActionablePaymentState(job, payment)
  const dispute = getDisputeByJobId(jobId)
  const schedule = getScheduleForJob(jobId)
  const artifacts = getArtifactsByJobId(jobId)
  const timelineSignals = getTimelineSignalsForJob(jobId)

  return deriveJobOperationalSummary({
    jobId,
    jobStatus: job.status,
    paymentState: effectivePaymentState,
    disputeStatus: dispute?.status,
    schedulingStatus: schedule?.schedulingStatus,
    schedule,
    artifactCount: artifacts.length,
    timelineSignals,
    proposalSentAt: job.proposalSentAt,
    proposalAcceptedAt: job.proposalAcceptedAt,
    fundingStatus: getFundingRequestByJobId(jobId)?.status,
  })
}

/**
 * Compact craftsman-facing operational status bar for a job.
 *
 * Shows the current operational phase, who needs to act, any active blocker,
 * and a timeline-aware context note explaining why the job is in its current state.
 *
 * Designed to be embedded as a status strip in job detail screens or job cards.
 */
export default function JobOperationalStatusBar({ jobId }: Props) {
  const [vm, setVm] = useState<JobOperationalSummary | null>(
    () => buildSummary(jobId)
  )

  useStoreSync(
    [
      subscribeJobs,
      subscribePayments,
      subscribeDisputes,
      subscribeOperations,
      subscribeMedia,
      subscribeTimeline,
    ],
    () => setVm(buildSummary(jobId))
  )

  if (!vm) return null

  return <JobOperationalStatusBarView vm={vm} />
}
