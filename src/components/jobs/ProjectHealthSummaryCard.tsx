import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../../lib/payments'
import { getDisputeByJobId, subscribeDisputes } from '../../lib/disputes'
import { getScheduleForJob, subscribeOperations } from '../../lib/operations'
import { getArtifactsByJobId, subscribeMedia } from '../../lib/media'
import { useStoreSync } from '../../lib/reactive'
import { getActionablePaymentState } from '../../lib/jobs/helpers'
import {
  deriveProjectHealth,
  type HealthStatus,
  type ProjectHealthIndicator,
  type ProjectHealthSummaryViewModel,
} from '../../lib/jobs/projectHealthSelectors'

type Props = {
  jobId: string
}

type OverallStyles = {
  card: string
  accentBar: string
  eyebrow: string
  badge: string
  badgeColors: string
}

function getOverallStyles(status: HealthStatus): OverallStyles {
  switch (status) {
    case 'critical':
      return {
        card: 'bg-white ring-rose-200/80',
        accentBar: 'bg-gradient-to-b from-rose-500 via-rose-400 to-rose-300',
        eyebrow: 'text-rose-600',
        badge: 'KRITISCH',
        badgeColors: 'bg-rose-50 text-rose-600 ring-rose-200',
      }
    case 'warning':
      return {
        card: 'bg-white ring-amber-200/80',
        accentBar: 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300',
        eyebrow: 'text-amber-600',
        badge: 'WARNUNG',
        badgeColors: 'bg-amber-50 text-amber-600 ring-amber-200',
      }
    case 'pending':
      return {
        card: 'bg-white ring-blue-200/70',
        accentBar: 'bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300',
        eyebrow: 'text-blue-500',
        badge: '',
        badgeColors: '',
      }
    case 'ok':
      return {
        card: 'bg-white ring-emerald-200/70',
        accentBar: 'bg-gradient-to-b from-emerald-400 via-emerald-300 to-emerald-200',
        eyebrow: 'text-emerald-600',
        badge: '',
        badgeColors: '',
      }
    default:
      return {
        card: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-slate-300 via-slate-200 to-slate-100',
        eyebrow: 'text-slate-400',
        badge: '',
        badgeColors: '',
      }
  }
}

function getIndicatorDotClass(status: HealthStatus): string {
  switch (status) {
    case 'critical':
      return 'bg-rose-500'
    case 'warning':
      return 'bg-amber-400'
    case 'pending':
      return 'bg-blue-400'
    case 'ok':
      return 'bg-emerald-400'
    default:
      return 'bg-slate-200'
  }
}

function HealthIndicatorRow({ indicator }: { indicator: ProjectHealthIndicator }) {
  const content = (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[14px] leading-none">{indicator.icon}</span>
        <span className="text-[13px] text-slate-500">{indicator.label}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className={`h-2 w-2 rounded-full ${getIndicatorDotClass(indicator.status)}`} />
        <span className="text-[12px] font-medium text-slate-700">{indicator.statusLabel}</span>
        {indicator.actionHref && (
          <ChevronRight size={12} className="text-slate-400" />
        )}
      </div>
    </>
  )

  if (indicator.actionHref) {
    return (
      <Link
        to={indicator.actionHref}
        className="flex items-center justify-between py-2 -mx-1 px-1 rounded-lg transition hover:bg-slate-50 active:scale-[0.99]"
      >
        {content}
      </Link>
    )
  }

  return (
    <div className="flex items-center justify-between py-2">
      {content}
    </div>
  )
}

function ProjectHealthSummaryView({ vm }: { vm: ProjectHealthSummaryViewModel }) {
  const styles = getOverallStyles(vm.overallStatus)

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ${styles.card}`}
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] ${styles.accentBar}`}
      />

      {/* Eyebrow + status badge */}
      <div className="flex items-center justify-between">
        <div
          className={`text-[12px] font-semibold uppercase tracking-[0.18em] ${styles.eyebrow}`}
        >
          Projektstatus
        </div>
        {styles.badge && (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${styles.badgeColors}`}
          >
            {styles.badge}
          </span>
        )}
      </div>

      {/* Overall label */}
      <div className="mt-2 text-[17px] font-semibold text-slate-900">
        {vm.overallLabel}
      </div>

      {/* Indicator rows */}
      <div className="mt-4 divide-y divide-slate-100">
        {vm.indicators.map((indicator) => (
          <HealthIndicatorRow key={indicator.id} indicator={indicator} />
        ))}
      </div>
    </section>
  )
}

export default function ProjectHealthSummaryCard({ jobId }: Props) {
  const [vm, setVm] = useState<ProjectHealthSummaryViewModel | null>(() => {
  const job = getJobById(jobId)
  if (!job) return null
  const payment = getPaymentForJob(jobId)
  const dispute = getDisputeByJobId(jobId)
  const schedule = getScheduleForJob(jobId)
  const artifacts = getArtifactsByJobId(jobId)
  const effectivePaymentState = getActionablePaymentState(job, payment)
  return deriveProjectHealth(
    job.status,
    effectivePaymentState,
    dispute?.status,
    schedule?.schedulingStatus,
    artifacts.length
  )
})

  useStoreSync(
    [subscribeJobs, subscribePayments, subscribeDisputes, subscribeOperations, subscribeMedia],
    () => {
      const job = getJobById(jobId)
      if (!job) {
        setVm(null)
        return
      }
      const payment = getPaymentForJob(jobId)
      const dispute = getDisputeByJobId(jobId)
      const schedule = getScheduleForJob(jobId)
      const artifacts = getArtifactsByJobId(jobId)
      const effectivePaymentState = getActionablePaymentState(job, payment)
      setVm(
        deriveProjectHealth(
          job.status,
          effectivePaymentState,
          dispute?.status,
          schedule?.schedulingStatus,
          artifacts.length
        )
      )
    },
  )

  if (!vm) return null

  return <ProjectHealthSummaryView vm={vm} />
}
