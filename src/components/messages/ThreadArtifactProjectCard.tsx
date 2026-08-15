import { Link } from 'react-router-dom'
import type { MessageRole } from '../../lib/messages'
import type { ProjectArtifact } from '../../lib/messages/threadArtifactTypes'
import { getProjectDetailPath } from './projectDetailPath'

type Props = {
  artifact: ProjectArtifact
  role: MessageRole
  onSetActive?: (projectId: string) => void
}

const STATUS_LABELS: Record<string, string> = {
  request: 'Anfrage',
  accepted: 'Angenommen',
  scheduled: 'Geplant',
  in_progress: 'In Arbeit',
  review: 'Prüfung',
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
}

const STATUS_STYLES: Record<string, { pill: string; dot: string }> = {
  request: { pill: 'bg-blue-50 text-blue-700 ring-blue-100', dot: 'bg-blue-400' },
  accepted: { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-100', dot: 'bg-emerald-400' },
  scheduled: { pill: 'bg-indigo-50 text-indigo-700 ring-indigo-100', dot: 'bg-indigo-400' },
  in_progress: { pill: 'bg-blue-50 text-blue-700 ring-blue-100', dot: 'bg-blue-400' },
  review: { pill: 'bg-amber-50 text-amber-700 ring-amber-100', dot: 'bg-amber-400' },
  completed: { pill: 'bg-slate-50 text-slate-700 ring-slate-200', dot: 'bg-slate-400' },
  cancelled: { pill: 'bg-rose-50 text-rose-700 ring-rose-200', dot: 'bg-rose-400' },
}

/**
 * Renders a project context card from a canonical ProjectArtifact.
 *
 * LAYER 1 — PERSISTENT CONTEXT: this card sits in the top context bar,
 * above the timeline.  It is compact and premium — slimmer than a
 * timeline event card so the visual hierarchy is clear.
 *
 * SNAPSHOT HARDENING — renders from snapshot data when the full project
 * entity isn't loaded yet.  The full entity enriches the card when available.
 * No legacy conversation metadata or message attachment inference.
 *
 * ACTIVE PROJECT — when isActiveProject is true, the card shows a
 * "Hauptprojekt" badge.  Non-active cards show a customer-facing
 * "Als Hauptprojekt setzen" action (if onSetActive is provided).
 */
export default function ThreadArtifactProjectCard({ artifact, role, onSetActive }: Props) {
  // Use full entity if available, otherwise fall back to snapshot
  const title = artifact.project?.title ?? artifact.snapshot?.title ?? 'Projekt'
  const status = artifact.project?.status ?? artifact.snapshot?.status ?? 'request'
  const projectId = artifact.project?.id ?? artifact.snapshot?.projectId

  const style = STATUS_STYLES[status] ?? STATUS_STYLES.request
  const detailPath = getProjectDetailPath(artifact, role)

  const inner = (
    <div className="flex items-center gap-2.5">
      {/* Status pill */}
      <span
        className={[
          'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[10px] font-semibold ring-1',
          style.pill,
        ].join(' ')}
      >
        <span className={['h-1.5 w-1.5 rounded-full', style.dot].join(' ')} />
        {STATUS_LABELS[status] ?? status}
      </span>

      {artifact.isActiveProject && (
        <span className="shrink-0 text-[10px] font-bold text-amber-600">
          ★ Hauptprojekt
        </span>
      )}

      {/* Title */}
      <span className="min-w-0 truncate text-[13px] font-semibold text-slate-900">
        {title}
      </span>

      {/* CTA */}
      {detailPath ? (
        <span className="ml-auto shrink-0 text-[11px] font-semibold text-[#2563EB]">
          Öffnen →
        </span>
      ) : null}

      {/* Customer-facing action: set as active project */}
      {!detailPath && role === 'customer' && !artifact.isActiveProject && onSetActive && projectId && (
        <button
          type="button"
          data-testid="set-active-project"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSetActive(projectId)
          }}
          className="ml-auto shrink-0 text-[10px] font-semibold text-[#2563EB] hover:text-blue-700 transition"
        >
          Als Hauptprojekt setzen
        </button>
      )}
    </div>
  )

  const ringStyle = artifact.isActiveProject
    ? 'ring-amber-200/50'
    : 'ring-slate-200/50'

  const cardClasses = [
    'rounded-[12px] bg-white px-3 py-2 ring-1',
    ringStyle,
    'shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)]',
  ].join(' ')

  if (detailPath) {
    return (
      <Link
        to={detailPath}
        data-testid="project-card-link"
        className={`block ${cardClasses} transition hover:shadow-[0_6px_16px_-8px_rgba(2,6,23,0.12)] active:bg-slate-50/60`}
      >
        {inner}
      </Link>
    )
  }

  return (
    <div className={cardClasses}>
      {inner}
    </div>
  )
}
