/**
 * Server-side payment authorization helpers.
 *
 * Answers the question: is this authenticated caller allowed to perform a
 * specific payment action on this specific payment/job?
 *
 * Authorization model:
 *
 *   create-escrow
 *     → only the authenticated customer who owns the job/payment context
 *       (enforced inline in create-escrow.ts via customerId === auth.userId)
 *
 *   capture-escrow  (release funds to craftsman)
 *     → only the customer (customer_user_id) of the linked job
 *
 *   refund-escrow   (cancel or refund the payment)
 *     → the customer (customer_user_id) of the linked job
 *     → OR an operator (profiles.is_operator = true)
 *
 * Emitted observability events:
 *   api.payment.context_missing     — paymentIntentId not found in payments table
 *   api.payment.context_invalid     — payment row lacks required job/customer data
 *   api.payment.authorization_verified — caller is allowed to perform the action
 *   api.payment.authorization_failed   — caller is not allowed
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning } from './_observability.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal ownership context resolved from the payments + jobs tables.
 * All fields are required; callers should treat absence as a context error.
 */
export interface PaymentContext {
  /** App-internal payment id (UUID) */
  paymentId: string
  /** Stripe PaymentIntent id (pi_*) */
  paymentIntentId: string
  /** App-internal job id */
  jobId: string
  /** Supabase user id of the customer who owns the job — may be null for legacy jobs */
  customerUserId: string | null
  /** Supabase user id of the craftsman who owns the job — may be null for legacy jobs */
  craftsmanUserId: string | null
  /** payments.status at lookup time — null only on legacy/drift rows */
  paymentStatus: string | null
}

// ---------------------------------------------------------------------------
// Context loader
// ---------------------------------------------------------------------------

/**
 * Loads the minimal payment + job ownership context required for authorization.
 *
 * Resolves the payment row in two steps:
 *   1. Direct: payments.provider_ref = paymentIntentId (separate-charge path,
 *      where the PI is recorded on the payments row itself).
 *   2. Corridor fallback: the destination-charge funding path
 *      (initiate-funding / confirm_funding_atomic) records the PI on
 *      escrow_payment_plans.external_funding_ref and NEVER on
 *      payments.provider_ref (prod: 0/10 rows carry it). When the direct lookup
 *      misses, resolve the plan by external_funding_ref → job_id, then pin to
 *      the SAME payments row confirm_funding_atomic attributes the funding to
 *      (the oldest payments row for the job). Ownership is still derived from the
 *      job below, so the fallback does NOT widen the authorization surface — a
 *      caller who is not the job's customer/operator is still denied downstream.
 *
 * Then fetches the linked job to resolve customer/craftsman ownership.
 *
 * Returns null when:
 *   - no payment row resolves via either path                (context_missing)
 *   - the payment row has no job_id                          (context_invalid)
 *   - the job row cannot be found                            (context_invalid)
 *
 * Must be called with the service-role Supabase admin client so that RLS does
 * not block the lookup (the caller may not yet be verified as the owner).
 */
export async function loadPaymentContext(
  paymentIntentId: string,
  admin: SupabaseClient,
  route: string,
): Promise<PaymentContext | null> {
  // Step 1: find payment by provider_ref (Stripe PaymentIntent id)
  const { data: paymentRows, error: paymentError } = await admin
    .from('payments')
    .select('id, job_id, provider_ref, status')
    .eq('provider_ref', paymentIntentId)
    .limit(1)

  if (paymentError) {
    logWarning('api.payment.context_missing', {
      route,
      paymentIntentId,
      reason: 'db_error',
      detail: paymentError.message,
    })
    return null
  }

  let paymentRow = paymentRows?.[0] as
    | { id: string; job_id: string | null; provider_ref: string | null; status: string | null }
    | undefined

  // Step 1b: corridor fallback. The direct provider_ref lookup misses for every
  // destination-charge corridor funding (PI lives on the escrow plan, not the
  // payments row). Resolve the plan by external_funding_ref → job_id, then pin to
  // the same payments row confirm_funding_atomic uses (oldest for the job).
  if (!paymentRow) {
    const { data: planRows, error: planError } = await admin
      .from('escrow_payment_plans')
      .select('job_id')
      .eq('external_funding_ref', paymentIntentId)
      .limit(1)

    if (planError) {
      logWarning('api.payment.context_missing', {
        route,
        paymentIntentId,
        reason: 'funding_ref_lookup_error',
        detail: planError.message,
      })
      return null
    }

    const fundingJobId = (planRows?.[0] as { job_id: string | null } | undefined)?.job_id ?? null

    if (fundingJobId) {
      const { data: corridorRows, error: corridorError } = await admin
        .from('payments')
        .select('id, job_id, provider_ref, status')
        .eq('job_id', fundingJobId)
        .order('created_at', { ascending: true })
        .limit(1)

      if (corridorError) {
        logWarning('api.payment.context_missing', {
          route,
          paymentIntentId,
          reason: 'funding_ref_payment_lookup_error',
          detail: corridorError.message,
        })
        return null
      }

      paymentRow = corridorRows?.[0] as
        | { id: string; job_id: string | null; provider_ref: string | null; status: string | null }
        | undefined

      if (paymentRow) {
        logInfo('api.payment.context_resolved_via_funding_ref', {
          route,
          paymentIntentId,
          paymentId: paymentRow.id,
          jobId: fundingJobId,
        })
      }
    }
  }

  if (!paymentRow) {
    logWarning('api.payment.context_missing', {
      route,
      paymentIntentId,
      reason: 'payment_not_found',
    })
    return null
  }

  if (!paymentRow.job_id) {
    logWarning('api.payment.context_invalid', {
      route,
      paymentId: paymentRow.id,
      paymentIntentId,
      reason: 'payment_has_no_job_id',
    })
    return null
  }

  // Step 2: fetch job to resolve ownership
  const { data: jobRows, error: jobError } = await admin
    .from('jobs')
    .select('id, customer_user_id, provider_id')
    .eq('id', paymentRow.job_id)
    .limit(1)

  if (jobError) {
    logWarning('api.payment.context_invalid', {
      route,
      paymentId: paymentRow.id,
      paymentIntentId,
      jobId: paymentRow.job_id,
      reason: 'job_db_error',
      detail: jobError.message,
    })
    return null
  }

  const jobRow = jobRows?.[0] as
    | { id: string; customer_user_id: string | null; provider_id: string | null }
    | undefined

  if (!jobRow) {
    logWarning('api.payment.context_invalid', {
      route,
      paymentId: paymentRow.id,
      paymentIntentId,
      jobId: paymentRow.job_id,
      reason: 'job_not_found',
    })
    return null
  }

  return {
    paymentId: paymentRow.id,
    paymentIntentId,
    jobId: jobRow.id,
    customerUserId: jobRow.customer_user_id,
    craftsmanUserId: jobRow.provider_id,
    paymentStatus: paymentRow.status ?? null,
  }
}

// ---------------------------------------------------------------------------
// Operator check
// ---------------------------------------------------------------------------

/**
 * Checks whether the given user has operator elevation (profiles.is_operator = true).
 *
 * Returns false on any error (fail closed).
 */
export async function fetchIsOperator(
  userId: string,
  admin: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await admin
    .from('profiles')
    .select('is_operator')
    .eq('id', userId)
    .limit(1)
    .single()

  if (error || !data) return false
  return (data as { is_operator: boolean }).is_operator === true
}

// ---------------------------------------------------------------------------
// Authorization predicates
// ---------------------------------------------------------------------------

/**
 * Authorizes a capture-escrow (payment release) action.
 *
 * Only the customer who owns the linked job may capture the escrow.
 * Craftsmen and unrelated authenticated users are denied.
 */
export function canCaptureEscrowForPayment(
  userId: string,
  context: PaymentContext,
  route: string,
): boolean {
  const allowed = context.customerUserId !== null && context.customerUserId === userId

  if (allowed) {
    logInfo('api.payment.authorization_verified', {
      route,
      action: 'capture_escrow',
      userId,
      paymentId: context.paymentId,
      jobId: context.jobId,
      callerRole: 'customer',
    })
  } else {
    logWarning('api.payment.authorization_failed', {
      route,
      action: 'capture_escrow',
      userId,
      paymentId: context.paymentId,
      jobId: context.jobId,
      reason:
        context.customerUserId === null
          ? 'no_customer_on_job'
          : 'caller_is_not_customer',
    })
  }

  return allowed
}

/**
 * Authorizes a refund-escrow action.
 *
 * Allowed callers:
 *   - The customer who owns the linked job  (e.g. pre-work cancellation)
 *   - An operator (profiles.is_operator = true)  (e.g. dispute resolution)
 *
 * Craftsmen and unrelated authenticated users are denied.
 */
export function canRefundEscrowForPayment(
  userId: string,
  context: PaymentContext,
  isOperator: boolean,
  route: string,
): boolean {
  const isCustomer = context.customerUserId !== null && context.customerUserId === userId
  const allowed = isCustomer || isOperator

  let callerRole: 'customer' | 'operator' | 'none'
  if (isOperator) {
    callerRole = 'operator'
  } else if (isCustomer) {
    callerRole = 'customer'
  } else {
    callerRole = 'none'
  }

  if (allowed) {
    logInfo('api.payment.authorization_verified', {
      route,
      action: 'refund_escrow',
      userId,
      paymentId: context.paymentId,
      jobId: context.jobId,
      callerRole,
    })
  } else {
    logWarning('api.payment.authorization_failed', {
      route,
      action: 'refund_escrow',
      userId,
      paymentId: context.paymentId,
      jobId: context.jobId,
      callerRole,
      reason:
        context.customerUserId === null
          ? 'no_customer_on_job'
          : 'caller_is_not_customer_or_operator',
    })
  }

  return allowed
}
