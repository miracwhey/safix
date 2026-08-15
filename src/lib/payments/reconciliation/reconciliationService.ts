import { getPaymentForJob, updatePaymentState } from '../service.js'
import { logInfo, logWarning, logError } from '../../observability/index.js'
import { derivePaymentReconciliationStatus } from './deriveReconciliationStatus.js'
import type { Payment } from '../types.js'
import type { StripePaymentSnapshot, ReconciliationResult } from './types.js'

/**
 * Compares an in-memory Payment against a Stripe snapshot and produces a
 * structured reconciliation result, with observability events.
 *
 * Does NOT mutate state — use recoverMissedStripeState for recovery.
 */
export function reconcilePaymentAgainstStripe(
  payment: Payment,
  stripe: StripePaymentSnapshot,
): ReconciliationResult {
  logInfo('payment.reconciliation.started', {
    paymentId: payment.id,
    jobId: payment.jobId,
    dbState: payment.state,
    stripeStatus: stripe.stripeStatus,
    paymentIntentId: stripe.paymentIntentId,
  })

  const result = derivePaymentReconciliationStatus(payment, stripe)

  switch (result.status) {
    case 'aligned':
      logInfo('payment.reconciliation.noop', {
        paymentId: payment.id,
        jobId: payment.jobId,
        dbState: payment.state,
        stripeStatus: stripe.stripeStatus,
        note: result.note,
      })
      break

    case 'recoverable':
      logInfo('payment.reconciliation.recoverable', {
        paymentId: payment.id,
        jobId: payment.jobId,
        dbState: payment.state,
        recommendedState: result.recommendedState,
        stripeStatus: stripe.stripeStatus,
        note: result.note,
      })
      break

    case 'inconsistent':
      logWarning('payment.reconciliation.inconsistent', {
        paymentId: payment.id,
        jobId: payment.jobId,
        dbState: payment.state,
        stripeStatus: stripe.stripeStatus,
        note: result.note,
      })
      break

    case 'no_provider_ref':
    case 'not_found':
      logWarning(`payment.reconciliation.${result.status}`, {
        paymentId: payment.id,
        note: result.note,
      })
      break
  }

  return result
}

/**
 * Attempts to recover a payment that is behind Stripe's actual state.
 *
 * Safe recovery rules:
 * - Only advances state (never rolls back)
 * - Only applies transitions that are valid per the state machine
 * - Returns a result with status 'recovered' (augmented) if applied, or the
 *   original result if no action was taken
 *
 * This function is idempotent: calling it multiple times for an already-
 * recovered payment will result in 'aligned' (no further mutations).
 */
export async function recoverMissedStripeState(
  payment: Payment,
  stripe: StripePaymentSnapshot,
): Promise<ReconciliationResult & { recovered: boolean }> {
  const result = reconcilePaymentAgainstStripe(payment, stripe)

  if (result.status !== 'recoverable' || !result.recommendedState) {
    return { ...result, recovered: false }
  }

  try {
    await updatePaymentState(payment.jobId, result.recommendedState)

    logInfo('payment.reconciliation.recovered', {
      paymentId: payment.id,
      jobId: payment.jobId,
      previousState: result.dbState,
      newState: result.recommendedState,
      stripeStatus: stripe.stripeStatus,
      paymentIntentId: stripe.paymentIntentId,
    })

    return {
      ...result,
      recovered: true,
      note: `Recovered: advanced from '${result.dbState}' to '${result.recommendedState}' based on Stripe status '${stripe.stripeStatus}'.`,
    }
  } catch (err) {
    logError('payment.reconciliation.failed', err, {
      paymentId: payment.id,
      jobId: payment.jobId,
      dbState: result.dbState,
      recommendedState: result.recommendedState,
      stripeStatus: stripe.stripeStatus,
    })

    return {
      ...result,
      status: 'inconsistent',
      recovered: false,
      note: `Recovery attempted but failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Convenience: look up a payment by jobId and reconcile it against a Stripe snapshot.
 * Returns a not_found result if no payment exists for the job.
 */
export function reconcileJobPaymentAgainstStripe(
  jobId: string,
  stripe: StripePaymentSnapshot,
): ReconciliationResult {
  const payment = getPaymentForJob(jobId)

  if (!payment) {
    logWarning('payment.reconciliation.not_found', { jobId, paymentIntentId: stripe.paymentIntentId })
    return {
      paymentId: `unknown:${jobId}`,
      jobId,
      status: 'not_found',
      dbState: 'deposit_required',
      note: `No payment found for jobId '${jobId}'.`,
      reconciledAt: new Date().toISOString(),
    }
  }

  if (!payment.providerRef) {
    logInfo('payment.reconciliation.no_provider_ref', { paymentId: payment.id, jobId })
    return {
      paymentId: payment.id,
      jobId,
      status: 'no_provider_ref',
      dbState: payment.state,
      note: `Payment '${payment.id}' has no providerRef — Stripe not involved yet.`,
      reconciledAt: new Date().toISOString(),
    }
  }

  return reconcilePaymentAgainstStripe(payment, stripe)
}
