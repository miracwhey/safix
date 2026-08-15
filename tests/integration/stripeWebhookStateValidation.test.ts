/**
 * Stripe webhook state-machine safety tests.
 *
 * Tests the pure state-machine helpers extracted from the webhook handler to
 * ensure that invalid payment state transitions are rejected and valid
 * transitions are permitted regardless of how many times a Stripe event is
 * delivered.
 *
 * Block 5: Tests now validate the unified provider recovery transition model
 * (api/_providerRecoveryTransitions.ts) which is used consistently by webhook,
 * cron reconciliation, and client-side reconciliation paths.
 */

import { describe, it, expect } from 'vitest'
import {
  isValidWebhookTransition,
  STATES_ALLOWING_RELEASE,
  STATES_ALLOWING_REFUND,
} from '../../api/_webhookHelpers'

// ---------------------------------------------------------------------------
// isValidWebhookTransition — released
// ---------------------------------------------------------------------------

describe('isValidWebhookTransition → released', () => {
  it.each(['deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending'])(
    'allows %s → released',
    (state) => {
      expect(isValidWebhookTransition(state, 'released')).toBe(true)
    },
  )

  it.each(['none', 'deposit_required', 'disputed', 'released', 'refunded'])(
    'rejects %s → released',
    (state) => {
      expect(isValidWebhookTransition(state, 'released')).toBe(false)
    },
  )

  it('rejects terminal released → released (terminal state must not cycle)', () => {
    expect(isValidWebhookTransition('released', 'released')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isValidWebhookTransition — refunded
// ---------------------------------------------------------------------------

describe('isValidWebhookTransition → refunded', () => {
  it.each([
    'deposit_paid',
    'in_escrow',
    'work_in_progress',
    'release_pending',
  ])('allows %s → refunded', (state) => {
    expect(isValidWebhookTransition(state, 'refunded')).toBe(true)
  })

  it('rejects deposit_required → refunded (no funds held — misleading terminal)', () => {
    expect(isValidWebhookTransition('deposit_required', 'refunded')).toBe(false)
  })

  it('rejects disputed → refunded (dispute resolution is the only exit)', () => {
    // C2: a refund landing while a dispute is open must not auto-exit the
    // dispute — only the dispute-resolution workflow (stateMachine.ts) may
    // move disputed → refunded.
    expect(isValidWebhookTransition('disputed', 'refunded')).toBe(false)
  })

  it('rejects released → refunded (terminal state must not regress)', () => {
    expect(isValidWebhookTransition('released', 'refunded')).toBe(false)
  })

  it('rejects refunded → refunded (terminal state must not cycle)', () => {
    expect(isValidWebhookTransition('refunded', 'refunded')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Set membership — verify exported constants match validation function
// ---------------------------------------------------------------------------

describe('STATES_ALLOWING_RELEASE consistency', () => {
  it('contains exactly the states that isValidWebhookTransition allows for released', () => {
    const states = [
      'none',
      'deposit_required',
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
      'disputed',
      'released',
      'refunded',
    ]
    for (const state of states) {
      expect(STATES_ALLOWING_RELEASE.has(state)).toBe(
        isValidWebhookTransition(state, 'released'),
      )
    }
  })
})

describe('STATES_ALLOWING_REFUND consistency', () => {
  it('contains exactly the states that isValidWebhookTransition allows for refunded', () => {
    const states = [
      'none',
      'deposit_required',
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
      'disputed',
      'released',
      'refunded',
    ]
    for (const state of states) {
      expect(STATES_ALLOWING_REFUND.has(state)).toBe(
        isValidWebhookTransition(state, 'refunded'),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Idempotency guard (duplicate-delivery simulation)
// ---------------------------------------------------------------------------

describe('idempotency: repeated transitions are safe', () => {
  it('is safe to call isValidWebhookTransition multiple times with the same args', () => {
    // Simulates Stripe delivering the same event twice.
    // First delivery: in_escrow → released is valid.
    expect(isValidWebhookTransition('in_escrow', 'released')).toBe(true)

    // Second delivery: after first reconciliation, payment is now 'released'.
    // released → released must be rejected (handled as idempotent skip upstream,
    // but must not pass the state-machine validation either).
    expect(isValidWebhookTransition('released', 'released')).toBe(false)
  })

  it('out-of-order: refund event after release must be rejected', () => {
    // payment_intent.succeeded fires first → payment transitions to 'released'.
    // Stripe then (incorrectly or out-of-order) delivers charge.refunded.
    // released → refunded must be rejected.
    expect(isValidWebhookTransition('released', 'refunded')).toBe(false)
  })
})
