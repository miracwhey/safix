import type { DisputeEvidence, EvidenceType } from './types'

export function createEvidence(params: {
  disputeId: string
  jobId: string
  type: EvidenceType
  description: string
  submittedBy: string
  url?: string
}): DisputeEvidence {
  return {
    id: crypto.randomUUID(),
    disputeId: params.disputeId,
    jobId: params.jobId,
    type: params.type,
    description: params.description,
    submittedBy: params.submittedBy,
    url: params.url,
    submittedAt: new Date().toISOString(),
  }
}
