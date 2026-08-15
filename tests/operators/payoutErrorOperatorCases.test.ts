import { describe, it, expect } from 'vitest'
import { deriveOperatorCases } from '../../src/lib/operators/operatorCaseSelectors'
import type { ProjectTimelineSignal } from '../../src/lib/timeline/types'

const NOW = 1_700_000_000_000
const HOUR_MS = 1000 * 60 * 60

function makeSignal(overrides: Partial<ProjectTimelineSignal> = {}): ProjectTimelineSignal {
  return {
    id: 'timeline_payout_failed__tr_001',
    jobId: 'job-payout-1',
    type: 'payout_failed',
    occurredAt: NOW - 2 * HOUR_MS,
    ...overrides,
  }
}

describe('deriveOperatorCases – payout_error', () => {
  it('emits payout_error case for payout_failed signal', () => {
    const signal = makeSignal({ type: 'payout_failed' })
    const cases = deriveOperatorCases([], [], [], [], NOW, [signal])
    const c = cases.find((x) => x.type === 'payout_error')
    expect(c).toBeDefined()
    expect(c!.jobId).toBe('job-payout-1')
    expect(c!.severity).toBe('critical')
    expect(c!.ageHours).toBe(2)
  })

  it('emits payout_error case for transfer_reversed signal', () => {
    const signal = makeSignal({
      id: 'timeline_transfer_reversed__txnr_001',
      type: 'transfer_reversed',
      jobId: 'job-reversal-1',
      occurredAt: NOW - 5 * HOUR_MS,
    })
    const cases = deriveOperatorCases([], [], [], [], NOW, [signal])
    const c = cases.find((x) => x.type === 'payout_error')
    expect(c).toBeDefined()
    expect(c!.jobId).toBe('job-reversal-1')
    expect(c!.severity).toBe('critical')
    expect(c!.ageHours).toBe(5)
    expect(c!.description).toContain('Transfer storniert')
  })

  it('deduplicates multiple error signals for the same job — one case only', () => {
    const signals: ProjectTimelineSignal[] = [
      makeSignal({ id: 'sig-1', type: 'payout_failed', jobId: 'job-dup', occurredAt: NOW - 3 * HOUR_MS }),
      makeSignal({ id: 'sig-2', type: 'transfer_reversed', jobId: 'job-dup', occurredAt: NOW - 1 * HOUR_MS }),
    ]
    const cases = deriveOperatorCases([], [], [], [], NOW, [signals[0], signals[1]])
    const payoutErrors = cases.filter((x) => x.type === 'payout_error' && x.jobId === 'job-dup')
    expect(payoutErrors).toHaveLength(1)
  })

  it('emits separate cases for different jobs', () => {
    const signals: ProjectTimelineSignal[] = [
      makeSignal({ id: 'sig-a', type: 'payout_failed', jobId: 'job-a', occurredAt: NOW - 1 * HOUR_MS }),
      makeSignal({ id: 'sig-b', type: 'transfer_reversed', jobId: 'job-b', occurredAt: NOW - 2 * HOUR_MS }),
    ]
    const cases = deriveOperatorCases([], [], [], [], NOW, signals)
    const payoutErrors = cases.filter((x) => x.type === 'payout_error')
    expect(payoutErrors).toHaveLength(2)
    expect(payoutErrors.map((c) => c.jobId).sort()).toEqual(['job-a', 'job-b'])
  })

  it('ignores unrelated signal types', () => {
    const signal = makeSignal({ type: 'payout_completed' as ProjectTimelineSignal['type'] })
    const cases = deriveOperatorCases([], [], [], [], NOW, [signal])
    expect(cases.find((x) => x.type === 'payout_error')).toBeUndefined()
  })

  it('defaults to empty signals — backward-compatible with existing callers', () => {
    const cases = deriveOperatorCases([], [], [], [], NOW)
    expect(cases.filter((x) => x.type === 'payout_error')).toHaveLength(0)
  })

  it('payout_error sorts before high-severity cases', () => {
    const signal = makeSignal({ type: 'payout_failed' })
    const highPayment = {
      id: 'pay-1', jobId: 'job-high', state: 'release_pending' as const,
      amounts: { totalAmount: 500, depositAmount: 100, finalAmount: 400 },
      createdAt: NOW - 30 * HOUR_MS, updatedAt: NOW - 30 * HOUR_MS,
    }
    const cases = deriveOperatorCases([], [highPayment], [], [], NOW, [signal])
    const firstCase = cases[0]
    expect(firstCase.type).toBe('payout_error')
    expect(firstCase.severity).toBe('critical')
  })
})
