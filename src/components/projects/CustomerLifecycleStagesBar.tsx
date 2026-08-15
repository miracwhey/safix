import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../../lib/payments'
import { getFundingRequestByJobId } from '../../lib/payments/fundingRequest'
import { getEscrowPlanByJobId } from '../../lib/payments/escrow'
import { useStoreSync } from '../../lib/reactive'
import { getActionablePaymentState } from '../../lib/jobs/helpers'
import {
  deriveCustomerJobStage,
  CUSTOMER_STAGE_ORDER,
  CUSTOMER_STAGE_LABELS,
} from '../../lib/jobs/customerJobStageSelectors'

type Props = { jobId: string }

function buildVm(jobId: string) {
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
    escrowPlan?.status
  )
}

/**
 * Horizontal lifecycle stage bar shown on the customer project detail screen.
 * Visually maps where the project is in the Anfrage→Zahlung lifecycle.
 */
export default function CustomerLifecycleStagesBar({ jobId }: Props) {
  const [vm, setVm] = useState(() => buildVm(jobId))
  useStoreSync([subscribeJobs, subscribePayments], () => setVm(buildVm(jobId)))

  if (!vm) return null

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Projektfortschritt
      </div>

      <div className="flex items-start gap-0">
        {CUSTOMER_STAGE_ORDER.map((stage, idx) => {
          const isCompleted = idx < vm.activeIndex
          const isActive = idx === vm.activeIndex
          const isLast = idx === CUSTOMER_STAGE_ORDER.length - 1

          return (
            <div key={stage} className="flex flex-1 flex-col items-center">
              {/* Step node + connector line */}
              <div className="flex w-full items-center">
                {/* Connector left */}
                <div
                  className={[
                    'h-[2px] flex-1',
                    idx === 0 ? 'invisible' : isCompleted || isActive ? 'bg-emerald-400' : 'bg-slate-200',
                  ].join(' ')}
                />

                {/* Circle node */}
                <div
                  className={[
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-2',
                    isCompleted
                      ? 'bg-emerald-500 ring-emerald-200 text-white'
                      : isActive
                        ? 'bg-blue-600 ring-blue-200 text-white'
                        : 'bg-slate-100 ring-slate-200 text-slate-400',
                  ].join(' ')}
                >
                  {isCompleted ? (
                    <span className="text-[11px] leading-none">✓</span>
                  ) : (
                    <span className="text-[10px] font-bold leading-none">
                      {idx + 1}
                    </span>
                  )}
                </div>

                {/* Connector right */}
                <div
                  className={[
                    'h-[2px] flex-1',
                    isLast ? 'invisible' : isCompleted ? 'bg-emerald-400' : 'bg-slate-200',
                  ].join(' ')}
                />
              </div>

              {/* Label */}
              <div
                className={[
                  'mt-1.5 text-center text-[10px] font-semibold leading-tight',
                  isActive
                    ? 'text-blue-700'
                    : isCompleted
                      ? 'text-emerald-600'
                      : 'text-slate-400',
                ].join(' ')}
              >
                {CUSTOMER_STAGE_LABELS[stage]}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
