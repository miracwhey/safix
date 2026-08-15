// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Tests for api/_paymentAuth.ts — centralized payment authorization helpers.
 *
 * Verifies:
 *   loadPaymentContext:
 *     - happy path returns PaymentContext with correct fields
 *     - payment not found in DB → returns null (context_missing)
 *     - payment has no job_id → returns null (context_invalid)
 *     - job not found for payment → returns null (context_invalid)
 *     - DB error on payment lookup → returns null (context_missing)
 *
 *   fetchIsOperator:
 *     - returns true when profiles.is_operator = true
 *     - returns false when profiles.is_operator = false
 *     - returns false on DB error (fail closed)
 *
 *   canCaptureEscrowForPayment:
 *     - customer (customerUserId match) → allowed, emits authorization_verified
 *     - non-owner authenticated user → denied, emits authorization_failed
 *     - job with no customerUserId → denied (context has no customer)
 *
 *   canRefundEscrowForPayment:
 *     - customer → allowed
 *     - operator → allowed
 *     - customer who is also operator → allowed
 *     - non-owner, non-operator → denied
 *     - job with no customerUserId, non-operator → denied
 *     - job with no customerUserId, operator → allowed (operator override)
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadPaymentContext,
  fetchIsOperator,
  canCaptureEscrowForPayment,
  canRefundEscrowForPayment,
  type PaymentContext,
} from '../../api/_paymentAuth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, restore: () => { console.warn = orig } }
}

function captureInfos(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, restore: () => { console.log = orig } }
}

/**
 * Build a minimal mock Supabase admin client that supports chaining:
 *   admin.from('payments').select(...).eq(...).limit(...)
 *   admin.from('jobs').select(...).eq(...).limit(...)
 *   admin.from('profiles').select(...).eq(...).limit(1).single()
 */
function makeAdmin(
  paymentResult: { data: unknown; error: unknown },
  jobResult?: { data: unknown; error: unknown },
  profileResult?: { data: unknown; error: unknown },
): SupabaseClient {
  let callIndex = 0

  const makeChain = (result: { data: unknown; error: unknown }) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      limit: () => chain,
      single: () => Promise.resolve(result),
      then: (fn: (v: unknown) => unknown) => Promise.resolve(result).then(fn),
    }
    // Make the chain itself awaitable (for .limit() returning a promise-like)
    Object.defineProperty(chain, Symbol.toStringTag, { value: 'MockChain' })
    // Make the chain thenable
    ;(chain as unknown as Promise<unknown>).then = (fn) => Promise.resolve(result).then(fn)
    return chain
  }

  return {
    from: (_table: string) => {
      // Track which table is being queried by order of calls
      const idx = callIndex++
      if (idx === 0) return makeChain(paymentResult) as unknown as ReturnType<SupabaseClient['from']>
      if (idx === 1 && jobResult) return makeChain(jobResult) as unknown as ReturnType<SupabaseClient['from']>
      if (profileResult) return makeChain(profileResult) as unknown as ReturnType<SupabaseClient['from']>
      return makeChain({ data: null, error: null }) as unknown as ReturnType<SupabaseClient['from']>
    },
  } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// loadPaymentContext — happy path
// ---------------------------------------------------------------------------

describe('loadPaymentContext — happy path', () => {
  it('returns PaymentContext with all fields when payment and job are found', async () => {
    const admin = makeAdmin(
      {
        data: [
          { id: 'payment-123', job_id: 'job-456', provider_ref: 'pi_test123', status: 'in_escrow' },
        ],
        error: null,
      },
      {
        data: [{ id: 'job-456', customer_user_id: 'cust-uuid', provider_id: 'craft-uuid' }],
        error: null,
      },
    )

    const ctx = await loadPaymentContext('pi_test123', admin, 'test-route')

    expect(ctx).not.toBeNull()
    expect(ctx?.paymentId).toBe('payment-123')
    expect(ctx?.paymentIntentId).toBe('pi_test123')
    expect(ctx?.jobId).toBe('job-456')
    expect(ctx?.customerUserId).toBe('cust-uuid')
    expect(ctx?.craftsmanUserId).toBe('craft-uuid')
    expect(ctx?.paymentStatus).toBe('in_escrow')
  })

  it('coerces a missing status field to null (legacy/drift rows fail closed downstream)', async () => {
    const admin = makeAdmin(
      {
        data: [{ id: 'payment-123', job_id: 'job-456', provider_ref: 'pi_test123' }],
        error: null,
      },
      {
        data: [{ id: 'job-456', customer_user_id: 'cust-uuid', provider_id: 'craft-uuid' }],
        error: null,
      },
    )

    const ctx = await loadPaymentContext('pi_test123', admin, 'test-route')

    expect(ctx).not.toBeNull()
    expect(ctx?.paymentStatus).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// loadPaymentContext — payment not found
// ---------------------------------------------------------------------------

describe('loadPaymentContext — payment not found', () => {
  it('returns null and emits context_missing when payment row is absent', async () => {
    const admin = makeAdmin({ data: [], error: null })

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_unknown', admin, 'test-route')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('api.payment.context_missing')
    expect(cap.lines.join('\n')).toContain('payment_not_found')
  })

  it('returns null and emits context_missing on DB error', async () => {
    const admin = makeAdmin({ data: null, error: { message: 'connection failed' } })

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_err', admin, 'test-route')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('api.payment.context_missing')
    expect(cap.lines.join('\n')).toContain('db_error')
  })
})

// ---------------------------------------------------------------------------
// loadPaymentContext — context_invalid cases
// ---------------------------------------------------------------------------

describe('loadPaymentContext — context_invalid', () => {
  it('returns null and emits context_invalid when payment has no job_id', async () => {
    const admin = makeAdmin({
      data: [{ id: 'payment-no-job', job_id: null, provider_ref: 'pi_nojob' }],
      error: null,
    })

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_nojob', admin, 'test-route')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('api.payment.context_invalid')
    expect(cap.lines.join('\n')).toContain('payment_has_no_job_id')
  })

  it('returns null and emits context_invalid when job is not found', async () => {
    const admin = makeAdmin(
      { data: [{ id: 'payment-123', job_id: 'job-missing', provider_ref: 'pi_nojob2' }], error: null },
      { data: [], error: null },
    )

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_nojob2', admin, 'test-route')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('api.payment.context_invalid')
    expect(cap.lines.join('\n')).toContain('job_not_found')
  })

  it('returns null and emits context_invalid on job DB error', async () => {
    const admin = makeAdmin(
      { data: [{ id: 'payment-123', job_id: 'job-456', provider_ref: 'pi_joberr' }], error: null },
      { data: null, error: { message: 'job query failed' } },
    )

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_joberr', admin, 'test-route')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('api.payment.context_invalid')
    expect(cap.lines.join('\n')).toContain('job_db_error')
  })
})

// ---------------------------------------------------------------------------
// loadPaymentContext — corridor fallback (provider_ref missing)
// ---------------------------------------------------------------------------

/**
 * Table-aware mock: dispatches by table name so the corridor fallback path
 * (payments-by-provider_ref → escrow_payment_plans-by-external_funding_ref →
 * payments-by-job_id → jobs) can be exercised independently of call order.
 *
 * `paymentsByProviderRef` answers the first payments lookup (.eq provider_ref);
 * `paymentsByJobId` answers the fallback payments lookup (.eq job_id .order);
 * `plan` answers the escrow_payment_plans lookup; `job` answers the jobs lookup.
 */
function makeCorridorAdmin(opts: {
  paymentsByProviderRef: { data: unknown; error: unknown }
  plan: { data: unknown; error: unknown }
  paymentsByJobId: { data: unknown; error: unknown }
  job?: { data: unknown; error: unknown }
}): SupabaseClient {
  const thenable = (result: { data: unknown; error: unknown }) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      single: () => Promise.resolve(result),
      then: (fn: (v: unknown) => unknown) => Promise.resolve(result).then(fn),
    }
    return chain
  }

  let paymentsCall = 0
  return {
    from: (table: string) => {
      if (table === 'payments') {
        // First payments query = provider_ref lookup; second = job_id fallback.
        const result = paymentsCall++ === 0 ? opts.paymentsByProviderRef : opts.paymentsByJobId
        return thenable(result) as unknown as ReturnType<SupabaseClient['from']>
      }
      if (table === 'escrow_payment_plans') {
        return thenable(opts.plan) as unknown as ReturnType<SupabaseClient['from']>
      }
      if (table === 'jobs') {
        return thenable(opts.job ?? { data: null, error: null }) as unknown as ReturnType<SupabaseClient['from']>
      }
      return thenable({ data: null, error: null }) as unknown as ReturnType<SupabaseClient['from']>
    },
  } as unknown as SupabaseClient
}

describe('loadPaymentContext — corridor fallback (provider_ref missing)', () => {
  it('resolves context via escrow_payment_plans.external_funding_ref when no payments.provider_ref row exists', async () => {
    const admin = makeCorridorAdmin({
      paymentsByProviderRef: { data: [], error: null }, // corridor: provider_ref never written
      plan: { data: [{ job_id: 'job-corridor' }], error: null },
      paymentsByJobId: {
        data: [{ id: 'payment-corridor', job_id: 'job-corridor', provider_ref: null, status: 'in_escrow' }],
        error: null,
      },
      job: { data: [{ id: 'job-corridor', customer_user_id: 'cust-uuid', provider_id: 'craft-uuid' }], error: null },
    })

    const cap = captureInfos()
    const ctx = await loadPaymentContext('pi_corridor', admin, 'refund-escrow')
    cap.restore()

    expect(ctx).not.toBeNull()
    expect(ctx?.paymentId).toBe('payment-corridor')
    expect(ctx?.paymentIntentId).toBe('pi_corridor')
    expect(ctx?.jobId).toBe('job-corridor')
    expect(ctx?.customerUserId).toBe('cust-uuid')
    expect(ctx?.craftsmanUserId).toBe('craft-uuid')
    expect(ctx?.paymentStatus).toBe('in_escrow')
    expect(cap.lines.join('\n')).toContain('api.payment.context_resolved_via_funding_ref')
  })

  it('resolved corridor context still denies a stranger and allows the job customer / operator', async () => {
    const admin = makeCorridorAdmin({
      paymentsByProviderRef: { data: [], error: null },
      plan: { data: [{ job_id: 'job-corridor' }], error: null },
      paymentsByJobId: {
        data: [{ id: 'payment-corridor', job_id: 'job-corridor', provider_ref: null, status: 'in_escrow' }],
        error: null,
      },
      job: { data: [{ id: 'job-corridor', customer_user_id: 'cust-uuid', provider_id: 'craft-uuid' }], error: null },
    })

    const ctx = await loadPaymentContext('pi_corridor', admin, 'refund-escrow')
    expect(ctx).not.toBeNull()

    // Authz invariant is NOT weakened by the fallback: ownership comes from the job.
    expect(canRefundEscrowForPayment('stranger-uuid', ctx!, false, 'refund-escrow')).toBe(false)
    expect(canRefundEscrowForPayment('craft-uuid', ctx!, false, 'refund-escrow')).toBe(false)
    expect(canRefundEscrowForPayment('cust-uuid', ctx!, false, 'refund-escrow')).toBe(true)
    expect(canRefundEscrowForPayment('operator-uuid', ctx!, true, 'refund-escrow')).toBe(true)
  })

  it('returns null (payment_not_found) when neither provider_ref nor a funding-ref plan resolves', async () => {
    const admin = makeCorridorAdmin({
      paymentsByProviderRef: { data: [], error: null },
      plan: { data: [], error: null }, // no plan carries this PI
      paymentsByJobId: { data: [], error: null },
    })

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_ghost', admin, 'refund-escrow')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('api.payment.context_missing')
    expect(cap.lines.join('\n')).toContain('payment_not_found')
  })

  it('returns null (payment_not_found) when the plan resolves a job but that job has no payments row', async () => {
    const admin = makeCorridorAdmin({
      paymentsByProviderRef: { data: [], error: null },
      plan: { data: [{ job_id: 'job-corridor' }], error: null },
      paymentsByJobId: { data: [], error: null }, // corridor audit-gap: no payments row for the job
    })

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_corridor', admin, 'refund-escrow')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('payment_not_found')
  })

  it('returns null (funding_ref_lookup_error) on a plan-lookup DB error', async () => {
    const admin = makeCorridorAdmin({
      paymentsByProviderRef: { data: [], error: null },
      plan: { data: null, error: { message: 'plan query failed' } },
      paymentsByJobId: { data: [], error: null },
    })

    const cap = captureWarnings()
    const ctx = await loadPaymentContext('pi_corridor', admin, 'refund-escrow')
    cap.restore()

    expect(ctx).toBeNull()
    expect(cap.lines.join('\n')).toContain('funding_ref_lookup_error')
  })

  it('does NOT run the fallback when the direct provider_ref lookup already found a payment', async () => {
    const admin = makeCorridorAdmin({
      paymentsByProviderRef: {
        data: [{ id: 'payment-direct', job_id: 'job-direct', provider_ref: 'pi_direct', status: 'in_escrow' }],
        error: null,
      },
      // If the fallback were (wrongly) taken, it would resolve a different job/payment.
      plan: { data: [{ job_id: 'job-WRONG' }], error: null },
      paymentsByJobId: {
        data: [{ id: 'payment-WRONG', job_id: 'job-WRONG', provider_ref: null, status: 'in_escrow' }],
        error: null,
      },
      job: { data: [{ id: 'job-direct', customer_user_id: 'cust-uuid', provider_id: 'craft-uuid' }], error: null },
    })

    const ctx = await loadPaymentContext('pi_direct', admin, 'refund-escrow')

    expect(ctx?.paymentId).toBe('payment-direct')
    expect(ctx?.jobId).toBe('job-direct')
  })
})

// ---------------------------------------------------------------------------
// fetchIsOperator
// ---------------------------------------------------------------------------

describe('fetchIsOperator', () => {
  it('returns true when profiles.is_operator is true', async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: { is_operator: true }, error: null }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await fetchIsOperator('operator-user', admin)
    expect(result).toBe(true)
  })

  it('returns false when profiles.is_operator is false', async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: { is_operator: false }, error: null }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await fetchIsOperator('regular-user', admin)
    expect(result).toBe(false)
  })

  it('returns false on DB error (fail closed)', async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: null, error: { message: 'not found' } }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await fetchIsOperator('ghost-user', admin)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canCaptureEscrowForPayment
// ---------------------------------------------------------------------------

describe('canCaptureEscrowForPayment', () => {
  const baseContext: PaymentContext = {
    paymentId: 'payment-abc',
    paymentIntentId: 'pi_abc',
    jobId: 'job-abc',
    customerUserId: 'cust-uuid',
    craftsmanUserId: 'craft-uuid',
  }

  it('returns true and emits authorization_verified for the job customer', () => {
    const cap = captureInfos()
    const result = canCaptureEscrowForPayment('cust-uuid', baseContext, 'capture-escrow')
    cap.restore()

    expect(result).toBe(true)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_verified')
    expect(cap.lines.join('\n')).toContain('capture_escrow')
    expect(cap.lines.join('\n')).toContain('customer')
  })

  it('returns false and emits authorization_failed for a non-owner user', () => {
    const cap = captureWarnings()
    const result = canCaptureEscrowForPayment('stranger-uuid', baseContext, 'capture-escrow')
    cap.restore()

    expect(result).toBe(false)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_failed')
    expect(cap.lines.join('\n')).toContain('capture_escrow')
    expect(cap.lines.join('\n')).toContain('caller_is_not_customer')
  })

  it('returns false and emits authorization_failed for the craftsman (not the customer)', () => {
    const cap = captureWarnings()
    const result = canCaptureEscrowForPayment('craft-uuid', baseContext, 'capture-escrow')
    cap.restore()

    expect(result).toBe(false)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_failed')
  })

  it('returns false when job has no customerUserId (legacy job)', () => {
    const legacyContext: PaymentContext = { ...baseContext, customerUserId: null }

    const cap = captureWarnings()
    const result = canCaptureEscrowForPayment('any-user', legacyContext, 'capture-escrow')
    cap.restore()

    expect(result).toBe(false)
    expect(cap.lines.join('\n')).toContain('no_customer_on_job')
  })
})

// ---------------------------------------------------------------------------
// canRefundEscrowForPayment
// ---------------------------------------------------------------------------

describe('canRefundEscrowForPayment', () => {
  const baseContext: PaymentContext = {
    paymentId: 'payment-xyz',
    paymentIntentId: 'pi_xyz',
    jobId: 'job-xyz',
    customerUserId: 'cust-uuid',
    craftsmanUserId: 'craft-uuid',
  }

  it('returns true for the job customer (non-operator)', () => {
    const cap = captureInfos()
    const result = canRefundEscrowForPayment('cust-uuid', baseContext, false, 'refund-escrow')
    cap.restore()

    expect(result).toBe(true)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_verified')
    expect(cap.lines.join('\n')).toContain('refund_escrow')
    expect(cap.lines.join('\n')).toContain('customer')
  })

  it('returns true for an operator (unrelated to the job)', () => {
    const cap = captureInfos()
    const result = canRefundEscrowForPayment('operator-uuid', baseContext, true, 'refund-escrow')
    cap.restore()

    expect(result).toBe(true)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_verified')
    expect(cap.lines.join('\n')).toContain('operator')
  })

  it('returns true for a customer who is also an operator', () => {
    const cap = captureInfos()
    const result = canRefundEscrowForPayment('cust-uuid', baseContext, true, 'refund-escrow')
    cap.restore()

    expect(result).toBe(true)
  })

  it('returns false for a non-owner, non-operator user', () => {
    const cap = captureWarnings()
    const result = canRefundEscrowForPayment('stranger-uuid', baseContext, false, 'refund-escrow')
    cap.restore()

    expect(result).toBe(false)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_failed')
    expect(cap.lines.join('\n')).toContain('caller_is_not_customer_or_operator')
  })

  it('returns false for the craftsman (not customer, non-operator)', () => {
    const cap = captureWarnings()
    const result = canRefundEscrowForPayment('craft-uuid', baseContext, false, 'refund-escrow')
    cap.restore()

    expect(result).toBe(false)
    expect(cap.lines.join('\n')).toContain('api.payment.authorization_failed')
  })

  it('returns false when job has no customerUserId and caller is not an operator', () => {
    const legacyContext: PaymentContext = { ...baseContext, customerUserId: null }

    const cap = captureWarnings()
    const result = canRefundEscrowForPayment('any-user', legacyContext, false, 'refund-escrow')
    cap.restore()

    expect(result).toBe(false)
    expect(cap.lines.join('\n')).toContain('no_customer_on_job')
  })

  it('returns true when job has no customerUserId but caller is an operator', () => {
    const legacyContext: PaymentContext = { ...baseContext, customerUserId: null }

    const cap = captureInfos()
    const result = canRefundEscrowForPayment('operator-uuid', legacyContext, true, 'refund-escrow')
    cap.restore()

    expect(result).toBe(true)
    expect(cap.lines.join('\n')).toContain('authorization_verified')
  })
})
