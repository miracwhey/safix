/**
 * Webhook Supplementary-Release Attribution Idempotency — Stage 7.
 *
 * Scenario:
 *   The Stripe `payment_intent.succeeded` webhook calls
 *   `releaseSupplementaryPayout` for auto-release.  Between funding and the
 *   webhook delivery the attribution can transition to DLQ (operator action
 *   via reject-on-pending, or the Finalizer escalating).  When that happens:
 *
 *     1. First webhook delivery: gate blocks → outcome ATTRIBUTION_BLOCKED,
 *        no Stripe Transfer, SPR stays 'funded'.
 *     2. Stripe retries the webhook (duplicate / at-least-once delivery):
 *        SAME outcome, NO money movement, NO DB write drift.
 *
 *   This test locks both invariants at the shared helper level — the
 *   stripe-webhook.ts `case payment_intent.succeeded` handler just forwards
 *   through.
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

function makeStripe(): Stripe {
  return {
    transfers: { create: mockTransfersCreate },
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve },
  } as unknown as Stripe
}

const SPR_ID = 'spr-dlq-1'
const JOB_ID = 'job-dlq-1'

const FUNDED_SPR = {
  id: SPR_ID,
  status: 'funded',
  job_id: JOB_ID,
  craftsman_user_id: 'craft-1',
  external_ref: 'pi_mock',
  amount_cents: 5000,
  currency: 'eur',
  original_payment_id: 'pay-1',
  change_order_id: 'co-1',
  customer_user_id: 'cust-1',
}

const DLQ_JOB = {
  id: JOB_ID,
  commercial_origin: null,
  attribution_status: 'dlq',
  attribution_dlq_reason: 'MAX_RETRY_EXCEEDED',
}

function makeSupabase({
  spr = FUNDED_SPR,
  job = DLQ_JOB as Record<string, unknown> | null,
  sprUpdateCount = 0,
}: {
  spr?: Record<string, unknown> | null
  job?: Record<string, unknown> | null
  sprUpdateCount?: number
} = {}): { client: SupabaseClient; updates: { table: string; patch: Record<string, unknown> }[] } {
  const updates: { table: string; patch: Record<string, unknown> }[] = []

  const sprSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: spr ?? null, error: null }),
    }),
  })
  const jobSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: job, error: null }),
    }),
  })
  const sprUpdate = vi.fn((patch: Record<string, unknown>) => {
    updates.push({ table: 'supplementary_payment_requests', patch })
    return {
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: Array(sprUpdateCount).fill({ id: SPR_ID }), error: null }),
        }),
      }),
    }
  })

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'supplementary_payment_requests') return { select: sprSelect, update: sprUpdate }
      if (table === 'jobs') return { select: jobSelect }
      return {}
    }),
  } as unknown as SupabaseClient

  return { client, updates }
}

describe('Webhook Supplementary-Release — DLQ idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('first delivery: DLQ blocks the transfer, SPR stays funded', async () => {
    const admin = makeSupabase()
    const result = await releaseSupplementaryPayout(admin.client, makeStripe(), SPR_ID)

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.outcome).toBe('ATTRIBUTION_BLOCKED')
      if (result.outcome === 'ATTRIBUTION_BLOCKED') {
        expect(result.gate.code).toBe('ATTRIBUTION_DLQ')
      }
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(admin.updates).toHaveLength(0) // SPR is not touched
  })

  it('webhook retry (duplicate delivery): SAME outcome, no money movement, no DB drift', async () => {
    const admin = makeSupabase()

    // First call — Stripe delivers the event, gate blocks
    const first = await releaseSupplementaryPayout(admin.client, makeStripe(), SPR_ID)
    // Second call — Stripe at-least-once retry of the same webhook
    const second = await releaseSupplementaryPayout(admin.client, makeStripe(), SPR_ID)

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (first.ok === false && second.ok === false) {
      expect(first.outcome).toBe('ATTRIBUTION_BLOCKED')
      expect(second.outcome).toBe('ATTRIBUTION_BLOCKED')
      if (first.outcome === 'ATTRIBUTION_BLOCKED' && second.outcome === 'ATTRIBUTION_BLOCKED') {
        expect(first.gate.code).toBe(second.gate.code) // deterministic
      }
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
    expect(admin.updates).toHaveLength(0)
  })

  it('dlq → finalized resolve: next webhook delivery unblocks the transfer', async () => {
    // Phase 1: DLQ → gate blocks
    const admin1 = makeSupabase()
    const blocked = await releaseSupplementaryPayout(admin1.client, makeStripe(), SPR_ID)
    expect(blocked.ok).toBe(false)
    if (blocked.ok === false) expect(blocked.outcome).toBe('ATTRIBUTION_BLOCKED')

    // Phase 2: operator resolves → job is now finalized
    const resolvedJob = {
      id: JOB_ID,
      commercial_origin: 'platform_acquired',
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    }

    // Mock payout readiness + Stripe intent retrieval + transfer success for
    // the post-resolve flow.
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      latest_charge: 'ch_mock',
      metadata: { platformFeeRate: '0.09' },
    })
    mockTransfersCreate.mockResolvedValue({ id: 'tr_post_resolve' })

    // Supabase client that returns a payout-ready provider and 1 row updated
    const ledgerRows: Record<string, unknown>[] = []
    const adminPost = {
      client: {
        from: vi.fn((table: string) => {
          if (table === 'supplementary_payment_requests') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: FUNDED_SPR, error: null }),
                }),
              }),
              update: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    select: vi.fn().mockResolvedValue({ data: [{ id: SPR_ID }], error: null }),
                  }),
                }),
              }),
            }
          }
          if (table === 'jobs') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: resolvedJob, error: null }),
                }),
              }),
            }
          }
          if (table === 'provider_payout_accounts') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { stripe_connect_account_id: 'acct_x', charges_enabled: true, payouts_enabled: true },
                    error: null,
                  }),
                }),
              }),
            }
          }
          if (table === 'ledger_entries') {
            return {
              upsert: vi.fn((rows: Record<string, unknown> | Record<string, unknown>[]) => {
                ledgerRows.push(...(Array.isArray(rows) ? rows : [rows]))
                return Promise.resolve({ error: null })
              }),
            }
          }
          return {}
        }),
      } as unknown as SupabaseClient,
    }

    const unblocked = await releaseSupplementaryPayout(adminPost.client, makeStripe(), SPR_ID)
    expect(unblocked.ok).toBe(true)
    if (unblocked.ok === true) expect(unblocked.outcome).toBe('RELEASED')
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
    // Producer must emit the prod movement shape, not the legacy note/type drift.
    expect(ledgerRows).toHaveLength(3)
    for (const row of ledgerRows) {
      expect(['escrow_deposit', 'platform_fee', 'payout']).toContain(row.entry_type)
      expect(row).toHaveProperty('movement_ref')
      expect(row).not.toHaveProperty('note')
      expect(row).not.toHaveProperty('type')
    }
  })
})
