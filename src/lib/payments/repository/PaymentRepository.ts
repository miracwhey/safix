import type { Payment } from '../types.js'

export interface PaymentRepository {
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryPaymentRepository this is always `true` (data is available at
   * construction time).
   * For SupabasePaymentRepository this becomes `true` after the first
   * `initialize()` call completes.
   */
  isHydrated(): boolean

  getAll(): Payment[]
  getByJobId(jobId: string): Payment | undefined
  add(payment: Payment): Promise<void>
  update(paymentId: string, updater: (payment: Payment) => Payment): Promise<void>
  subscribe(listener: () => void): () => void

  /**
   * Atomically commits a terminal payment state transition to the DB.
   *
   * For SupabasePaymentRepository: calls the `finalize_payment_state_atomic`
   * PostgreSQL RPC, which updates payments + jobs.payment_state +
   * jobs.status (waiting_payment → completed) + projects.payment_state in one
   * transaction.  Updates the local cache on success without a second DB write.
   *
   * For InMemoryPaymentRepository: applies the state change locally (no RPC).
   *
   * CONTRACT
   * --------
   * - Must be called AFTER the Stripe provider call has succeeded (point of no return).
   * - On failure: throws — caller MUST handle (provider already executed).
   * - On idempotent re-call (payment already in target state): returns existing payment.
   *
   * @param jobId       - Job whose payment should be finalized
   * @param targetState - Terminal state: 'released' | 'refunded'
   * @param options     - disputeId bypasses the dispute guard for dispute-resolved releases
   */
  finalizeStateAtomic(
    jobId: string,
    targetState: 'released' | 'refunded',
    options?: { disputeId?: string; actor?: string; refundedAmount?: number }
  ): Promise<Payment>
}
