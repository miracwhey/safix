import { describe, it, expect } from 'vitest'
import { resolveActionEntitlement } from '../../src/lib/subscription/entitlements'
import type { EffectiveSubscriptionStatus, ActiveWorkContext } from '../../src/lib/subscription/types'

const WITH_ESCROW: ActiveWorkContext = {
  hasActiveEscrow: true,
  jobId: 'job-1',
  boundThreadId: 'thread-1',
}

const WITHOUT_ESCROW: ActiveWorkContext = {
  hasActiveEscrow: false,
  jobId: 'job-1',
  boundThreadId: 'thread-1',
}

const FULL_ACCESS: EffectiveSubscriptionStatus[] = ['trial_active', 'active', 'grace', 'canceled']

describe('resolveActionEntitlement', () => {
  describe('full access states', () => {
    for (const state of FULL_ACCESS) {
      it(`${state} → full for any action`, () => {
        const result = resolveActionEntitlement('create_highlight_extra', state)
        expect(result.level).toBe('full')
      })
    }
  })

  describe('free earning-loop actions (Apple 3.1.1)', () => {
    it('full for request_funding regardless of state', () => {
      const result = resolveActionEntitlement('request_funding', 'expired', WITH_ESCROW)
      expect(result.level).toBe('full')
    })

    it('full for open_quote_composer regardless of state', () => {
      const result = resolveActionEntitlement('open_quote_composer', 'expired', WITH_ESCROW)
      expect(result.level).toBe('full')
    })

    it('full for release_tranche even when expired', () => {
      const result = resolveActionEntitlement('release_tranche', 'expired', WITH_ESCROW)
      expect(result.level).toBe('full')
    })

    it('full for release_tranche without active escrow (payment-guard condition)', () => {
      const result = resolveActionEntitlement('release_tranche', 'expired', WITHOUT_ESCROW)
      expect(result.level).toBe('full')
    })

    it('full for release_tranche without jobContext', () => {
      const result = resolveActionEntitlement('release_tranche', 'expired')
      expect(result.level).toBe('full')
    })

    it('full for create_change_order', () => {
      expect(resolveActionEntitlement('create_change_order', 'expired', WITH_ESCROW).level).toBe('full')
    })

    it('full for setup_stripe_connect', () => {
      expect(resolveActionEntitlement('setup_stripe_connect', 'expired', WITH_ESCROW).level).toBe('full')
    })

    it('full for issue_invoice', () => {
      expect(resolveActionEntitlement('issue_invoice', 'expired', WITH_ESCROW).level).toBe('full')
    })

    it('full for start_job', () => {
      expect(resolveActionEntitlement('start_job', 'expired', WITHOUT_ESCROW).level).toBe('full')
    })

    it('full for complete_job', () => {
      expect(resolveActionEntitlement('complete_job', 'expired', WITHOUT_ESCROW).level).toBe('full')
    })

    it('full for send_message', () => {
      expect(resolveActionEntitlement('send_message', 'expired', WITHOUT_ESCROW).level).toBe('full')
    })

    it('full for open_invoice_creator', () => {
      expect(resolveActionEntitlement('open_invoice_creator', 'expired', WITHOUT_ESCROW).level).toBe('full')
    })
  })

  describe('trial_available', () => {
    it('→ trial_start for a gated action', () => {
      const result = resolveActionEntitlement('create_highlight_extra', 'trial_available')
      expect(result.level).toBe('trial_start')
    })
  })

  describe('still-gated actions (create_highlight_extra)', () => {
    it('blocked when expired without escrow', () => {
      expect(resolveActionEntitlement('create_highlight_extra', 'expired').level).toBe('blocked')
    })

    it('blocked when expired even with active escrow (not in AWE)', () => {
      expect(resolveActionEntitlement('create_highlight_extra', 'expired', WITH_ESCROW).level).toBe('blocked')
    })

    it('trial_start when trial_available', () => {
      expect(resolveActionEntitlement('create_highlight_extra', 'trial_available').level).toBe('trial_start')
    })
  })
})
