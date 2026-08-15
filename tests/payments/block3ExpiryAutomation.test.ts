/**
 * Block 3 — Expiry Automation: Offer + FundingRequest
 *
 * Invariants proven:
 *   1. Accepting an offer with validUntil strictly before today (UTC) throws
 *   2. Accepting an offer with validUntil = today succeeds
 *   3. Accepting an offer without validUntil succeeds
 *   4. Accepting an offer with status='expired' throws (existing guard)
 *   5. expireStaleOffers correctly expires matching rows via Supabase
 *   6. expireStaleOffers is idempotent: empty result when nothing matches
 *   7. expireStaleFundingRequests correctly expires matching rows
 *   8. markFundingRequestExpired transitions status to 'expired'
 *   9. markFundingRequestExpired is a no-op when already funded
 *  10. markFundingRequestExpired is a no-op when already cancelled
 *  11. ACTIVE_STATUSES does not contain funding_initiated (live-PI safety)
 *  12. expireStaleFundingRequests writes updated_at as ISO string (TIMESTAMPTZ compat)
 *  13. markFundingRequestExpired is a no-op when funding_initiated
 *  14. Migration backfill updates non-terminal NULL expires_at rows from created_at + 14d
 *  15. Backfill excludes terminal statuses (funded, cancelled, expired)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { updateOffer } from '../../src/lib/offers/service'
import {
  ensureFundingRequest,
  markFundingCompleted,
  markFundingCancelled,
  markFundingInitiated,
  markFundingRequestExpired,
  FUNDING_REQUEST_EXPIRY_MS,
} from '../../src/lib/payments/fundingRequest/fundingRequestService'
import { expireStaleOffers } from '../../api/_offerExpiry'
import { expireStaleFundingRequests, ACTIVE_STATUSES } from '../../api/_fundingRequestExpiry'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Date helpers ──────────────────────────────────────────────────────────────

function utcDate(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

// ── Mock Supabase factory ─────────────────────────────────────────────────────
// Minimal chainable mock that handles the select→limit and update→select chains
// used by expireStaleOffers and expireStaleFundingRequests.

function makeMockSupabase({
  staleRows = [] as Array<{ id: string }>,
  updatedRows = staleRows as Array<{ id: string }>,
  fetchError = null as null | { message: string },
  updateError = null as null | { message: string },
} = {}): SupabaseClient {
  let afterUpdate = false

  const chain: Record<string, unknown> = {
    select: (cols?: string) => {
      if (afterUpdate) {
        return Promise.resolve({ data: updatedRows, error: updateError })
      }
      void cols
      return chain
    },
    update: () => {
      afterUpdate = true
      return chain
    },
    eq: () => chain,
    not: () => chain,
    lt: () => chain,
    lte: () => chain,
    in: () => chain,
    limit: () => Promise.resolve({ data: staleRows, error: fetchError }),
  }

  return { from: () => chain } as unknown as SupabaseClient
}

// ── Base offer params ─────────────────────────────────────────────────────────

function baseOffer(conversationId: string) {
  return {
    conversationId,
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    price: '1.000 €',
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 3 — Expiry Automation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── P1: acceptOfferWorkflow guard ──────────────────────────────────────────

  describe('acceptOfferWorkflow — validUntil guard', () => {
    it('throws when validUntil is yesterday (UTC)', async () => {
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-expired-yesterday'),
        validUntil: utcDate(-1),
      })

      await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(
        /offer validity expired on/,
      )
    })

    it('throws when validUntil is 7 days ago', async () => {
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-expired-7d'),
        validUntil: utcDate(-7),
      })

      await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(
        /offer validity expired on/,
      )
    })

    it('succeeds when validUntil is today (offer still valid)', async () => {
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-valid-today'),
        validUntil: utcDate(0),
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted?.status).toBe('accepted')
    })

    it('succeeds when validUntil is tomorrow', async () => {
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-valid-tomorrow'),
        validUntil: utcDate(1),
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted?.status).toBe('accepted')
    })

    it('succeeds when no validUntil is set', async () => {
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-no-validuntil'),
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted?.status).toBe('accepted')
    })

    it('throws when offer.status is already expired (existing status guard)', async () => {
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-status-expired'),
      })

      // Manually set status to 'expired' (as the cron would do)
      await updateOffer(offer.id, (o) => ({ ...o, status: 'expired' as const, updatedAt: Date.now() }))

      await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(
        /current status is 'expired'/,
      )
    })

    it('expiry guard message includes the offer ID and date', async () => {
      const validUntil = utcDate(-3)
      const offer = await createOfferWorkflow({
        ...baseOffer('conv-error-msg'),
        validUntil,
      })

      let caught: Error | undefined
      try {
        await acceptOfferWorkflow(offer.id)
      } catch (e) {
        caught = e as Error
      }
      expect(caught).toBeDefined()
      expect(caught?.message).toContain(offer.id)
      expect(caught?.message).toContain(validUntil)
    })
  })

  // ── P2: expireStaleOffers ─────────────────────────────────────────────────

  describe('expireStaleOffers (cron sweep)', () => {
    it('returns expired count matching found rows', async () => {
      const staleRows = [{ id: 'offer-1' }, { id: 'offer-2' }]
      const supabase = makeMockSupabase({ staleRows })

      const summary = await expireStaleOffers(supabase)

      expect(summary.checked).toBe(2)
      expect(summary.expired).toBe(2)
      expect(summary.failed).toBe(0)
    })

    it('returns zero counts when no stale offers exist (idempotent no-op)', async () => {
      const supabase = makeMockSupabase({ staleRows: [] })

      const summary = await expireStaleOffers(supabase)

      expect(summary.checked).toBe(0)
      expect(summary.expired).toBe(0)
      expect(summary.failed).toBe(0)
    })

    it('records failure when DB update fails', async () => {
      const staleRows = [{ id: 'offer-3' }]
      const supabase = makeMockSupabase({
        staleRows,
        updateError: { message: 'connection timeout' },
        updatedRows: [],
      })

      const summary = await expireStaleOffers(supabase)

      expect(summary.checked).toBe(1)
      expect(summary.failed).toBe(1)
      expect(summary.expired).toBe(0)
    })

    it('throws when the initial fetch fails', async () => {
      const supabase = makeMockSupabase({
        fetchError: { message: 'DB unreachable' },
      })

      await expect(expireStaleOffers(supabase)).rejects.toThrow('DB unreachable')
    })
  })

  // ── P3: expireStaleFundingRequests ────────────────────────────────────────

  describe('expireStaleFundingRequests (cron sweep)', () => {
    it('returns expired count matching found rows', async () => {
      const staleRows = [{ id: 'fr-1' }, { id: 'fr-2' }, { id: 'fr-3' }]
      const supabase = makeMockSupabase({ staleRows })

      const summary = await expireStaleFundingRequests(supabase)

      expect(summary.checked).toBe(3)
      expect(summary.expired).toBe(3)
      expect(summary.failed).toBe(0)
    })

    it('returns zero counts when nothing is expired (idempotent)', async () => {
      const supabase = makeMockSupabase({ staleRows: [] })

      const summary = await expireStaleFundingRequests(supabase)

      expect(summary.checked).toBe(0)
      expect(summary.expired).toBe(0)
    })

    it('records failure when update fails', async () => {
      const staleRows = [{ id: 'fr-4' }]
      const supabase = makeMockSupabase({
        staleRows,
        updateError: { message: 'timeout' },
        updatedRows: [],
      })

      const summary = await expireStaleFundingRequests(supabase)

      expect(summary.failed).toBe(1)
      expect(summary.expired).toBe(0)
    })
  })

  // ── P3a: ACTIVE_STATUSES invariants ───────────────────────────────────────

  describe('ACTIVE_STATUSES — expiry-safe status set', () => {
    it('does not include funding_initiated (would race live Stripe PaymentIntent)', () => {
      expect(ACTIVE_STATUSES).not.toContain('funding_initiated')
    })

    it('does not include terminal statuses', () => {
      expect(ACTIVE_STATUSES).not.toContain('funded')
      expect(ACTIVE_STATUSES).not.toContain('cancelled')
      expect(ACTIVE_STATUSES).not.toContain('expired')
    })
  })

  // ── P3b: updated_at format guard ───────────────────────────────────────────

  describe('expireStaleFundingRequests — updated_at format', () => {
    function makeMockSupabaseCapturing() {
      let capturedPayload: Record<string, unknown> | null = null
      let afterUpdate = false

      const chain: Record<string, unknown> = {
        select: () => {
          if (afterUpdate) return Promise.resolve({ data: [{ id: 'fr-cap' }], error: null })
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          afterUpdate = true
          capturedPayload = payload
          return chain
        },
        eq: () => chain,
        not: () => chain,
        lt: () => chain,
        lte: () => chain,
        in: () => chain,
        limit: () => Promise.resolve({ data: [{ id: 'fr-cap' }], error: null }),
      }

      return {
        supabase: { from: () => chain } as unknown as SupabaseClient,
        getUpdatePayload: () => capturedPayload,
      }
    }

    it('writes updated_at as ISO string, not a millisecond integer', async () => {
      const { supabase, getUpdatePayload } = makeMockSupabaseCapturing()
      await expireStaleFundingRequests(supabase)
      const payload = getUpdatePayload()
      expect(payload).not.toBeNull()
      expect(typeof payload?.updated_at).toBe('string')
      expect(payload?.updated_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  // ── P3: markFundingRequestExpired ─────────────────────────────────────────

  describe('markFundingRequestExpired (service layer)', () => {
    async function createTestFundingRequest(overrides: Partial<Parameters<typeof ensureFundingRequest>[0]> = {}) {
      return ensureFundingRequest({
        sourceOfferId: 'offer-test',
        jobId: 'job-test',
        escrowPlanId: 'plan-test',
        customerUserId: 'cust-1',
        providerUserId: 'provider-1',
        providerId: 'provider-uuid-1',
        amount: 1000,
        currency: 'EUR',
        ...overrides,
      })
    }

    it('transitions status to expired', async () => {
      const req = await createTestFundingRequest({ escrowPlanId: 'plan-exp-1' })
      const result = await markFundingRequestExpired(req.id)
      expect(result?.status).toBe('expired')
    })

    it('updates updatedAt on expiry', async () => {
      const before = Date.now()
      const req = await createTestFundingRequest({ escrowPlanId: 'plan-exp-2' })
      const result = await markFundingRequestExpired(req.id)
      expect(result?.updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('is a no-op when status is already funded', async () => {
      const req = await createTestFundingRequest({ escrowPlanId: 'plan-funded' })
      await markFundingCompleted(req.id)
      const result = await markFundingRequestExpired(req.id)
      expect(result?.status).toBe('funded')
    })

    it('is a no-op when status is already cancelled', async () => {
      const req = await createTestFundingRequest({ escrowPlanId: 'plan-cancelled' })
      await markFundingCancelled(req.id)
      const result = await markFundingRequestExpired(req.id)
      expect(result?.status).toBe('cancelled')
    })

    it('is a no-op when already expired (idempotent)', async () => {
      const req = await createTestFundingRequest({ escrowPlanId: 'plan-already-exp' })
      await markFundingRequestExpired(req.id)
      const result = await markFundingRequestExpired(req.id)
      expect(result?.status).toBe('expired')
    })

    it('is a no-op when status is funding_initiated (live external PaymentIntent)', async () => {
      const req = await createTestFundingRequest({ escrowPlanId: 'plan-initiated' })
      await markFundingInitiated(req.id, { externalFundingRef: 'pi_test_123' })
      const result = await markFundingRequestExpired(req.id)
      expect(result?.status).toBe('funding_initiated')
    })

    it('returns undefined for unknown requestId', async () => {
      const result = await markFundingRequestExpired('nonexistent-id')
      expect(result).toBeUndefined()
    })
  })

  // ── P3: expiresAt set at creation ─────────────────────────────────────────

  describe('ensureFundingRequest — expiresAt', () => {
    it('sets expiresAt = createdAt + FUNDING_REQUEST_EXPIRY_MS', async () => {
      const before = Date.now()
      const req = await ensureFundingRequest({
        sourceOfferId: 'offer-ts',
        jobId: 'job-ts',
        escrowPlanId: 'plan-ts',
        customerUserId: 'cust-1',
        providerUserId: 'provider-1',
        providerId: 'provider-uuid-1',
        amount: 500,
      })
      const after = Date.now()

      expect(req.expiresAt).toBeDefined()
      expect(req.expiresAt!).toBeGreaterThanOrEqual(before + FUNDING_REQUEST_EXPIRY_MS)
      expect(req.expiresAt!).toBeLessThanOrEqual(after + FUNDING_REQUEST_EXPIRY_MS)
    })

    it('expiresAt is 14 days after creation', () => {
      const DAYS_14_MS = 14 * 24 * 60 * 60 * 1000
      expect(FUNDING_REQUEST_EXPIRY_MS).toBe(DAYS_14_MS)
    })

    it('idempotent: second call returns existing request unchanged', async () => {
      const params = {
        sourceOfferId: 'offer-idem',
        jobId: 'job-idem',
        escrowPlanId: 'plan-idem',
        customerUserId: 'cust-1',
        providerUserId: 'provider-1',
        providerId: 'provider-uuid-1',
        amount: 750,
      }
      const first = await ensureFundingRequest(params)
      const second = await ensureFundingRequest(params)
      expect(second.id).toBe(first.id)
      expect(second.expiresAt).toBe(first.expiresAt)
    })
  })

  // ── P4: Migration backfill — Altbestand ───────────────────────────────────

  describe('Migration 20260420000006 — backfill contract', () => {
    const ROOT = resolve(__dirname, '../..')
    const migrationSql = readFileSync(
      resolve(ROOT, 'supabase/migrations/20260420000006_funding_requests_expires_at.sql'),
      'utf-8',
    )

    it('includes UPDATE backfill for non-terminal rows with NULL expires_at', () => {
      expect(migrationSql).toContain('UPDATE funding_requests')
      expect(migrationSql).toContain('expires_at IS NULL')
      expect(migrationSql).toContain('14 days')
    })

    it('backfill uses created_at as baseline', () => {
      expect(migrationSql).toContain('created_at')
    })

    it('backfill excludes terminal statuses funded, cancelled, expired', () => {
      expect(migrationSql).toMatch(/status NOT IN.*\n?.*'funded'/)
      expect(migrationSql).toContain("'cancelled'")
      expect(migrationSql).toContain("'expired'")
    })

    it('backfill converts to milliseconds (BIGINT column)', () => {
      // EXTRACT(EPOCH ...) * 1000 gives ms; cast to BIGINT for the column type
      expect(migrationSql).toContain('* 1000')
      expect(migrationSql).toContain('BIGINT')
    })
  })
})
