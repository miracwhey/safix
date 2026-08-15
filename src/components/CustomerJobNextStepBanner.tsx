import { useNavigate } from 'react-router-dom'
import CorridorAction from './system/CorridorAction'
import { useState } from 'react'
import { getJobById, subscribeJobs, deriveCustomerNextStep } from '../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../lib/payments'
import { getFundingRequestByJobId } from '../lib/payments/fundingRequest'
import { getEscrowPlanByJobId } from '../lib/payments/escrow'
import { useStoreSync } from '../lib/reactive'
import type { CustomerNextStep } from '../lib/jobs/customerNextStepSelectors'

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

type BannerVariant = 'action' | 'waiting' | 'complete'

function getBannerVariant(step: CustomerNextStep): BannerVariant {
  const actionLabels = ['Review Proposal', 'Release Payment', 'Fund Escrow', 'Zahlung einzahlen']
  if (actionLabels.includes(step.label)) return 'action'
  if (step.label === 'Project Complete') return 'complete'
  return 'waiting'
}

type VariantStyle = {
  container: string
  accentBar: string
  eyebrow: string
  iconBg: string
  badge: string | null
  icon: string
}

function getVariantStyle(variant: BannerVariant): VariantStyle {
  if (variant === 'action') {
    return {
      container: 'bg-white ring-amber-200/80',
      accentBar: 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300',
      eyebrow: 'text-amber-600',
      iconBg: 'bg-amber-500',
      badge: 'ACTION REQUIRED',
      icon: '⚡',
    }
  }
  if (variant === 'complete') {
    return {
      container: 'bg-white ring-emerald-200/60',
      accentBar: 'bg-gradient-to-b from-emerald-400 via-emerald-300 to-emerald-200',
      eyebrow: 'text-emerald-600',
      iconBg: 'bg-emerald-500',
      badge: null,
      icon: '✅',
    }
  }
  // waiting
  return {
    container: 'bg-white ring-slate-200/70',
    accentBar: 'bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300',
    eyebrow: 'text-blue-500',
    iconBg: 'bg-blue-600',
    badge: null,
    icon: '⏳',
  }
}

// ---------------------------------------------------------------------------
// Pure view
// ---------------------------------------------------------------------------

function CustomerJobNextStepBannerView({
  step,
  onAction,
}: {
  step: CustomerNextStep
  onAction?: () => void
}) {
  const variant = getBannerVariant(step)
  const styles = getVariantStyle(variant)

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ${styles.container}`}
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] ${styles.accentBar}`}
      />

      {/* Eyebrow + badge row */}
      <div className="flex items-center gap-2">
        <span
          className={`text-[12px] font-semibold uppercase tracking-[0.18em] ${styles.eyebrow}`}
        >
          Next Step
        </span>
        {styles.badge !== null && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-amber-600 ring-1 ring-amber-200">
            {styles.badge}
          </span>
        )}
      </div>

      {/* Icon + label row */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${styles.iconBg}`}
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">{styles.icon}</span>
        </div>
        <h2 className="min-w-0 flex-1 text-[17px] font-semibold leading-snug text-slate-900">
          {step.label}
        </h2>
      </div>

      {/* Hint text */}
      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">{step.hint}</p>

      {/* Optional CTA */}
      {step.actionLabel && onAction && (
        <div className="mt-4">
          <CorridorAction
            variant="primary"
            block={false}
            onClick={onAction}
          >
            {step.actionLabel}
          </CorridorAction>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

type CustomerJobNextStepBannerProps = {
  /** The job ID to derive the next step for */
  jobId: string
  /**
   * When true, the CTA button will navigate to the actionRoute derived by the
   * selector. Pass false (or omit) when the banner is embedded in the
   * project detail screen and the relevant section is already visible.
   */
  enableNavigation?: boolean
  /**
   * Override the project ID used in navigation routes. The selector builds
   * project routes from `job.projectId`, but for inquiry-origin jobs that ID
   * can differ from the customer-facing project. Pass the canonical
   * `project.id` from the parent screen to ensure the CTA lands on the
   * correct project detail page.
   */
  projectId?: string
}

/**
 * Renders a contextual "next step" banner for the customer, derived from the
 * current job + payment state via `deriveCustomerNextStep`.
 *
 * Subscribes to both jobs and payments stores so it stays up to date without
 * requiring parent re-renders.
 */
export default function CustomerJobNextStepBanner({
  jobId,
  enableNavigation = false,
  projectId,
}: CustomerJobNextStepBannerProps) {
  const navigate = useNavigate()

  const [step, setStep] = useState<CustomerNextStep | null>(() => {
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    const fundingRequest = getFundingRequestByJobId(jobId)
    const escrowPlan = getEscrowPlanByJobId(jobId)
    return deriveCustomerNextStep(job, payment ?? undefined, fundingRequest?.status, escrowPlan?.status)
  })

  useStoreSync([subscribeJobs, subscribePayments], () => {
    const job = getJobById(jobId)
    if (!job) {
      setStep(null)
      return
    }
    const payment = getPaymentForJob(jobId)
    const fundingRequest = getFundingRequestByJobId(jobId)
    const escrowPlan = getEscrowPlanByJobId(jobId)
    setStep(deriveCustomerNextStep(job, payment ?? undefined, fundingRequest?.status, escrowPlan?.status))
  })

  if (!step) return null

  // Resolve the correct navigation target. When a projectId override is
  // provided, rewrite any `/projects/<id>` route the selector may have built
  // from job.projectId so the CTA lands on the canonical customer project.
  // If the rewritten route points to the page the user is already on
  // (e.g. `/projects/<projectId>` without query params), suppress the CTA —
  // the relevant section is already visible on the current screen.
  let resolvedRoute = step.actionRoute
  if (resolvedRoute && projectId) {
    resolvedRoute = resolvedRoute.replace(/^\/projects\/[^/?]+/, `/projects/${projectId}`)
    if (resolvedRoute === `/projects/${projectId}`) {
      resolvedRoute = undefined
    }
  }

  const handleAction =
    enableNavigation && resolvedRoute
      ? () => navigate(resolvedRoute!)
      : undefined

  return <CustomerJobNextStepBannerView step={step} onAction={handleAction} />
}
