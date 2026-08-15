/**
 * Attribution-Roundtrip E2E — Stage 7.
 *
 * Story:
 *   1. Funding proceeds (attribution=finalized at creation).
 *   2. Something escalates the job to DLQ (operator reject, finalizer max-retry).
 *   3. Release is attempted — server gate blocks with ATTRIBUTION_BLOCKED.
 *   4. Operator resolves the DLQ via operator_resolve_attribution RPC.
 *   5. Release is attempted again — now unblocked, Stripe transfer succeeds,
 *      SPR transitions to 'released'.
 *
 *   This test exercises the supplementary release path end-to-end at the
 *   shared-helper level: the server-side handlers (release-supplementary-
 *   payout, /api/operator/resolve-attribution) are thin wrappers over
 *   `releaseSupplementaryPayout` and `operator_resolve_attribution` RPC, so
 *   the roundtrip here captures the real state-machine semantic.
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

const SPR_ID = 'spr-roundtrip'
const JOB_ID = 'job-roundtrip'

const FUNDED_SPR = {
  id: SPR_ID,
  status: 'funded',
  job_id: JOB_ID,
  craftsman_user_id: 'craft-1',
  external_ref: 'pi_roundtrip',
  amount_cents: 10_000,
  currency: 'eur',
  original_payment_id: 'pay-roundtrip',
  change_order_id: 'co-roundtrip',
  customer_user_id: 'cust-1',
}

function makeClient(jobState: Record<string, unknown>, rowsUpdated = 1) {
  const ledgerUpserts: Record<string, unknown>[] = []
  const ledgerUpsertOptions: Record<string, unknown>[] = []
  return {
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
                  select: vi.fn().mockResolvedValue({
                    data: Array(rowsUpdated).fill({ id: SPR_ID }),
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'jobs') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: jobState, error: null }),
              }),
            }),
          }
        }
        if (table === 'provider_payout_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    stripe_connect_account_id: 'acct_roundtrip',
                    charges_enabled: true,
                    payouts_enabled: true,
                  },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'ledger_entries') {
          return {
            upsert: vi.fn((rows: Record<string, unknown> | Record<string, unknown>[], options?: Record<string, unknown>) => {
              ledgerUpserts.push(...(Array.isArray(rows) ? rows : [rows]))
              if (options) ledgerUpsertOptions.push(options)
              return Promise.resolve({ error: null })
            }),
          }
        }
        return {}
      }),
    } as unknown as SupabaseClient,
    ledgerUpserts,
    ledgerUpsertOptions,
  }
}

describe('Roundtrip — Funding → DLQ → Operator-Resolve → Release', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      latest_charge: 'ch_roundtrip',
      metadata: { platformFeeRate: '0.09', commercialOrigin: 'platform_acquired' },
    })
    mockTransfersCreate.mockResolvedValue({ id: 'tr_roundtrip' })
  })

  it('step-by-step contract: blocked → resolve → unblocked', async () => {
    // ── Step A. Funding done.  Attribution goes to DLQ (max-retry / operator).
    const dlqJob = {
      id: JOB_ID,
      commercial_origin: null,
      attribution_status: 'dlq',
      attribution_dlq_reason: 'MAX_RETRY_EXCEEDED',
    }
    const phaseDlq = makeClient(dlqJob)

    // Step A.1 — release blocked
    const blocked = await releaseSupplementaryPayout(phaseDlq.client, makeStripe(), SPR_ID)
    expect(blocked.ok).toBe(false)
    if (blocked.ok === false) {
      expect(blocked.outcome).toBe('ATTRIBUTION_BLOCKED')
      if (blocked.outcome === 'ATTRIBUTION_BLOCKED') {
        expect(blocked.gate.code).toBe('ATTRIBUTION_DLQ')
      }
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()

    // ── Step B. Operator resolves DLQ → finalized, platform_acquired.
    // We simulate the post-RPC DB state directly; the RPC itself is tested
    // separately in tests/api/operatorResolveAttributionHandler.test.ts and
    // operatorResolveAttributionRpcMigration.test.ts.
    const finalizedJob = {
      id: JOB_ID,
      commercial_origin: 'platform_acquired',
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    }
    const phaseResolved = makeClient(finalizedJob)

    // ── Step C. Release retried — gate passes, Stripe transfer runs, SPR released.
    const unblocked = await releaseSupplementaryPayout(phaseResolved.client, makeStripe(), SPR_ID)
    expect(unblocked.ok).toBe(true)
    if (unblocked.ok === true) {
      expect(unblocked.outcome).toBe('RELEASED')
      expect(unblocked.transferId).toBe('tr_roundtrip')
    }
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
    // The ledger should have received the three movement rows in the prod shape:
    // entry_type ∈ enum, a movement_ref discriminator, and NONE of the legacy
    // drift keys (note / type / id / created_at). This is the real guard that the
    // producer (_releaseSupplementaryPayout) emits a prod-valid shape.
    expect(phaseResolved.ledgerUpserts).toHaveLength(3)
    for (const row of phaseResolved.ledgerUpserts) {
      expect(['escrow_deposit', 'platform_fee', 'payout']).toContain(row.entry_type)
      expect(typeof row.movement_ref).toBe('string')
      expect(row).not.toHaveProperty('note')
      expect(row).not.toHaveProperty('type')
      expect(row).not.toHaveProperty('id')
      expect(row).not.toHaveProperty('created_at')
    }
    expect(phaseResolved.ledgerUpsertOptions[0]).toMatchObject({
      onConflict: 'payment_id,entry_type,movement_ref',
    })
  })

  it('operator reject (keep frozen) leaves DLQ: release stays blocked on retry', async () => {
    // After operator_reject: status stays 'dlq', attribution_dlq_reason updated.
    const stillDlq = {
      id: JOB_ID,
      commercial_origin: null,
      attribution_status: 'dlq',
      attribution_dlq_reason: 'OPERATOR_FROZEN — awaiting customer contact',
    }
    const phase = makeClient(stillDlq)

    const result = await releaseSupplementaryPayout(phase.client, makeStripe(), SPR_ID)
    expect(result.ok).toBe(false)
    if (result.ok === false && result.outcome === 'ATTRIBUTION_BLOCKED' && result.gate.code === 'ATTRIBUTION_DLQ') {
      expect(result.gate.dlqReason).toMatch(/OPERATOR_FROZEN/)
    }
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })
})
