import { Link } from 'react-router-dom'
import type { ActionQueueItem } from '../../lib/dashboard/actionQueueSelectors'
import type { TeamMember } from '../../lib/jobs/types'
import { resolveCanonicalProjectFacts } from '../../lib/shared/canonicalProjectFacts'
import QueueAssignmentPanel from './QueueAssignmentPanel'
import QueueAppointmentPanel from './QueueAppointmentPanel'

type Props = {
  item: ActionQueueItem
  /** Whether this card's inline action panel is currently expanded */
  isExpanded: boolean
  /** Toggle the inline action panel for this card */
  onToggleExpand: (jobId: string) => void
  /** Team members available for assignment */
  teamMembers: TeamMember[]
  /** Assign a team member to a job */
  onAssignWorker: (jobId: string, memberId: string) => void
  /** Craftsman takes the job themselves */
  onTakeJobMyself: (jobId: string) => void
  /** Schedule an appointment for a job */
  onScheduleAppointment: (jobId: string, start: number, end: number) => void
}

/**
 * Action Queue Job Card
 *
 * Compact, operational job card for the action queue screen.
 * Shows: title, customer · amount, phase label, next step, and quick action.
 *
 * Design rules:
 * - max 1 primary quick action
 * - optional 1 secondary quick action
 * - direct actions open inline action panel (max one active at a time)
 * - contextual actions navigate to job detail
 * - full card tap opens job detail
 * - no bloated cards
 * - no competing technical states
 */
export default function ActionQueueJobCard({
  item,
  isExpanded,
  onToggleExpand,
  teamMembers,
  onAssignWorker,
  onTakeJobMyself,
  onScheduleAppointment,
}: Props) {
  const { job, phaseLabel, nextStepLabel, primaryAction, secondaryAction, hasDispute } = item

  // Resolve canonical facts for consistent display
  const facts = resolveCanonicalProjectFacts(job.id)
  const displayTitle = facts?.title ?? job.title
  const displayCustomer = facts?.customer ?? job.customer
  const displayAmount = facts?.canonicalAmount?.formatted ?? job.amount

  const jobDetailRoute = `/craftsman/jobs/${job.id}`

  const borderColor = hasDispute
    ? 'ring-red-200'
    : job.status === 'waiting_payment'
      ? 'ring-amber-200'
      : 'ring-slate-200/70'

  const phaseDot = hasDispute
    ? 'bg-red-500'
    : job.status === 'waiting_payment'
      ? 'bg-amber-500'
      : job.status === 'in_progress'
        ? 'bg-emerald-500'
        : job.status === 'new'
          ? 'bg-blue-500'
          : 'bg-slate-400'

  // Compact context line: customer · amount
  const contextParts: string[] = []
  if (displayCustomer) contextParts.push(displayCustomer)
  if (displayAmount) contextParts.push(displayAmount)
  const contextLine = contextParts.join(' · ')

  // Determine which inline panel to show when expanded
  const expandedPanelType = primaryAction?.actionType === 'direct' ? primaryAction.id : null

  const handlePrimaryClick = (e: React.MouseEvent) => {
    if (primaryAction?.actionType === 'direct') {
      e.preventDefault()
      onToggleExpand(job.id)
    }
    // contextual actions: let the Link navigate naturally
  }

  const handleSecondaryClick = (e: React.MouseEvent) => {
    if (secondaryAction?.actionType === 'direct') {
      e.preventDefault()
      // Secondary direct actions use the same panel as primary
      onToggleExpand(job.id)
    }
  }

  return (
    <div className={`rounded-xl bg-white p-3 ring-1 ${borderColor} shadow-[0_2px_8px_-6px_rgba(2,6,23,0.1)]`}>
      {/* Tappable area for full job detail */}
      <Link
        to={jobDetailRoute}
        className="block"
      >
        {/* Header: title + phase */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-slate-900">
            {displayTitle}
          </h3>
          <div className="flex shrink-0 items-center gap-1">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${phaseDot}`} />
            <span className="text-[11px] font-semibold text-slate-500">
              {phaseLabel}
            </span>
          </div>
        </div>

        {/* Context: customer · amount */}
        {contextLine && (
          <p className="mt-0.5 truncate text-[12px] text-slate-400">
            {contextLine}
          </p>
        )}

        {/* Next step line */}
        <p className="mt-1.5 text-[12px] text-slate-500">
          {nextStepLabel}
        </p>
      </Link>

      {/* Quick actions */}
      {(primaryAction || secondaryAction) && (
        <div className="mt-2 flex items-center gap-2">
          {primaryAction && primaryAction.actionType === 'direct' ? (
            <button
              type="button"
              onClick={handlePrimaryClick}
              className="inline-flex rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white transition active:scale-[0.97]"
              data-testid={`action-${primaryAction.id}`}
            >
              {primaryAction.id === 'assign_worker' ? 'Zuteilen' : primaryAction.label}
            </button>
          ) : primaryAction ? (
            <Link
              to={jobDetailRoute}
              className="inline-flex rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white transition active:scale-[0.97]"
            >
              {primaryAction.label}
            </Link>
          ) : null}
          {/* Secondary action — suppress take_job (surfaced inside assignment panel) */}
          {secondaryAction && secondaryAction.id !== 'take_job' && secondaryAction.actionType === 'direct' ? (
            <button
              type="button"
              onClick={handleSecondaryClick}
              className="inline-flex rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition active:scale-[0.97]"
              data-testid={`action-${secondaryAction.id}`}
            >
              {secondaryAction.label}
            </button>
          ) : secondaryAction && secondaryAction.id !== 'take_job' ? (
            <Link
              to={jobDetailRoute}
              className="inline-flex rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition active:scale-[0.97]"
            >
              {secondaryAction.label}
            </Link>
          ) : null}
          {/* Detail link when primary is direct */}
          {primaryAction?.actionType === 'direct' && (
            <Link
              to={jobDetailRoute}
              className="ml-auto text-[11px] text-slate-400 hover:text-slate-600 active:opacity-70 transition"
            >
              Details →
            </Link>
          )}
        </div>
      )}

      {/* Inline action panel — only one card may be expanded at a time */}
      {isExpanded && expandedPanelType === 'assign_worker' && (
        <QueueAssignmentPanel
          jobId={job.id}
          teamMembers={teamMembers}
          onAssign={onAssignWorker}
          onTakeMyself={onTakeJobMyself}
          onClose={() => onToggleExpand(job.id)}
        />
      )}
      {isExpanded && expandedPanelType === 'plan_appointment' && (
        <QueueAppointmentPanel
          jobId={job.id}
          onSchedule={onScheduleAppointment}
          onClose={() => onToggleExpand(job.id)}
        />
      )}
    </div>
  )
}

