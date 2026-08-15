import type { Job } from './types'
import type { JobSchedule } from '../operations/types'

/**
 * Describes the execution phase of a project that has an accepted proposal.
 *
 * 'awaiting_scheduling'    – accepted but no schedule has been created yet
 * 'scheduling_initialized' – execution workflow started; schedule may exist
 * 'scheduled'              – a schedule exists, awaiting execution
 * 'execution_in_progress'  – execution has started
 * 'execution_complete'     – execution completed
 */
export type PostAcceptancePhase =
  | 'awaiting_scheduling'
  | 'scheduling_initialized'
  | 'scheduled'
  | 'execution_in_progress'
  | 'execution_complete'

export type PostAcceptanceViewModel = {
  /** The current execution kickoff phase */
  phase: PostAcceptancePhase
  /** Short human-readable label */
  phaseLabel: string
  /** Guidance text explaining what happens next */
  phaseDescription: string
  /**
   * Unix timestamp (ms) when the proposal was accepted.
   * Always present since this view-model is only returned for accepted proposals.
   */
  acceptedAt: number
  /** Pre-formatted date string for when the proposal was accepted */
  acceptedLabel: string
  /**
   * True when the craftsman should be prompted to create/confirm a schedule.
   * False once a schedule already exists.
   */
  canInitiateScheduling: boolean
  /**
   * True if the execution kickoff workflow has been triggered
   * (an `execution_ready` timeline event has been recorded for this job).
   */
  executionKickoffStarted: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function derivePhaseFromSchedule(
  schedule: JobSchedule | undefined,
  executionKickoffStarted: boolean
): PostAcceptancePhase {
  if (!schedule) {
    return executionKickoffStarted ? 'scheduling_initialized' : 'awaiting_scheduling'
  }

  const status = schedule.schedulingStatus
  if (status === 'execution_completed') return 'execution_complete'
  if (status === 'execution_started') return 'execution_in_progress'
  return 'scheduled'
}

function getPhaseLabelAndDescription(
  phase: PostAcceptancePhase
): { label: string; description: string } {
  switch (phase) {
    case 'awaiting_scheduling':
      return {
        label: 'Termin einplanen',
        description:
          'Das Angebot wurde angenommen. Als nächstes Termin und Ausführungsfenster einplanen.',
      }
    case 'scheduling_initialized':
      return {
        label: 'Planung gestartet',
        description:
          'Die Ausführungsvorbereitung ist gestartet. Termin und Team können jetzt eingeplant werden.',
      }
    case 'scheduled':
      return {
        label: 'Termin geplant',
        description:
          'Ausführungsfenster ist eingeplant. Termin bestätigen, Team einplanen und Vorbereitung abschließen.',
      }
    case 'execution_in_progress':
      return {
        label: 'Ausführung läuft',
        description:
          'Die Ausführung hat begonnen. Fortschritt dokumentieren und Auftrag operativ weiterführen.',
      }
    case 'execution_complete':
      return {
        label: 'Ausführung abgeschlossen',
        description:
          'Die Ausführung ist abgeschlossen. Abnahme und Zahlungsfreigabe können jetzt eingeleitet werden.',
      }
  }
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Derives a view-model representing the execution kickoff state for a job
 * that has an accepted proposal.
 *
 * Returns null when the job has no accepted proposal (i.e. `proposalAcceptedAt`
 * is absent), since the post-acceptance phase is not yet applicable.
 *
 * This is a pure read helper — it performs no state mutations.
 *
 * @param job      The job entity.
 * @param schedule The job's current schedule (if any).
 * @param hasExecutionReadyEvent  Whether an `execution_ready` timeline event
 *                                has been recorded for this job.
 */
export function derivePostAcceptanceReadiness(
  job: Job,
  schedule?: JobSchedule,
  hasExecutionReadyEvent = false
): PostAcceptanceViewModel | null {
  if (!job.proposalAcceptedAt) return null

  const phase = derivePhaseFromSchedule(schedule, hasExecutionReadyEvent)
  const { label, description } = getPhaseLabelAndDescription(phase)

  return {
    phase,
    phaseLabel: label,
    phaseDescription: description,
    acceptedAt: job.proposalAcceptedAt,
    acceptedLabel: formatTimestamp(job.proposalAcceptedAt),
    canInitiateScheduling: !schedule,
    executionKickoffStarted: hasExecutionReadyEvent,
  }
}
