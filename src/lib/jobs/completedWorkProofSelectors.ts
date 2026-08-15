import type { Job } from './types'
import type { Payment } from '../payments'
import type { Dispute } from '../disputes/types'
import type { MediaArtifact } from '../media/types'
import type { JobFeedback } from '../feedback/types'
import { deriveJobCompletionSummary } from './jobCompletionSelectors'
import type { JobCompletionSummaryViewModel } from './jobCompletionSelectors'

export type ProofSignalKind =
  | 'photo_documented'
  | 'completion_photo'
  | 'feedback_positive'
  | 'feedback_given'
  | 'platform_backed'

export interface ProofSignal {
  kind: ProofSignalKind
  label: string
  icon: string
}

export interface CompletedWorkProofViewModel extends JobCompletionSummaryViewModel {
  /** Number of photo artifacts (progress + completion photos) */
  photoCount: number
  /** Whether a completion_photo artifact exists */
  hasCompletionPhoto: boolean
  /** Whether any feedback was submitted for this job */
  hasFeedback: boolean
  /** Whether the feedback is positive (wouldHireAgain === true) */
  feedbackIsPositive: boolean | undefined
  /** The optional feedback note left by the customer */
  feedbackNote: string | undefined
  /** Computed proof signals to display as badges */
  proofSignals: ProofSignal[]
}

/**
 * Derives the completed work proof view model for a job.
 *
 * Combines the terminal completion summary with:
 * - media artifact counts (photos, completion photo)
 * - feedback signal (wouldHireAgain, note)
 * - platform-backed proof status
 *
 * Returns null when the job has not yet reached a terminal completed state.
 */
export function deriveCompletedWorkProof(
  job: Job,
  payment: Payment | undefined,
  artifacts: MediaArtifact[],
  feedback?: JobFeedback,
  dispute?: Dispute,
): CompletedWorkProofViewModel | null {
  const summary = deriveJobCompletionSummary(job, payment, dispute)
  if (!summary) return null

  const jobArtifacts = artifacts.filter((a) => a.jobId === job.id)
  const photoArtifacts = jobArtifacts.filter(
    (a) =>
      a.kind === 'job_photo' ||
      a.kind === 'work_progress_photo' ||
      a.kind === 'completion_photo'
  )
  const hasCompletionPhoto = jobArtifacts.some((a) => a.kind === 'completion_photo')

  const hasFeedback = !!feedback
  const feedbackIsPositive = feedback?.wouldHireAgain
  const feedbackNote = feedback?.note

  const proofSignals: ProofSignal[] = []

  // Platform-backed is always present for a terminal completed job
  proofSignals.push({
    kind: 'platform_backed',
    label: 'Plattformbestätigt',
    icon: '🏅',
  })

  if (photoArtifacts.length > 0) {
    proofSignals.push({
      kind: 'photo_documented',
      label: `${photoArtifacts.length} ${photoArtifacts.length === 1 ? 'Foto' : 'Fotos'} dokumentiert`,
      icon: '📷',
    })
  }

  if (hasCompletionPhoto) {
    proofSignals.push({
      kind: 'completion_photo',
      label: 'Abschlussfoto vorhanden',
      icon: '✅',
    })
  }

  if (hasFeedback && feedbackIsPositive) {
    proofSignals.push({
      kind: 'feedback_positive',
      label: 'Kunde würde wieder buchen',
      icon: '👍',
    })
  } else if (hasFeedback) {
    proofSignals.push({
      kind: 'feedback_given',
      label: 'Kundenfeedback vorhanden',
      icon: '💬',
    })
  }

  return {
    ...summary,
    photoCount: photoArtifacts.length,
    hasCompletionPhoto,
    hasFeedback,
    feedbackIsPositive,
    feedbackNote,
    proofSignals,
  }
}
