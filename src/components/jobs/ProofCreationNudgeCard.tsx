import { useState } from 'react'
import { getArtifactsByJobId, subscribeMedia, formatPhotoCount } from '../../lib/media'
import { getJobById, subscribeJobs, deriveReleaseReadiness } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
  onAttachProgressPhoto: () => void
  onAttachCompletionPhoto: () => void
}

interface NudgeViewModel {
  phase: 'execution_active' | 'work_completed'
  photoCount: number
  hasCompletionPhoto: boolean
  hasProgressPhoto: boolean
}

function buildNudgeVm(jobId: string): NudgeViewModel | null {
  const job = getJobById(jobId)
  if (!job) return null

  const payment = getPaymentForJob(jobId)
  const readiness = deriveReleaseReadiness(job, payment ?? undefined, isPaymentRepositoryHydrated())

  if (!readiness) return null
  // Only show for active execution phases; dismiss once payment is released or not applicable
  if (readiness.phase !== 'execution_active' && readiness.phase !== 'work_completed') {
    return null
  }

  const artifacts = getArtifactsByJobId(jobId)
  const photoArtifacts = artifacts.filter(
    (a) =>
      a.kind === 'job_photo' ||
      a.kind === 'work_progress_photo' ||
      a.kind === 'completion_photo'
  )
  const hasCompletionPhoto = artifacts.some((a) => a.kind === 'completion_photo')
  const hasProgressPhoto = artifacts.some(
    (a) => a.kind === 'job_photo' || a.kind === 'work_progress_photo'
  )

  return {
    phase: readiness.phase,
    photoCount: photoArtifacts.length,
    hasCompletionPhoto,
    hasProgressPhoto,
  }
}

function DocStatusPill({ met, label }: { met: boolean; label: string }) {
  if (met) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
        <span>✓</span> {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
      <span>○</span> {label}
    </span>
  )
}

export default function ProofCreationNudgeCard({
  jobId,
  onAttachProgressPhoto,
  onAttachCompletionPhoto,
}: Props) {
  const [vm, setVm] = useState<NudgeViewModel | null>(() => buildNudgeVm(jobId))

  useStoreSync([subscribeJobs, subscribePayments, subscribeMedia], () => {
    setVm(buildNudgeVm(jobId))
  })

  if (!vm) return null

  const isExecutionActive = vm.phase === 'execution_active'

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-blue-50 p-5 ring-1 ring-blue-100 shadow-[0_12px_28px_-20px_rgba(59,130,246,0.2)]">
      {/* Left accent bar */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300" />

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[16px] leading-none">📸</span>
          <span className="text-[13px] font-semibold text-blue-900">
            Arbeit dokumentieren
          </span>
        </div>
        {vm.photoCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-bold text-blue-700">
            {formatPhotoCount(vm.photoCount)}
          </span>
        )}
      </div>

      {/* Documentation status pills */}
      <div className="mt-3 flex flex-wrap gap-2">
        <DocStatusPill met={vm.hasProgressPhoto} label="Fortschrittsfotos" />
        <DocStatusPill met={vm.hasCompletionPhoto} label="Abschlussfoto" />
      </div>

      {/* Context message */}
      <p className="mt-3 text-[13px] leading-relaxed text-blue-700">
        {isExecutionActive
          ? 'Gut belegte Aufträge bauen Vertrauen auf und werden schneller bezahlt. Fotos sind optional, aber empfohlen.'
          : 'Diese Nachweise werden im Abschlussprotokoll gespeichert und stärken dein Profil.'}
      </p>

      {/* Primary action buttons during execution */}
      {isExecutionActive && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onAttachProgressPhoto}
            className="flex-1 rounded-2xl bg-white px-3 py-2.5 text-[13px] font-semibold text-blue-800 ring-1 ring-blue-200 transition-colors hover:bg-blue-50 active:scale-[0.99]"
          >
            + Fortschrittsfoto
          </button>
          <button
            type="button"
            onClick={onAttachCompletionPhoto}
            className="flex-1 rounded-2xl bg-blue-600 px-3 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 active:scale-[0.99]"
          >
            + Abschlussfoto
          </button>
        </div>
      )}

      {/* Work completed: offer to add missing completion photo */}
      {!isExecutionActive && !vm.hasCompletionPhoto && (
        <button
          type="button"
          onClick={onAttachCompletionPhoto}
          className="mt-3 w-full rounded-2xl bg-white px-3 py-2.5 text-[13px] font-semibold text-blue-800 ring-1 ring-blue-200 transition-colors hover:bg-blue-50"
        >
          📷 Abschlussfoto nachträglich hinzufügen
        </button>
      )}
    </section>
  )
}
