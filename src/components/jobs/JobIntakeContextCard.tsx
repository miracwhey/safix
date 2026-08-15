import { deriveIntakeReadiness } from '../../lib/jobs/intakeSelectors'
import type { Job } from '../../lib/jobs'
import ProjectMediaGrid from '../projects/ProjectMediaGrid'

type Props = {
  job: Job
}

const READINESS_STYLES = {
  red: {
    badge: 'bg-rose-50 text-rose-700 ring-rose-100',
    dot: 'bg-rose-500',
    progressBar: 'bg-rose-400',
    callout: 'bg-rose-50 ring-rose-100',
    calloutText: 'text-rose-700',
  },
  yellow: {
    badge: 'bg-amber-50 text-amber-700 ring-amber-100',
    dot: 'bg-amber-400',
    progressBar: 'bg-amber-400',
    callout: 'bg-amber-50 ring-amber-100',
    calloutText: 'text-amber-700',
  },
  green: {
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    dot: 'bg-emerald-400',
    progressBar: 'bg-emerald-400',
    callout: 'bg-emerald-50 ring-emerald-100',
    calloutText: 'text-emerald-700',
  },
} as const

const ORIGIN_ICONS: Record<string, string> = {
  inquiry_reel: '🎬',
  inquiry_profile: '👤',
  inquiry_project: '📁',
  direct: '📋',
}

/**
 * Displays the structured intake context and readiness status for a job.
 *
 * Intended for use on the craftsman job detail screen when a job is in 'new'
 * status and may have been created from an explore inquiry flow.
 *
 * Shows:
 * - Origin of the intake (reel / profile / direct)
 * - Intake completeness progress bar
 * - Present request fields (location, budget, duration)
 * - List of missing fields the craftsman should clarify
 */
export default function JobIntakeContextCard({ job }: Props) {
  const vm = deriveIntakeReadiness(job)
  const style = READINESS_STYLES[vm.readinessColor]
  const originIcon = ORIGIN_ICONS[vm.origin ?? 'direct'] ?? '📋'
  const progressPct = Math.round((vm.completedCount / vm.totalCount) * 100)

  const ctx = job.intakeContext

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Header */}
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Aufnahme
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-[22px] font-semibold text-slate-900">
          Anfrage-Kontext
        </h2>

        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1',
            style.badge,
          ].join(' ')}
        >
          <span
            className={['h-1.5 w-1.5 rounded-full', style.dot].join(' ')}
          />
          {vm.readinessLabel}
        </span>
      </div>

      <p className="mt-2 text-[14px] text-slate-500">
        Strukturierte Anfragedaten aus dem Ursprungsgespräch.
      </p>

      {/* Completeness progress bar */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-[12px] text-slate-500 mb-1.5">
          <span>Vollständigkeit</span>
          <span className="font-semibold text-slate-700">
            {vm.completedCount} / {vm.totalCount} Felder
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100">
          <div
            className={['h-full rounded-full transition-all', style.progressBar].join(' ')}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Origin + present details */}
      <div className="mt-4 divide-y divide-slate-100">
        <div className="flex items-start justify-between gap-4 py-3">
          <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Herkunft
          </div>
          <div className="text-right text-[15px] font-medium text-slate-900">
            {originIcon} {vm.originLabel}
          </div>
        </div>

        {ctx?.requestLocation ? (
          <div className="flex items-start justify-between gap-4 py-3">
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Ort
            </div>
            <div className="max-w-[60%] text-right text-[15px] font-medium text-slate-900">
              {ctx.requestLocation}
            </div>
          </div>
        ) : null}

        {ctx?.requestBudget ? (
          <div className="flex items-start justify-between gap-4 py-3">
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Budget
            </div>
            <div className="max-w-[60%] text-right text-[15px] font-medium text-slate-900">
              {ctx.requestBudget}
            </div>
          </div>
        ) : null}

        {ctx?.requestDuration ? (
          <div className="flex items-start justify-between gap-4 py-3">
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Dauer
            </div>
            <div className="max-w-[60%] text-right text-[15px] font-medium text-slate-900">
              {ctx.requestDuration}
            </div>
          </div>
        ) : null}

        {ctx?.requestDescription ? (
          <div className="py-3">
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-1">
              Beschreibung
            </div>
            <div className="text-[14px] text-slate-700 leading-relaxed">
              {ctx.requestDescription}
            </div>
          </div>
        ) : null}
      </div>

      {/* Missing fields callout */}
      {vm.missingFields.length > 0 ? (
        <div
          className={[
            'mt-4 rounded-[14px] px-3.5 py-3 ring-1',
            style.callout,
          ].join(' ')}
        >
          <div
            className={[
              'text-[12px] font-semibold mb-2',
              style.calloutText,
            ].join(' ')}
          >
            ⚠ Noch fehlende Angaben
          </div>
          <div className="flex flex-wrap gap-2">
            {vm.missingFields.map((field) => (
              <span
                key={field.id}
                className="inline-flex items-center rounded-full bg-white/70 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200/70"
              >
                {field.label}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Project photos from customer — persisted in Supabase, reload-safe */}
      {job.projectId ? (
        <div className="mt-4">
          <ProjectMediaGrid projectId={job.projectId} viewerUserId={job.craftsmanUserId} />
        </div>
      ) : null}
    </section>
  )
}
