import { describe, it, expect } from 'vitest'
import { getActionablePaymentState } from '../../src/lib/jobs/helpers'

describe('payment visibility gating', () => {
  it('suppresses payment state before a valid acceptance', () => {
    const state = getActionablePaymentState(
      { status: 'new', paymentState: 'deposit_required', proposalSentAt: undefined, proposalAcceptedAt: undefined }
    )
    expect(state).toBeUndefined()
  })

  it('allows payment state once both sent and accepted are present', () => {
    const state = getActionablePaymentState(
      {
        status: 'new',
        paymentState: 'deposit_required',
        proposalSentAt: Date.now(),
        proposalAcceptedAt: Date.now(),
      }
    )
    expect(state).toBe('deposit_required')
  })
})
