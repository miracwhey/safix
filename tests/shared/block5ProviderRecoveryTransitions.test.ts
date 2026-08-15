/**
 * Block 5: Provider Recovery Transitions — Unified truth model tests.
 *
 * Proves that the single source of truth (api/_providerRecoveryTransitions.ts)
 * is consistent across all three reconciliation paths:
 *   - Webhook (api/_webhookHelpers.ts → isValidWebhookTransition)
 *   - Client-side (deriveReconciliationStatus.ts → canRecoverTo)
 *   - Server-side cron (uses derivePaymentReconciliationStatus from same module)
 *
 * Tests are grouped by Block 5 closure criteria.
 */

import { describe, it, expect } from 'vitest'
import {
  PROVIDER_RECOVERY_TO_RELEASED,
  PROVIDER_RECOVERY_TO_REFUNDED,
  isValidProviderRecoveryTransition,
} from '../../api/_providerRecoveryTransitions'
import {
  isValidWebhookTransition,
  STATES_ALLOWING_RELEASE,
  STATES_ALLOWING_REFUND,
} from '../../api/_webhookHelpers'
import { derivePaymentReconciliationStatus } from '../../src/lib/payments/reconciliation/deriveReconciliationStatus'
import type { PaymentState } from '../../src/lib/shared/coreTypes'

// ---------------------------------------------------------------------------
// 1. Canonical recovery sets
// ---------------------------------------------------------------------------

describe('Provider recovery transition sets', () => {
  it('PROVIDER_RECOVERY_TO_RELEASED includes all expected non-terminal states', () => {
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('deposit_paid')).toBe(true)
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('in_escrow')).toBe(true)
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('work_in_progress')).toBe(true)
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('release_pending')).toBe(true)
  })

  it('PROVIDER_RECOVERY_TO_RELEASED excludes terminal, unfunded, and disputed states', () => {
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('none')).toBe(false)
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('deposit_required')).toBe(false)
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('released')).toBe(false)
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('refunded')).toBe(false)
    // C2: disputed may only be exited via the dispute-resolution workflow,
    // never by provider-authoritative auto-recovery.
    expect(PROVIDER_RECOVERY_TO_RELEASED.has('disputed')).toBe(false)
  })

  it('PROVIDER_RECOVERY_TO_REFUNDED excludes deposit_required (no funds held) and disputed (dispute-resolution only)', () => {
    expect(PROVIDER_RECOVERY_TO_REFUNDED.has('deposit_required')).toBe(false)
    // C2: disputed may only be exited via the dispute-resolution workflow,
    // never by provider-authoritative auto-recovery.
    expect(PROVIDER_RECOVERY_TO_REFUNDED.has('disputed')).toBe(false)
  })

  it('PROVIDER_RECOVERY_TO_REFUNDED includes all funded non-terminal states', () => {
    expect(PROVIDER_RECOVERY_TO_REFUNDED.has('deposit_paid')).toBe(true)
    expect(PROVIDER_RECOVERY_TO_REFUNDED.has('in_escrow')).toBe(true)
    expect(PROVIDER_RECOVERY_TO_REFUNDED.has('work_in_progress')).toBe(true)
    expect(PROVIDER_RECOVERY_TO_REFUNDED.has('release_pending')).toBe(true)
  })

  it('isValidProviderRecoveryTransition returns false for unknown target', () => {
    expect(isValidProviderRecoveryTransition('in_escrow', 'unknown' as 'released')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Webhook helpers delegate to unified model
// ---------------------------------------------------------------------------

describe('Webhook helpers use unified recovery transitions', () => {
  it('STATES_ALLOWING_RELEASE is the same object as PROVIDER_RECOVERY_TO_RELEASED', () => {
    expect(STATES_ALLOWING_RELEASE).toBe(PROVIDER_RECOVERY_TO_RELEASED)
  })

  it('STATES_ALLOWING_REFUND is the same object as PROVIDER_RECOVERY_TO_REFUNDED', () => {
    expect(STATES_ALLOWING_REFUND).toBe(PROVIDER_RECOVERY_TO_REFUNDED)
  })

  it('isValidWebhookTransition agrees with isValidProviderRecoveryTransition for all states', () => {
    const allStates = [
      'none', 'deposit_required', 'deposit_paid', 'in_escrow',
      'work_in_progress', 'release_pending', 'disputed', 'released', 'refunded',
    ]
    for (const state of allStates) {
      expect(isValidWebhookTransition(state, 'released')).toBe(
        isValidProviderRecoveryTransition(state, 'released'),
      )
      expect(isValidWebhookTransition(state, 'refunded')).toBe(
        isValidProviderRecoveryTransition(state, 'refunded'),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Terminal states are never recoverable
// ---------------------------------------------------------------------------

describe('Terminal states are immutable under recovery', () => {
  it.each(['released', 'refunded'])('%s → released is rejected', (state) => {
    expect(isValidProviderRecoveryTransition(state, 'released')).toBe(false)
  })

  it.each(['released', 'refunded'])('%s → refunded is rejected', (state) => {
    expect(isValidProviderRecoveryTransition(state, 'refunded')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Provider-ahead-of-DB recovery paths
// ---------------------------------------------------------------------------

describe('Provider truth ahead of DB truth — recovery is safe', () => {
  it('deposit_paid → released (Stripe captured, SaFix missed intermediate states)', () => {
    expect(isValidProviderRecoveryTransition('deposit_paid', 'released')).toBe(true)
  })

  it('in_escrow → released (Stripe captured, SaFix missed release_pending)', () => {
    expect(isValidProviderRecoveryTransition('in_escrow', 'released')).toBe(true)
  })

  it('work_in_progress → released (Stripe captured via dashboard or delayed webhook)', () => {
    expect(isValidProviderRecoveryTransition('work_in_progress', 'released')).toBe(true)
  })

  it('work_in_progress → refunded (Stripe canceled/refunded while work in progress)', () => {
    expect(isValidProviderRecoveryTransition('work_in_progress', 'refunded')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. deposit_required → refunded is explicitly blocked
// ---------------------------------------------------------------------------

describe('Unfunded payment cannot be "refunded"', () => {
  it('deposit_required → refunded is blocked (no funds were ever held)', () => {
    expect(isValidProviderRecoveryTransition('deposit_required', 'refunded')).toBe(false)
  })

  it('deposit_required → released is blocked (no funds to capture)', () => {
    expect(isValidProviderRecoveryTransition('deposit_required', 'released')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5b. disputed is never a provider-recovery source (C2)
// ---------------------------------------------------------------------------

describe('Disputed payment cannot be exited by provider-authoritative recovery', () => {
  it('disputed → released is blocked (Stripe capture must not override a running dispute)', () => {
    expect(isValidProviderRecoveryTransition('disputed', 'released')).toBe(false)
  })

  it('disputed → refunded is blocked (dispute resolution is the only exit)', () => {
    expect(isValidProviderRecoveryTransition('disputed', 'refunded')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Client-side inlined sets agree with canonical sets
// ---------------------------------------------------------------------------

describe('Client-side deriveReconciliationStatus inlined sets agree with canonical source', () => {
  // deriveReconciliationStatus.ts inlines PROVIDER_RECOVERY_TO_RELEASED/REFUNDED
  // because src/ cannot import from api/.  This test proves both copies agree
  // by comparing actual reconciliation behavior with the canonical transition sets.
  //
  // If someone edits _providerRecoveryTransitions.ts without updating the inline
  // copy, this test will fail — catching the divergence before merge.

  const allStates = [
    'none', 'deposit_required', 'deposit_paid', 'in_escrow',
    'work_in_progress', 'release_pending', 'disputed', 'released', 'refunded',
  ]

  it.each(allStates)(
    'for state %s: deriveReconciliationStatus(succeeded) agrees with canonical released transition',
    (state) => {
      // The canonical says this state can/cannot recover to released
      const canonicalAllows = isValidProviderRecoveryTransition(state, 'released')

      // Create a minimal payment in this state
      const payment = {
        id: `payment_sync_test_${state}`,
        jobId: `job_sync_test_${state}`,
        state: state as PaymentState,
        amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Terminal states have their own handling, skip those
      if (state === 'released' || state === 'refunded') return

      const result = derivePaymentReconciliationStatus(payment, {
        paymentIntentId: 'pi_test',
        stripeStatus: 'succeeded',
        amountCapturable: 0,
        amountReceived: 1000,
        currency: 'eur',
      })

      if (canonicalAllows) {
        expect(result.status).toBe('recoverable')
        expect(result.recommendedState).toBe('released')
      } else {
        // Should not be recoverable to released
        expect(result.status).not.toBe('recoverable')
      }
    },
  )

  it.each(allStates)(
    'for state %s: deriveReconciliationStatus(canceled) agrees with canonical refunded transition',
    (state) => {
      const canonicalAllows = isValidProviderRecoveryTransition(state, 'refunded')

      const payment = {
        id: `payment_sync_test_ref_${state}`,
        jobId: `job_sync_test_ref_${state}`,
        state: state as PaymentState,
        amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      if (state === 'released' || state === 'refunded') return

      const result = derivePaymentReconciliationStatus(payment, {
        paymentIntentId: 'pi_test',
        stripeStatus: 'canceled',
        amountCapturable: 0,
        amountReceived: 0,
        currency: 'eur',
      })

      if (canonicalAllows) {
        expect(result.status).toBe('recoverable')
        expect(result.recommendedState).toBe('refunded')
      } else {
        expect(result.status).not.toBe('recoverable')
      }
    },
  )
})
