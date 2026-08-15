import { Link } from 'react-router-dom'
import type { IntakeReadiness } from '../lib/jobs'
import { deriveProviderJobPhase, PROVIDER_PHASE_CONFIG } from '../lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../lib/jobs/providerNextActionSelectors'
import type { Job } from '../lib/jobs'
import { getFundingRequestByJobId } from '../lib/payments/fundingRequest'
import { getEscrowPlanByJobId } from '../lib/payments/escrow'
import { getPaymentForJob } from '../lib/payments/service'
import { resolveCanonicalProjectFacts } from '../lib/shared/canonicalProjectFacts'

type CraftsmanJobListItemProps = {
  id: string
  title: string
  customer: string
  location: string
  dateLabel: string
  status: string
  amount: string
  paymentState?: string
  intakeReadiness?: IntakeReadiness
  assigneeCount?: number
  /** Full job object used to derive phase + next action. */
  job?: Job
  /** When true, hides the CTA row (used for completed/history cards). */
  compact?: boolean
}

function getIntakeChip(readiness: IntakeReadiness) {
  switch (readiness) {
    case 'thin':
      return { bg: 'bg-rose-50 text-rose-700 ring-rose-200', icon: '!', label: 'Details fehlen' }
    case 'partial':
      return { bg: 'bg-amber-50 text-amber-700 ring-amber-200', icon: '~', label: 'Teilweise' }
    case 'ready':
      return { bg: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: '✓', label: 'Vollständig' }
  }
}

export default function CraftsmanJobListItem({
  id,
  title,
  customer,
  location,
  dateLabel,
  status,
  amount,
  paymentState,
  intakeReadiness,
  assigneeCount,
  job,
  compact,
}: CraftsmanJobListItemProps) {
  const facts = job ? resolveCanonicalProjectFacts(job.id) : null
  const displayTitle = facts?.title ?? title
  const displayCustomer = facts?.customer ?? customer
  const displayLocation = facts?.location ?? location
  const displayDateLabel = facts?.dateLabel ?? dateLabel
  const displayAmount = facts?.canonicalAmount?.formatted || amount

  const canonicalPaymentState = (job ? getPaymentForJob(job.id)?.state : undefined) ?? paymentState

  const fundingRequest = job ? getFundingRequestByJobId(job.id) : undefined
  const escrowPlan = job ? getEscrowPlanByJobId(job.id) : undefined
  const phaseVM = job ? deriveProviderJobPhase(job, fundingRequest?.status, escrowPlan?.status) : null
  const nextAction = job ? deriveProviderNextAction(job, fundingRequest?.status, escrowPlan?.status) : null
  const phaseConfig = phaseVM ? PROVIDER_PHASE_CONFIG[phaseVM.phase] : null

  const intakeChip =
    status === 'new' && intakeReadiness != null
      ? getIntakeChip(intakeReadiness)
      : null

  // Dot color from phase or fallback
  const dotColor = phaseConfig?.dot
    ?? (canonicalPaymentState === 'disputed' ? 'bg-red-500'
      : status === 'waiting_payment' ? 'bg-amber-500'
      : status === 'in_progress' ? 'bg-emerald-500'
      : status === 'new' ? 'bg-blue-500'
      : 'bg-slate-400')

  const jobRoute = `/craftsman/jobs/${id}`

  // Context line parts
  const contextParts: string[] = []
  if (displayCustomer) contextParts.push(displayCustomer)
  if (displayLocation) contextParts.push(displayLocation)
  if (displayDateLabel && displayDateLabel !== '–') contextParts.push(displayDateLabel)

  return (
    <div className="rounded-xl bg-white p-3.5 ring-1 ring-slate-200/70 shadow-[0_2px_8px_-6px_rgba(2,6,23,0.1)]">
      <Link to={jobRoute} className="block">
        {/* Row 1: Dot + Title + Amount */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
            <h3 className="truncate text-[14px] font-semibold text-slate-900">
              {displayTitle}
            </h3>
          </div>
          <span className="shrink-0 text-[14px] font-semibold text-slate-900">
            {displayAmount}
          </span>
        </div>

        {/* Row 2: Context line */}
        <p className="mt-0.5 truncate pl-4 text-[12px] text-slate-500">
          {contextParts.join(' · ')}
        </p>

        {/* Row 3: Badges */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
          {phaseConfig && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${phaseConfig.badge}`}>
              {phaseConfig.icon} {phaseConfig.label}
            </span>
          )}
          {intakeChip && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${intakeChip.bg}`}>
              {intakeChip.icon} {intakeChip.label}
            </span>
          )}
          {typeof assigneeCount === 'number' && assigneeCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200">
              👤 {assigneeCount}
            </span>
          )}
        </div>
      </Link>

      {/* Row 4: CTA + Details — hidden for compact/completed cards */}
      {!compact && nextAction && (
        <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 pl-4">
          {nextAction.enabled ? (
            <Link
              to={jobRoute}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white transition active:scale-[0.97]"
            >
              {nextAction.label}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-500">
              {nextAction.label}
            </span>
          )}
          <Link
            to={jobRoute}
            className="ml-auto text-[11px] text-slate-400 transition hover:text-slate-600"
          >
            Details →
          </Link>
        </div>
      )}
    </div>
  )
}
