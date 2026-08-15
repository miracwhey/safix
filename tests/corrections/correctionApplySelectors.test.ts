import { describe, it, expect } from 'vitest'

import { deriveCorrectionApplySummary } from '../../src/lib/corrections/correctionApplySelectors'
import type { CorrectionRequest } from '../../src/lib/corrections'

function makeRequest(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'cr-1',
    providerId: 'p1',
    workerTeamMemberId: 'tm-w',
    workerProfileId: 'u-w',
    kind: 'wrong_time',
    description: 'desc',
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('deriveCorrectionApplySummary', () => {
  it('returns null for non-resolved requests (open/in_review/rejected)', () => {
    expect(deriveCorrectionApplySummary(makeRequest({ status: 'open' }))).toBeNull()
    expect(deriveCorrectionApplySummary(makeRequest({ status: 'in_review' }))).toBeNull()
    expect(
      deriveCorrectionApplySummary(makeRequest({ status: 'rejected', ownerNote: 'nope' })),
    ).toBeNull()
  })

  it('returns applied when appliedAt is set on a resolved request', () => {
    const summary = deriveCorrectionApplySummary(
      makeRequest({ status: 'resolved', appliedAt: 1700000000000, appliedTargetEntryId: 'cal-1' }),
    )
    expect(summary).toEqual({ kind: 'applied' })
  })

  it('returns manual_needed for invalid_time_format', () => {
    const summary = deriveCorrectionApplySummary(
      makeRequest({ status: 'resolved', applySkipReason: 'invalid_time_format' }),
    )
    expect(summary).toEqual({ kind: 'manual_needed' })
  })

  it('returns manual_needed for missing_calendar_entry', () => {
    const summary = deriveCorrectionApplySummary(
      makeRequest({ status: 'resolved', applySkipReason: 'missing_calendar_entry' }),
    )
    expect(summary).toEqual({ kind: 'manual_needed' })
  })

  it('returns error for repository_error', () => {
    const summary = deriveCorrectionApplySummary(
      makeRequest({ status: 'resolved', applySkipReason: 'repository_error' }),
    )
    expect(summary).toEqual({ kind: 'error' })
  })

  it('returns null for kind_not_supported (status pill carries the message already)', () => {
    const summary = deriveCorrectionApplySummary(
      makeRequest({ kind: 'other', status: 'resolved', applySkipReason: 'kind_not_supported' }),
    )
    expect(summary).toBeNull()
  })

  it('returns null for resolved without any apply trace (legacy rows pre-7.2.7b)', () => {
    const summary = deriveCorrectionApplySummary(makeRequest({ status: 'resolved' }))
    expect(summary).toBeNull()
  })
})
