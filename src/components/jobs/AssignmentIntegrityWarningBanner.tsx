import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AssignmentIntegrityWarning } from '../../lib/jobs'
import type { TeamMember } from '../../lib/jobs/types'
import QueueAssignmentPanel from '../dashboard/QueueAssignmentPanel'

type Props = {
  warning: AssignmentIntegrityWarning
  teamMembers: TeamMember[]
  onAssignWorker: (jobId: string, memberId: string) => void
  onTakeJobMyself: (jobId: string) => void
}

type GapKind = 'in_progress' | 'scheduled'

type GapRow = {
  id: string
  title: string
  kind: GapKind
}

/**
 * AssignmentIntegrityWarningBanner
 *
 * Compact warning banner for the CraftsmanJobsScreen that surfaces active
 * and scheduled jobs with no team member assigned.
 *
 * An unassigned in_progress job is a critical pilot risk: work is happening
 * without clear ownership. A scheduled job without an assignee means the
 * appointment may go unattended.
 *
 * Each affected job exposes an inline "Zuweisen ›" affordance that expands
 * the canonical `QueueAssignmentPanel` directly in the banner — owner stays
 * on the jobs surface and assigns in a single tap. Detail-Link bleibt als
 * sekundärer Pfad erhalten für Kontext-Lookup. Only one row is expanded at
 * a time to keep the banner compact regardless of gap count.
 *
 * Only rendered when `warning.hasAnyGap` is true.
 */
export default function AssignmentIntegrityWarningBanner({
  warning,
  teamMembers,
  onAssignWorker,
  onTakeJobMyself,
}: Props) {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)

  if (!warning.hasAnyGap) return null

  const isCritical = warning.hasActiveGap

  const rows: GapRow[] = [
    ...warning.inProgressUnassigned.map((j): GapRow => ({
      id: j.id,
      title: j.title,
      kind: 'in_progress',
    })),
    ...warning.scheduledUnassigned.map((j): GapRow => ({
      id: j.id,
      title: j.title,
      kind: 'scheduled',
    })),
  ]

  const toggle = (jobId: string) => {
    setExpandedJobId((prev) => (prev === jobId ? null : jobId))
  }

  const handleAssign = (jobId: string, memberId: string) => {
    onAssignWorker(jobId, memberId)
    setExpandedJobId(null)
  }

  const handleTakeMyself = (jobId: string) => {
    onTakeJobMyself(jobId)
    setExpandedJobId(null)
  }

  return (
    <div
      className={`rounded-[22px] p-4 ring-1 ${
        isCritical
          ? 'bg-rose-50 ring-rose-200/80'
          : 'bg-amber-50 ring-amber-200/70'
      }`}
    >
      {/* Header */}
      <div
        className={`text-[12px] font-semibold uppercase tracking-[0.14em] ${
          isCritical ? 'text-rose-600' : 'text-amber-600'
        }`}
      >
        {isCritical ? 'Sofortiger Handlungsbedarf' : 'Priorisierung empfohlen'}
      </div>
      <div
        className={`mt-1 text-[14px] font-semibold ${
          isCritical ? 'text-rose-900' : 'text-amber-900'
        }`}
      >
        {warning.gapCount === 1
          ? '1 Auftrag ohne zugewiesenen Mitarbeiter'
          : `${warning.gapCount} Aufträge ohne zugewiesenen Mitarbeiter`}
      </div>

      {/* Count chips */}
      <div className="mt-2 flex flex-wrap gap-2">
        {warning.inProgressUnassigned.length > 0 && (
          <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">
            {warning.inProgressUnassigned.length} in Arbeit
          </span>
        )}
        {warning.scheduledUnassigned.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
            {warning.scheduledUnassigned.length} geplant
          </span>
        )}
      </div>

      {/* Affected jobs — each row exposes an inline assignment trigger.
          Skalierbarkeit: nur die erste vier Reihen werden gerendert wenn
          gapCount klein ist; bei mehr Lücken bleibt die Liste sichtbar bis
          eine Zuweisung erfolgt — Reduktion durch "weitere ansehen" ist
          nicht nötig, weil der Auswahl-Sheet pro Row darunter expandiert
          und nicht die Banner-Höhe verdoppelt. */}
      <div className="mt-3 space-y-1.5">
        {rows.map((row) => {
          const isExpanded = expandedJobId === row.id
          const isInProgress = row.kind === 'in_progress'
          const dotClass = isInProgress ? 'bg-rose-500' : 'bg-amber-400'
          const statusLabel = isInProgress ? 'In Arbeit – nicht zugeteilt' : 'Geplant – nicht zugeteilt'
          const statusColor = isInProgress ? 'text-rose-600' : 'text-amber-600'

          return (
            <div key={row.id} className="rounded-[14px] bg-white/70 ring-1 ring-white/70">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-slate-900">
                  {row.title}
                </span>
                <span className={`shrink-0 text-[11px] ${statusColor}`}>{statusLabel}</span>
                <button
                  type="button"
                  onClick={() => toggle(row.id)}
                  aria-expanded={isExpanded}
                  data-testid={`assignment-warning-toggle-${row.id}`}
                  className="ml-2 shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-blue-700/20 transition active:scale-[0.97]"
                >
                  {isExpanded ? 'Schließen' : 'Zuweisen'}
                </button>
                <Link
                  to={`/craftsman/jobs/${row.id}?focus=assignment`}
                  className="shrink-0 text-[11px] text-slate-400 transition hover:text-slate-600"
                  aria-label={`Auftrag ${row.title} im Detail öffnen`}
                >
                  Detail →
                </Link>
              </div>
              {isExpanded && (
                <div className="px-3 pb-3">
                  <QueueAssignmentPanel
                    jobId={row.id}
                    teamMembers={teamMembers}
                    onAssign={handleAssign}
                    onTakeMyself={handleTakeMyself}
                    onClose={() => setExpandedJobId(null)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
