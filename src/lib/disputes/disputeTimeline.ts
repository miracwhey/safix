import { ensureTimelineEvent, addTimelineEvent, createTimelineEvent } from '../timeline'

export function emitDisputeOpenedEvent(jobId: string): void {
  ensureTimelineEvent({ jobId, type: 'dispute_opened' })
}

export function emitDisputeEvidenceAttachedEvent(jobId: string): void {
  ensureTimelineEvent({ jobId, type: 'dispute_evidence_attached' })
}

export function emitDisputeUnderReviewEvent(jobId: string): void {
  ensureTimelineEvent({ jobId, type: 'dispute_under_review' })
}

export function emitDisputeEvidenceRequestedEvent(jobId: string): void {
  ensureTimelineEvent({ jobId, type: 'dispute_evidence_requested' })
}

/** Generic fallback – emits the shared 'dispute_resolved' signal */
export function emitDisputeResolvedEvent(jobId: string): void {
  ensureTimelineEvent({ jobId, type: 'dispute_resolved' })
}

/** Emits a specific resolution event that carries the decision outcome */
export function emitDisputeResolvedWithDecision(
  jobId: string,
  decision: 'release' | 'refund' | 'split' | 'reject'
): void {
  if (decision === 'release') {
    addTimelineEvent(createTimelineEvent({ jobId, type: 'dispute_resolved_release' }))
  } else if (decision === 'refund') {
    addTimelineEvent(createTimelineEvent({ jobId, type: 'dispute_resolved_refund' }))
  } else if (decision === 'split') {
    addTimelineEvent(createTimelineEvent({ jobId, type: 'dispute_resolved_split' }))
  } else {
    addTimelineEvent(createTimelineEvent({ jobId, type: 'dispute_rejected' }))
  }
}
