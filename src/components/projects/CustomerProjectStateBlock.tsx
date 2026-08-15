import { Fragment, useState } from 'react'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../../lib/payments'
import { getDisputeByJobId, subscribeDisputes } from '../../lib/disputes'
import { getScheduleForJob, subscribeOperations } from '../../lib/operations'
import { getArtifactsByJobId, subscribeMedia } from '../../lib/media'
import { getTimelineSignalsForJob, subscribeTimeline } from '../../lib/timeline'
import { getFundingRequestByJobId } from '../../lib/payments/fundingRequest'
import { getEscrowPlanByJobId } from '../../lib/payments/escrow'
import { useStoreSync } from '../../lib/reactive'
import { getActionablePaymentState } from '../../lib/jobs/helpers'
import {
  deriveJobOperationalSummary,
  type JobOperationalSummary,
} from '../../lib/jobs/operationalSummarySelectors'
import {
  deriveCustomerJobStage,
  CUSTOMER_STAGE_ORDER,
  CUSTOMER_STAGE_LABELS,
  type CustomerStageViewModel,
} from '../../lib/jobs/customerJobStageSelectors'

// ── Data builders ────────────────────────────────────────────────────────────

function buildSummary(jobId: string): JobOperationalSummary | null {
  const job = getJobById(jobId)
  if (!job) return null
  const payment = getPaymentForJob(jobId)
  const dispute = getDisputeByJobId(jobId)
  const schedule = getScheduleForJob(jobId)
  const artifacts = getArtifactsByJobId(jobId)
  const timelineSignals = getTimelineSignalsForJob(jobId)
  const effectivePaymentState = getActionablePaymentState(job, payment)
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

function buildStageVm(jobId: string): CustomerStageViewModel | null {
  const job = getJobById(jobId)
  if (!job) return null
  const payment = getPaymentForJob(jobId)
  const fundingRequest = getFundingRequestByJobId(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)
  const effectivePaymentState = getActionablePaymentState(job, payment ?? undefined)
  return deriveCustomerJobStage(
    job.status,
    effectivePaymentState,
    job.proposalSentAt,
    job.proposalAcceptedAt,
    fundingRequest?.status,
    escrowPlan?.status,
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Central state + action block for the customer project detail screen.
 *
 * Answers three questions in one compact card:
 *   1. Was ist der aktuelle Zustand? → 9-stage progress bar
 *   2. Muss ich gerade etwas tun?    → "Aktion nötig" badge
 *   3. Was ist der nächste Schritt?  → next action icon + label + text
 *
 * Replaces: CustomerLifecycleStagesBar + CustomerJobNextStepBanner +
 *           CustomerStatusAndActionCard + CustomerExecutionStartCard +
 *           CustomerProjectHealthSummaryCard + 4 stuck warning banners.
 */
export default function CustomerProjectStateBlock({
  jobId,
  onPaymentAction,
}: {
  jobId: string | undefined
  /** Called when the user taps the payment CTA. Should trigger the actual
   *  payment flow (e.g. via CustomerEscrowFundingCard imperative handle)
   *  and scroll the card into view. */
  onPaymentAction?: () => void
}) {
  const [summary, setSummary] = useState<JobOperationalSummary | null>(
    () => (jobId ? buildSummary(jobId) : null)
  )
  const [stageVm, setStageVm] = useState<CustomerStageViewModel | null>(
    () => (jobId ? buildStageVm(jobId) : null)
  )
  const [formattedAmount, setFormattedAmount] = useState<string | null>(
    () => (jobId ? resolveCanonicalAmount(jobId).formatted : null)
  )

  useStoreSync(
    [subscribeJobs, subscribePayments, subscribeDisputes, subscribeOperations, subscribeMedia, subscribeTimeline],
    () => setSummary(jobId ? buildSummary(jobId) : null)
  )
  useStoreSync(
    [subscribeJobs, subscribePayments],
    () => {
      setStageVm(jobId ? buildStageVm(jobId) : null)
      setFormattedAmount(jobId ? resolveCanonicalAmount(jobId).formatted : null)
    }
  )

  if (!jobId || !summary || !stageVm) return null

  const nextAction = summary.customerNextAction
  const isUrgent = nextAction.priority === 'urgent'
  // Show the deposit CTA only when the blocker is specifically 'awaiting_deposit'
  // (paymentState=deposit_required + fundingStatus not yet funded).
  // This excludes release_pending (blocker='awaiting_customer_approval') and
  // funding_started/initiated (priority='active', so isUrgent=false).
  const showPaymentCta =
    summary.blocker.reason === 'awaiting_deposit' &&
    isUrgent &&
    !!onPaymentAction

  return (
    <div className="rounded-card bg-[#EFF6FF] p-5 ring-1 ring-[#BFDBFE]">
      {/* Stage label + optional action badge */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-[#2563EB]">
          {CUSTOMER_STAGE_LABELS[stageVm.stage]}
        </span>
        {isUrgent && (
          <span className="shrink-0 rounded-chip bg-[#FFF7ED] px-2 py-0.5 text-[11px] font-semibold text-[#C2410C] ring-1 ring-[#FED7AA]">
            Aktion nötig
          </span>
        )}
      </div>

      {/* 9-stage compact progress bar */}
      <div className="mt-3 flex items-center">
        {CUSTOMER_STAGE_ORDER.map((stage, i) => {
          const isPast = i < stageVm.activeIndex
          const isActive = i === stageVm.activeIndex
          return (
            <Fragment key={stage}>
              {i > 0 && (
                <div
                  className={`h-[2px] flex-1 ${isPast ? 'bg-[#2563EB]' : 'bg-[#BFDBFE]'}`}
                />
              )}
              <div
                className={`h-2 w-2 shrink-0 rounded-full ${
                  isActive
                    ? 'bg-[#2563EB] ring-2 ring-[#BFDBFE] ring-offset-1 ring-offset-[#EFF6FF]'
                    : isPast
                      ? 'bg-[#2563EB]'
                      : 'bg-[#BFDBFE]'
                }`}
              />
            </Fragment>
          )
        })}
      </div>

      {/* Divider */}
      <div className="my-4 border-t border-[#BFDBFE]" />

      {/* Next action */}
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[18px] leading-none">{nextAction.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-[#0F172A]">{nextAction.label}</p>
          <p className="mt-1 text-[13px] leading-snug text-[#475569]">{nextAction.text}</p>
        </div>
      </div>

      {/* Primary payment CTA — directly triggers the funding flow in
          CustomerEscrowFundingCard via imperative handle (no scroll proxy). */}
      {showPaymentCta && (
        <button
          onClick={onPaymentAction}
          className="mt-4 w-full rounded-card bg-[#2563EB] py-2.5 text-[14px] font-semibold text-white transition-transform active:scale-[0.98]"
        >
          {formattedAmount ? `Jetzt ${formattedAmount} einzahlen` : 'Jetzt einzahlen'}
        </button>
      )}
    </div>
  )
}
