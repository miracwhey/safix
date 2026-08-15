import { useState, useRef } from 'react'
import { getJobById, subscribeJobs, deriveReleaseReadiness } from '../../lib/jobs'
import type { ReleaseReadinessViewModel } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import { getArtifactsByJobId, subscribeMedia } from '../../lib/media'
import { markWorkCompleteWorkflow, customerReleasePaymentWorkflow } from '../../lib/workflow'
import { useStoreSync } from '../../lib/reactive'
import CorridorAction from '../system/CorridorAction'

type Props = {
  jobId: string
  /**
   * 'craftsman' — shows "Mark Work Complete" action when applicable.
   * 'customer'  — shows "Release Payment" action when applicable.
   */
  role: 'craftsman' | 'customer'
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

type PhaseStyle = {
  accentBar: string
  badge: string
  badgeText: string
  dot: string
  icon: string
}

const PHASE_STYLES: Record<ReleaseReadinessViewModel['phase'], PhaseStyle> = {
  execution_active: {
    accentBar: 'bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300',
    badge: 'bg-blue-50 text-blue-700 ring-1 ring-blue-100',
    badgeText: 'IN ARBEIT',
    dot: 'bg-blue-500',
    icon: '🔨',
  },
  work_completed: {
    accentBar: 'bg-gradient-to-b from-violet-500 via-violet-400 to-violet-300',
    badge: 'bg-violet-50 text-violet-700 ring-1 ring-violet-100',
    badgeText: 'ABGESCHLOSSEN',
    dot: 'bg-violet-500',
    icon: '✅',
  },
  payment_released: {
    accentBar: 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300',
    badge: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
    badgeText: 'BEZAHLT',
    dot: 'bg-emerald-500',
    icon: '🎉',
  },
  not_applicable: {
    accentBar: 'bg-gradient-to-b from-slate-300 via-slate-200 to-slate-100',
    badge: 'bg-slate-50 text-slate-500 ring-1 ring-slate-100',
    badgeText: '',
    dot: 'bg-slate-300',
    icon: '⏳',
  },
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

type DocStatus = {
  hasProgressPhoto: boolean
  hasCompletionPhoto: boolean
}

function DocStatusPill({ met, label }: { met: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
      met ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
    }`}>
      <span>{met ? '✓' : '○'}</span> {label}
    </span>
  )
}

function ExecutionProgressCardView({
  vm,
  role,
  docStatus,
  onMarkComplete,
  onReleasePayment,
  isReleasing,
  releaseError,
}: {
  vm: ReleaseReadinessViewModel
  role: Props['role']
  docStatus: DocStatus
  onMarkComplete: () => void
  onReleasePayment: () => void
  isReleasing: boolean
  releaseError: string | null
}) {
  const style = PHASE_STYLES[vm.phase]

  return (
    <section
      className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]"
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] ${style.accentBar}`}
      />

      {/* Eyebrow */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Ausführungsfortschritt
        </span>
        {style.badgeText && (
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] ${style.badge}`}>
            {style.badgeText}
          </span>
        )}
      </div>

      {/* Icon + Phase label row */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${style.dot}`}
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">{style.icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            {vm.phaseLabel}
          </h2>
        </div>
      </div>

      {/* Phase description */}
      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
        {vm.phaseDescription}
      </p>

      {/* Progress dots */}
      <div className="mt-4 flex items-center gap-2">
        <ProgressDot reached={true} completed={vm.phase !== 'execution_active'} label="Arbeit läuft" />
        <div className={`h-px flex-1 ${vm.phase !== 'execution_active' ? 'bg-violet-300' : 'bg-slate-200'}`} />
        <ProgressDot reached={vm.phase === 'work_completed' || vm.phase === 'payment_released'} completed={vm.phase === 'payment_released'} label="Fertig" />
        <div className={`h-px flex-1 ${vm.phase === 'payment_released' ? 'bg-emerald-300' : 'bg-slate-200'}`} />
        <ProgressDot reached={vm.phase === 'payment_released'} completed={false} label="Bezahlt" />
      </div>

      {/* Documentation status */}
      <div className="mt-3 flex flex-wrap gap-2">
        <DocStatusPill met={docStatus.hasProgressPhoto} label="Fortschrittsfoto" />
        <DocStatusPill met={docStatus.hasCompletionPhoto} label="Abschlussfoto" />
      </div>

      {/* Craftsman action: Mark Work Complete */}
      {role === 'craftsman' && vm.canMarkComplete && (
        <CorridorAction
          variant="primary"
          onClick={onMarkComplete}
          className="mt-4"
        >
          ✓ Arbeit als abgeschlossen markieren
        </CorridorAction>
      )}

      {/* Customer action: Release Payment */}
      {role === 'customer' && vm.canReleasePayment && (
        <>
          <CorridorAction
            variant="primary"
            onClick={onReleasePayment}
            loading={isReleasing}
            disabled={isReleasing}
            className="mt-4"
          >
            {isReleasing ? 'Wird freigegeben …' : '💸 Bestätigen & freigeben'}
          </CorridorAction>
          {releaseError && (
            <p className="mt-1.5 text-[12px] text-red-500">{releaseError}</p>
          )}
        </>
      )}
    </section>
  )
}

function ProgressDot({
  reached,
  completed,
  label,
}: {
  /** True when this stage has been reached (currently active or past) */
  reached: boolean
  /** True when this stage has been fully completed and surpassed */
  completed: boolean
  label: string
}) {
  const dotClass = completed
    ? 'bg-emerald-500 ring-emerald-100'
    : reached
    ? 'bg-violet-500 ring-violet-100'
    : 'bg-slate-200 ring-slate-100'

  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`h-3 w-3 rounded-full ring-2 ${dotClass}`} />
      <span className="text-[10px] text-slate-400">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

function buildDocStatus(jobId: string): DocStatus {
  const artifacts = getArtifactsByJobId(jobId)
  return {
    hasProgressPhoto: artifacts.some((a) => a.kind === 'job_photo' || a.kind === 'work_progress_photo'),
    hasCompletionPhoto: artifacts.some((a) => a.kind === 'completion_photo'),
  }
}

export default function ExecutionProgressCard({ jobId, role }: Props) {
  function buildVm(): ReleaseReadinessViewModel | null {
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    return deriveReleaseReadiness(job, payment ?? undefined, isPaymentRepositoryHydrated())
  }

  const [vm, setVm] = useState<ReleaseReadinessViewModel | null>(buildVm)
  const [docStatus, setDocStatus] = useState<DocStatus>(() => buildDocStatus(jobId))
  const [isReleasing, setIsReleasing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const releasingRef = useRef(false)

  useStoreSync([subscribeJobs, subscribePayments, subscribeMedia], () => {
    setVm(buildVm())
    setDocStatus(buildDocStatus(jobId))
  })

  if (!vm) return null

  const handleMarkComplete = () => {
    void markWorkCompleteWorkflow(jobId).then(() => setVm(buildVm()))
  }

  const handleReleasePayment = async () => {
    if (releasingRef.current) return
    releasingRef.current = true
    setIsReleasing(true)
    setReleaseError(null)
    try {
      await customerReleasePaymentWorkflow(jobId)
      setVm(buildVm())
    } catch (e) {
      console.error(e)
      setReleaseError('Freigabe fehlgeschlagen. Bitte erneut versuchen.')
      setVm(buildVm())
    } finally {
      releasingRef.current = false
      setIsReleasing(false)
    }
  }

  return (
    <ExecutionProgressCardView
      vm={vm}
      role={role}
      docStatus={docStatus}
      onMarkComplete={handleMarkComplete}
      onReleasePayment={() => void handleReleasePayment()}
      isReleasing={isReleasing}
      releaseError={releaseError}
    />
  )
}
