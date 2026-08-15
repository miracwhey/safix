/**
 * Block 3 — monotonic payout outcome merge.
 *
 * Ensures a UI surface that consumes realtime timeline signals does not
 * flicker back from "completed" / "failed" to "transfer_triggered" when
 * a transient empty snapshot arrives (e.g. during a repo reconnect).
 */

import { describe, it, expect } from 'vitest'
import { mergeMonotonicPayoutOutcomes } from '../../src/lib/payments/payoutOutcomeSelectors'

describe('mergeMonotonicPayoutOutcomes', () => {
  it('retains a previous completed outcome when the current snapshot is empty', () => {
    const previous = new Map<string, 'completed' | 'failed'>([['tr_a', 'completed']])
    const current = new Map<string, 'completed' | 'failed'>()
    const merged = mergeMonotonicPayoutOutcomes(previous, current)
    expect(merged.get('tr_a')).toBe('completed')
  })

  it('retains previous failed when the current snapshot drops the signal', () => {
    const previous = new Map<string, 'completed' | 'failed'>([['tr_b', 'failed']])
    const current = new Map<string, 'completed' | 'failed'>()
    const merged = mergeMonotonicPayoutOutcomes(previous, current)
    expect(merged.get('tr_b')).toBe('failed')
  })

  it('lets the current snapshot override the previous one (retry recovered)', () => {
    const previous = new Map<string, 'completed' | 'failed'>([['tr_c', 'failed']])
    const current = new Map<string, 'completed' | 'failed'>([['tr_c', 'completed']])
    const merged = mergeMonotonicPayoutOutcomes(previous, current)
    expect(merged.get('tr_c')).toBe('completed')
  })

  it('handles a null previous gracefully', () => {
    const current = new Map<string, 'completed' | 'failed'>([['tr_d', 'completed']])
    const merged = mergeMonotonicPayoutOutcomes(null, current)
    expect(merged.get('tr_d')).toBe('completed')
    expect(merged.size).toBe(1)
  })

  it('merges disjoint tranche outcomes', () => {
    const previous = new Map<string, 'completed' | 'failed'>([['tr_25', 'completed']])
    const current = new Map<string, 'completed' | 'failed'>([['tr_75', 'failed']])
    const merged = mergeMonotonicPayoutOutcomes(previous, current)
    expect(merged.get('tr_25')).toBe('completed')
    expect(merged.get('tr_75')).toBe('failed')
    expect(merged.size).toBe(2)
  })
})
