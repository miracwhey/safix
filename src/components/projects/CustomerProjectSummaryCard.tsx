import type { Project } from '../../lib/projects'
import { deriveProjectBuilderReadiness } from '../../lib/projects'

type Props = {
  project: Project
  /** Called when the customer triggers the "Anfrage senden" CTA. */
  onStartInquiry?: () => void
}

/**
 * Summary card for a builder-created project.
 *
 * Shows the structured project attributes collected in the guided builder
 * flow (category, description, location, budget, timing) together with a
 * completeness indicator and a primary CTA that lets the customer send an
 * inquiry to a matching craftsman.
 *
 * Used in CustomerProjectDetailScreen and CustomerProjectsScreen for
 * projects with source === 'builder' and status === 'request'.
 */
export default function CustomerProjectSummaryCard({ project, onStartInquiry }: Props) {
  const readiness = deriveProjectBuilderReadiness({
    category: project.category,
    description: project.description,
    location: project.location,
    requestedBudget: project.requestedBudget,
    requestedTiming: project.requestedTiming,
    title: project.title,
  })

  const completionColor =
    readiness.completionLevel === 'excellent'
      ? 'bg-emerald-500'
      : readiness.completionLevel === 'good'
        ? 'bg-blue-500'
        : 'bg-amber-400'

  const completionLabel =
    readiness.completionLevel === 'excellent'
      ? 'Sehr vollständig'
      : readiness.completionLevel === 'good'
        ? 'Gut ausgefüllt'
        : 'Grundlegende Angaben'

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Projektbeschreibung
        </div>
        {project.category && (
          <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-[12px] font-semibold text-[#2563EB] ring-1 ring-blue-200/60">
            {project.category}
          </span>
        )}
      </div>

      {/* Description */}
      {project.description && (
        <p className="mt-3 text-[14px] leading-relaxed text-slate-700">
          {project.description}
        </p>
      )}

      {/* Details grid */}
      <div className="mt-4 divide-y divide-slate-100">
        {project.location && (
          <DetailRow icon="📍" label="Ort" value={project.location} />
        )}
        {project.requestedBudget && (
          <DetailRow icon="💶" label="Budget" value={project.requestedBudget} />
        )}
        {project.requestedTiming && (
          <DetailRow icon="📅" label="Zeitraum" value={project.requestedTiming} />
        )}
      </div>

      {/* Completeness bar */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] text-slate-500">{completionLabel}</span>
          <span className="text-[12px] font-semibold text-slate-700">
            {readiness.completionScore} %
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all duration-500 ${completionColor}`}
            style={{ width: `${readiness.completionScore}%` }}
          />
        </div>
        {readiness.missingOptional.length > 0 && (
          <p className="mt-1.5 text-[11px] text-slate-400">
            Optional ergänzen: {readiness.missingOptional.join(', ')}
          </p>
        )}
      </div>

      {/* Inquiry CTA */}
      {onStartInquiry && (
        <button
          onClick={onStartInquiry}
          className="mt-5 w-full rounded-[18px] bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)] transition active:scale-[0.99]"
        >
          Handwerker anfragen →
        </button>
      )}
    </section>
  )
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: string
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[15px] leading-none">{icon}</span>
        <span className="text-[14px] text-slate-500">{label}</span>
      </div>
      <span className="text-[14px] font-semibold text-slate-900">{value}</span>
    </div>
  )
}
