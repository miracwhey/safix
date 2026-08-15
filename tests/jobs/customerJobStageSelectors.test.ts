import { describe, it, expect } from 'vitest'
import {
  deriveCustomerJobStage,
  CUSTOMER_STAGE_ORDER,
  CUSTOMER_STAGE_LABELS,
} from '../../src/lib/jobs/customerJobStageSelectors'
import type { JobStatus } from '../../src/lib/shared/coreTypes'
import type { PaymentState } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const HOUR_MS = 1000 * 60 * 60

// ---------------------------------------------------------------------------
// Stage: inquiry_sent
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – inquiry_sent', () => {
  it('returns inquiry_sent for a new job with no proposal and no payment', () => {
    const result = deriveCustomerJobStage('new', undefined)
    expect(result.stage).toBe('inquiry_sent')
    expect(result.activeIndex).toBe(0)
  })

  it('returns inquiry_sent when proposalSentAt and proposalAcceptedAt are both absent', () => {
    const result = deriveCustomerJobStage('new', 'deposit_required', undefined, undefined)
    expect(result.stage).toBe('inquiry_sent')
  })
})

// ---------------------------------------------------------------------------
// Stage: offer_received
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – offer_received', () => {
  it('returns offer_received when proposalSentAt is set but not accepted', () => {
    const result = deriveCustomerJobStage('new', 'deposit_required', NOW - 24 * HOUR_MS, undefined)
    expect(result.stage).toBe('offer_received')
    expect(result.activeIndex).toBe(1)
  })

  it('requires proposalAcceptedAt to be absent to stay at offer_received', () => {
    // proposalAcceptedAt present → moves to offer_accepted
    const result = deriveCustomerJobStage('new', 'deposit_required', NOW - 24 * HOUR_MS, NOW - 1 * HOUR_MS)
    expect(result.stage).not.toBe('offer_received')
  })
})

// ---------------------------------------------------------------------------
// Stage: offer_accepted
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – offer_accepted', () => {
  it('returns offer_accepted when proposalAcceptedAt is set and job not yet in_progress', () => {
    const result = deriveCustomerJobStage('scheduled', 'deposit_required', NOW - 48 * HOUR_MS, NOW - 24 * HOUR_MS)
    expect(result.stage).toBe('offer_accepted')
    expect(result.activeIndex).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Stage: work_in_progress
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – work_in_progress', () => {
  it('returns work_in_progress when jobStatus is in_progress', () => {
    const result = deriveCustomerJobStage('in_progress', 'work_in_progress')
    expect(result.stage).toBe('work_in_progress')
    expect(result.activeIndex).toBe(5)  })

  it('returns work_in_progress when paymentState is work_in_progress', () => {
    const result = deriveCustomerJobStage('scheduled', 'work_in_progress')
    expect(result.stage).toBe('work_in_progress')
  })
})

// ---------------------------------------------------------------------------
// Stage: work_completed
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – work_completed', () => {
  it('returns work_completed when jobStatus is waiting_payment', () => {
    const result = deriveCustomerJobStage('waiting_payment', 'release_pending')
    expect(result.stage).toBe('work_completed')
    expect(result.activeIndex).toBe(6)
  })

  it('returns work_completed when paymentState is release_pending', () => {
    const result = deriveCustomerJobStage('in_progress', 'release_pending')
    expect(result.stage).toBe('work_completed')
  })
})

// ---------------------------------------------------------------------------
// Stage: payment_released
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – payment_released', () => {
  it('returns payment_released when jobStatus is completed', () => {
    const result = deriveCustomerJobStage('completed', 'released')
    expect(result.stage).toBe('payment_released')
    expect(result.activeIndex).toBe(8)
  })

  it('returns payment_released when paymentState is released', () => {
    const result = deriveCustomerJobStage('waiting_payment', 'released')
    expect(result.stage).toBe('payment_released')
  })

  it('returns payment_released when paymentState is refunded', () => {
    const result = deriveCustomerJobStage('waiting_payment', 'refunded')
    expect(result.stage).toBe('payment_released')
  })
})

// ---------------------------------------------------------------------------
// Priority ordering: higher-priority states override lower ones
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – priority ordering', () => {
  it('completed with non-terminal payment shows work_completed (not premature payment_released)', () => {
    // jobStatus = completed but paymentState is not terminal (release_pending)
    // Block 2.1: completed must not prematurely project as payment_released
    const result = deriveCustomerJobStage('completed', 'release_pending')
    expect(result.stage).toBe('work_completed')
  })

  it('completed with terminal payment shows payment_released', () => {
    // jobStatus = completed AND paymentState = released → genuinely terminal
    const result = deriveCustomerJobStage('completed', 'released')
    expect(result.stage).toBe('payment_released')
  })

  it('work_completed wins over work_in_progress signals', () => {
    const result = deriveCustomerJobStage('waiting_payment', 'work_in_progress')
    expect(result.stage).toBe('work_completed')
  })

  it('work_in_progress wins over offer_accepted signals', () => {
    const result = deriveCustomerJobStage(
      'in_progress',
      'work_in_progress',
      NOW - 48 * HOUR_MS,
      NOW - 24 * HOUR_MS
    )
    expect(result.stage).toBe('work_in_progress')
  })
})

// ---------------------------------------------------------------------------
// activeIndex correctness
// ---------------------------------------------------------------------------

describe('deriveCustomerJobStage – activeIndex', () => {
  it('activeIndex matches the position in CUSTOMER_STAGE_ORDER', () => {
    const stagesToCheck: Array<{ status: JobStatus; payment: PaymentState | undefined; expectedStage: string }> = [
      { status: 'new', payment: undefined, expectedStage: 'inquiry_sent' },
      { status: 'completed', payment: 'released', expectedStage: 'payment_released' },
      { status: 'waiting_payment', payment: 'release_pending', expectedStage: 'work_completed' },
      { status: 'in_progress', payment: 'work_in_progress', expectedStage: 'work_in_progress' },
    ]

    for (const { status, payment, expectedStage } of stagesToCheck) {
      const result = deriveCustomerJobStage(status, payment)
      expect(result.activeIndex).toBe(CUSTOMER_STAGE_ORDER.indexOf(result.stage as typeof CUSTOMER_STAGE_ORDER[number]))
      expect(result.stage).toBe(expectedStage)
    }
  })
})

// ---------------------------------------------------------------------------
// CUSTOMER_STAGE_ORDER completeness
// ---------------------------------------------------------------------------

describe('CUSTOMER_STAGE_ORDER', () => {
  it('contains exactly 9 stages in lifecycle order', () => {
    expect(CUSTOMER_STAGE_ORDER).toHaveLength(9)
    expect(CUSTOMER_STAGE_ORDER[0]).toBe('inquiry_sent')
    expect(CUSTOMER_STAGE_ORDER[7]).toBe('partially_released')
    expect(CUSTOMER_STAGE_ORDER[8]).toBe('payment_released')
  })
})

// ---------------------------------------------------------------------------
// CUSTOMER_STAGE_LABELS completeness
// ---------------------------------------------------------------------------

describe('CUSTOMER_STAGE_LABELS', () => {
  it('has a non-empty label for every stage in CUSTOMER_STAGE_ORDER', () => {
    for (const stage of CUSTOMER_STAGE_ORDER) {
      expect(CUSTOMER_STAGE_LABELS[stage]).toBeTruthy()
    }
  })
})
