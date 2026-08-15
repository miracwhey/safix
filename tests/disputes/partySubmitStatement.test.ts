/**
 * H24 — InMemoryDisputeRepository.partySubmitStatement.
 *
 * Parity contract with the Supabase implementation (SECURITY DEFINER RPC
 * `party_submit_dispute_statement`): appends the description-evidence AND
 * flips *_waiting → under_review atomically; rejects every other status
 * (submit flips the status — no second submit).
 */

import { describe, expect, it } from 'vitest'

import { InMemoryDisputeRepository } from '../../src/lib/disputes/repository/InMemoryDisputeRepository'
import type { Dispute, DisputeEvidence } from '../../src/lib/disputes/types'

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-h24',
    jobId: 'job-h24',
    status: 'customer_waiting',
    reason: 'work_quality',
    title: 'Mängel',
    description: 'Beschreibung',
    createdAt: '2026-06-09T10:00:00.000Z',
    updatedAt: '2026-06-09T10:00:00.000Z',
    evidence: [
      {
        id: 'ev-existing',
        disputeId: 'dispute-h24',
        jobId: 'job-h24',
        type: 'description',
        description: 'Erste Schilderung.',
        submittedBy: 'cust-1',
        submittedAt: '2026-06-09T10:00:00.000Z',
      } as DisputeEvidence,
    ],
    ...overrides,
  } as Dispute
}

function makeEvidence(): DisputeEvidence {
  return {
    id: 'ev-h24-new',
    disputeId: 'dispute-h24',
    jobId: 'job-h24',
    type: 'description',
    description: 'Stellungnahme.',
    submittedBy: 'cust-1',
    submittedAt: '2026-06-10T09:00:00.000Z',
  } as DisputeEvidence
}

describe('InMemoryDisputeRepository.partySubmitStatement (H24)', () => {
  it('appends evidence (keeps existing) and flips customer_waiting → under_review', async () => {
    const repo = new InMemoryDisputeRepository([makeDispute()])
    let notified = 0
    repo.subscribe(() => {
      notified += 1
    })

    const result = await repo.partySubmitStatement('dispute-h24', makeEvidence())

    expect(result.status).toBe('under_review')
    expect(result.evidence?.map((e) => e.id)).toEqual(['ev-existing', 'ev-h24-new'])
    expect(Date.parse(result.updatedAt)).toBeGreaterThan(Date.parse('2026-06-09T10:00:00.000Z'))
    // Returned value reflects the persisted state.
    expect(repo.getById('dispute-h24')).toEqual(result)
    expect(notified).toBe(1)
  })

  it('flips provider_waiting → under_review the same way', async () => {
    const repo = new InMemoryDisputeRepository([makeDispute({ status: 'provider_waiting' })])

    const result = await repo.partySubmitStatement('dispute-h24', makeEvidence())

    expect(result.status).toBe('under_review')
    expect(result.evidence?.length).toBe(2)
  })

  it('throws dispute_not_found for an unknown dispute id', async () => {
    const repo = new InMemoryDisputeRepository([])

    await expect(repo.partySubmitStatement('nope', makeEvidence())).rejects.toThrow(
      /dispute_not_found/,
    )
  })

  it.each(['open', 'under_review', 'resolved', 'closed', 'cancelled'] as const)(
    'rejects status %s with dispute_not_awaiting_response and leaves the dispute untouched',
    async (status) => {
      const seeded = makeDispute({ status })
      const repo = new InMemoryDisputeRepository([seeded])

      await expect(repo.partySubmitStatement('dispute-h24', makeEvidence())).rejects.toThrow(
        /dispute_not_awaiting_response/,
      )

      const after = repo.getById('dispute-h24')
      expect(after?.status).toBe(status)
      expect(after?.evidence?.length).toBe(1)
      expect(after?.updatedAt).toBe(seeded.updatedAt)
    },
  )
})
