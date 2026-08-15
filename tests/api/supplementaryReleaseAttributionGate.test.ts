/**
 * Supplementary Payout Release — Attribution Gate Enforcement
 *
 * Validates that `releaseSupplementaryPayout` (shared helper invoked by
 * stripe-webhook.ts auto-release AND /api/release-supplementary-payout
 * manual retry) blocks before any Stripe call when the job's commercial
 * attribution is not finalized.
 *
 * Contract: parity with initiate-supplementary-funding.  The same invariant
 * that gated funding MUST gate the payout.  Attribution can transition into
 * 'dlq' after funding succeeded (operator classification dispute), so the
 * re-verification is mandatory.
 */

const { mockTransfersCreate, mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockTransfersCreate: vi.fn(),
  mockPaymentIntentsRetrieve: vi.fn(),
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { releaseSupplementaryPayout } from '../../api/_releaseSupplementaryPayout'

// ── Stripe mock ──────────────────────────────────────────────────────────────

function makeStripe(): Stripe {
  return {
    transfers: { create: mockTransfersCreate },
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve },
  } as unknown as Stripe
}

// ── DB mock ──────────────────────────────────────────────────────────────────

const SPR_ID = 'spr-abc-123'
const JOB_ID = 'job-xyz-789'
const FUNDING_REF = 'pi_mock_funding'
const CRAFTSMAN_ID = 'craftsman-user-id'

const FUNDED_SPR = {
  id: SPR_ID,
  status: 'funded',
  job_id: JOB_ID,
  craftsman_user_id: CRAFTSMAN_ID,
  external_ref: FUNDING_REF,
  amount_cents: 10000,
  currency: 'eur',
  original_payment_id: 'pay-1',
  change_order_id: 'co-1',
  customer_user_id: 'customer-1',
}

const FINALIZED_JOB = {
  id: JOB_ID,
  commercial_origin: 'platform_acquired',
  attribution_status: 'finalized',
  attribution_dlq_reason: null,
}

function makeSupabase({
  spr = FUNDED_SPR,
  job = FINALIZED_JOB as Record<string, unknown> | null,
  jobError = null as unknown,
}: {
  spr?: Record<string, unknown> | null
  job?: Record<string, unknown> | null
  jobError?: unknown
} = {}): SupabaseClient {
  // SPR fetch: from('supplementary_payment_requests').select('*').eq('id',...).maybeSingle()
  const sprSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: spr ?? null, error: null }),
    }),
  })

  // Job fetch (attribution gate)
  const jobSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: job, error: jobError }),
    }),
  })

  // Payout account — not reached when gate blocks
  const payoutSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  })

  // Update (not reached when gate blocks)
  const sprUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: [{ id: SPR_ID }], error: null }),
      }),
    }),
  })

  return {
    from: vi.fn((table: string) => {
      if (table === 'supplementary_payment_requests') {
        return { select: sprSelect, update: sprUpdate }
      }
      if (table === 'jobs') return { select: jobSelect }
      if (table === 'provider_payout_accounts') return { select: payoutSelect }
      if (table === 'ledger_entries') {
        // Guard, not a blind pass-through: every gate in this file blocks before
        // the ledger writer, so this normally never runs — but if a gate-passing
        // path ever reaches it, fail unless the producer emits the prod movement
        // shape (entry_type from the enum, a movement_ref, no legacy note/type).
        return {
          upsert: vi.fn((rows: Record<string, unknown> | Record<string, unknown>[]) => {
            for (const row of Array.isArray(rows) ? rows : [rows]) {
              expect(['escrow_deposit', 'platform_fee', 'payout']).toContain(row.entry_type)
              expect(row).toHaveProperty('movement_ref')
              expect(row).not.toHaveProperty('note')
              expect(row).not.toHaveProperty('type')
            }
            return Promise.resolve({ error: null })
          }),
        }
      }
      return {}
    }),
  } as unknown as SupabaseClient
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('releaseSupplementaryPayout — attribution gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks with ATTRIBUTION_BLOCKED when attribution_status=pending — no Stripe call', async () => {
    const supabase = makeSupabase({
      job: {
        id: JOB_ID,
        commercial_origin: null,
        attribution_status: 'pending',
        attribution_dlq_reason: null,
      },
    })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.outcome).toBe('ATTRIBUTION_BLOCKED')
      if (result.outcome === 'ATTRIBUTION_BLOCKED') {
        expect(result.gate.code).toBe('ATTRIBUTION_UNRESOLVED')
      }
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
  })

  it('blocks with ATTRIBUTION_BLOCKED when attribution_status=retrying', async () => {
    const supabase = makeSupabase({
      job: {
        id: JOB_ID,
        commercial_origin: null,
        attribution_status: 'retrying',
        attribution_dlq_reason: null,
      },
    })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false && result.outcome === 'ATTRIBUTION_BLOCKED') {
      expect(result.gate.code).toBe('ATTRIBUTION_UNRESOLVED')
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('blocks with ATTRIBUTION_BLOCKED when attribution_status=dlq — carries dlqReason', async () => {
    const supabase = makeSupabase({
      job: {
        id: JOB_ID,
        commercial_origin: null,
        attribution_status: 'dlq',
        attribution_dlq_reason: 'OPERATOR_ACTION_REQUIRED',
      },
    })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false && result.outcome === 'ATTRIBUTION_BLOCKED' && result.gate.code === 'ATTRIBUTION_DLQ') {
      expect(result.gate.dlqReason).toBe('OPERATOR_ACTION_REQUIRED')
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('blocks with ATTRIBUTION_BLOCKED when finalized with invalid origin', async () => {
    const supabase = makeSupabase({
      job: {
        id: JOB_ID,
        commercial_origin: null, // finalized + null invariant violation
        attribution_status: 'finalized',
        attribution_dlq_reason: null,
      },
    })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false && result.outcome === 'ATTRIBUTION_BLOCKED') {
      expect(result.gate.code).toBe('ATTRIBUTION_INVALID')
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('blocks with ATTRIBUTION_BLOCKED when the job row is missing', async () => {
    const supabase = makeSupabase({ job: null })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false && result.outcome === 'ATTRIBUTION_BLOCKED') {
      expect(result.gate.code).toBe('JOB_NOT_FOUND')
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('blocks with ATTRIBUTION_BLOCKED when the attribution lookup errors', async () => {
    const supabase = makeSupabase({ job: null, jobError: { message: 'conn reset' } })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false && result.outcome === 'ATTRIBUTION_BLOCKED') {
      expect(result.gate.code).toBe('DB_ERROR')
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('does not call the gate for already-released SPRs (idempotent path)', async () => {
    // Released SPRs short-circuit before the gate — attribution cannot be
    // re-gated for money that has already moved.
    const supabase = makeSupabase({
      spr: { ...FUNDED_SPR, status: 'released', external_payout_ref: 'tr_prev' },
      job: null, // gate would block if it ran
    })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(true)
    if (result.ok === true) expect(result.outcome).toBe('ALREADY_RELEASED')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('does not call the gate for non-funded SPRs — status guard fires first', async () => {
    const supabase = makeSupabase({
      spr: { ...FUNDED_SPR, status: 'pending' },
      job: null,
    })
    const result = await releaseSupplementaryPayout(supabase, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.outcome).toBe('NOT_FUNDED')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })
})
