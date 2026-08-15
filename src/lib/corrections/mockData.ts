import type { CorrectionRequest } from './types'

export const mockCorrectionRequests: CorrectionRequest[] = [
  {
    id: 'cr-1',
    providerId: 'prov-1',
    workerTeamMemberId: 'tm-1',
    workerProfileId: 'demo-worker-profile',
    kind: 'wrong_time',
    description: 'Meine Startzeit war 7:30 Uhr, nicht 8:00 Uhr wie eingetragen.',
    status: 'open',
    requestedDate: '2026-04-07',
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 86_400_000,
  },
  {
    id: 'cr-2',
    providerId: 'prov-1',
    workerTeamMemberId: 'tm-1',
    workerProfileId: 'demo-worker-profile',
    kind: 'missing_time',
    description: 'Überstunden vom 05.04. wurden nicht erfasst. Endzeit war 18:00 Uhr.',
    status: 'in_review',
    ownerNote: 'Wird geprüft.',
    requestedDate: '2026-04-05',
    createdAt: Date.now() - 172_800_000,
    updatedAt: Date.now() - 86_400_000,
  },
]
