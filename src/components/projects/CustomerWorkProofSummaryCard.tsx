import { useState } from 'react'
import { getArtifactsByJobId, subscribeMedia, formatPhotoCount } from '../../lib/media'
import { getJobById, subscribeJobs, deriveReleaseReadiness } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string | undefined
}

interface ProofSummaryViewModel {
  photoCount: number
  hasCompletionPhoto: boolean
  hasProgressPhotos: boolean
  isWorkCompleted: boolean
}

function buildProofSummaryVm(jobId: string): ProofSummaryViewModel | null {
  const job = getJobById(jobId)
  if (!job) return null

  const payment = getPaymentForJob(jobId)
  const readiness = deriveReleaseReadiness(job, payment ?? undefined, isPaymentRepositoryHydrated())

  // Only show for work_completed phase (craftsman has marked work done)
  if (!readiness || readiness.phase !== 'work_completed') return null

  const artifacts = getArtifactsByJobId(jobId)
  const progressArtifacts = artifacts.filter(
    (a) => a.kind === 'job_photo' || a.kind === 'work_progress_photo'
  )
  const hasCompletionPhoto = artifacts.some((a) => a.kind === 'completion_photo')
  const hasProgressPhotos = progressArtifacts.length > 0

  return {
    photoCount: progressArtifacts.length,
    hasCompletionPhoto,
    hasProgressPhotos,
    isWorkCompleted: true,
  }
}

function ProofItem({
  present,
  label,
  detail,
}: {
  present: boolean
  label: string
  detail?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] ${
          present
            ? 'bg-emerald-100 text-emerald-600'
            : 'bg-slate-100 text-slate-400'
        }`}
      >
        {present ? '✓' : '○'}
      </div>
      <div className="min-w-0">
        <span className={`text-[13px] font-semibold ${present ? 'text-slate-800' : 'text-slate-500'}`}>
          {label}
        </span>
        {detail && (
          <span className="ml-1 text-[12px] text-slate-400">{detail}</span>
        )}
      </div>
    </div>
  )
}

export default function CustomerWorkProofSummaryCard({ jobId }: Props) {
  function buildVm(): ProofSummaryViewModel | null {
    if (!jobId) return null
    return buildProofSummaryVm(jobId)
  }

  const [vm, setVm] = useState<ProofSummaryViewModel | null>(buildVm)

  useStoreSync([subscribeJobs, subscribePayments, subscribeMedia], () => {
    setVm(buildVm())
  })

  if (!vm) return null

  const docScore = [vm.hasProgressPhotos, vm.hasCompletionPhoto].filter(Boolean).length
  const docLabel =
    docScore === 2
      ? 'Vollständig dokumentiert'
      : docScore === 1
      ? 'Teilweise dokumentiert'
      : 'Keine Fotos vorhanden'

  const docBadgeStyle =
    docScore === 2
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-100'
      : docScore === 1
      ? 'bg-amber-50 text-amber-700 ring-amber-100'
      : 'bg-slate-50 text-slate-500 ring-slate-100'

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_12px_28px_-20px_rgba(2,6,23,0.18)]">
      {/* Left accent bar */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-violet-400 via-violet-300 to-violet-200" />

      {/* Eyebrow + badge */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Arbeitsdokumentation
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.12em] ring-1 ${docBadgeStyle}`}
        >
          {docLabel}
        </span>
      </div>

      {/* Title */}
      <div className="mt-3 flex items-center gap-2">
        <span className="text-[17px] font-semibold text-slate-900">Nachweise zur Ausführung</span>
      </div>

      {/* Description */}
      <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
        Der Handwerker hat die Arbeit als abgeschlossen markiert. Die folgenden Nachweise wurden zur Ausführung dokumentiert.
      </p>

      {/* Divider */}
      <div className="my-4 h-px bg-slate-100" />

      {/* Proof items */}
      <div className="space-y-3">
        <ProofItem
          present={vm.hasProgressPhotos}
          label="Fortschrittsfotos"
          detail={
            vm.photoCount > 0
              ? `${formatPhotoCount(vm.photoCount)} vorhanden`
              : undefined
          }
        />
        <ProofItem
          present={vm.hasCompletionPhoto}
          label="Abschlussfoto"
          detail={vm.hasCompletionPhoto ? 'Fertigstellung belegt' : undefined}
        />
        <ProofItem
          present={true}
          label="Plattformbestätigt"
          detail="Über SaFix abgewickelt"
        />
      </div>

      {/* Info note */}
      {docScore < 2 && (
        <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3">
          <p className="text-[12px] leading-relaxed text-slate-500">
            Auch ohne Fotos ist die Arbeit durch die Plattform bestätigt. Fotos sind optional und dienen als zusätzlicher Nachweis.
          </p>
        </div>
      )}
    </section>
  )
}
