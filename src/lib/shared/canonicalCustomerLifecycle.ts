/**
 * Canonical Customer Lifecycle Projection
 *
 * Central resolver for customer-facing lifecycle/status projection.
 * All customer surfaces must derive state from this module to ensure
 * cross-surface consistency.
 *
 * ── Canonical Lifecycle Hierarchy ──────────────────────────────────
 *
 *   inquiry / request only
 *   → offer sent / waiting customer acceptance
 *   → accepted / booked order
 *   → funding required / escrow requested
 *   → funding in progress
 *   → funded / payment confirmed
 *   → work in progress
 *   → work completed / release pending
 *   → partially released
 *   → payment released / completed
 *   → cancelled
 *
 * ── Canonical Dominance Rule ──────────────────────────────────────
 *
 * Stronger downstream truth always dominates weaker upstream defaults:
 *
 *   1. EscrowPlan status   (funded_in_escrow, partially_released, fully_released)
 *   2. FundingRequest status (funded, sent, created, funding_started, ...)
 *   3. Job status + proposal lifecycle (in_progress, scheduled, accepted, ...)
 *   4. Payment state from job (deposit_required, release_pending, ...)
 *   5. Project.status — weak fallback only when no linked job exists
 *
 * A funded context must never project as payment-required.
 * An accepted/booked context must never project as inquiry/request.
 * A work-in-progress context must never project stale pre-payment state.
 */

import { getJobById } from '../jobs'
import { getPaymentForJob, isPaymentRepositoryHydrated } from '../payments/service'
import { deriveProjectStatusFromJob } from '../projects/projectStatusSync'
import { isFundingConfirmedForJob } from '../payments/fundingRequest/fundingDominance'
import type { Project, ProjectStatus } from '../projects/projectTypes'
import type { PaymentState } from './coreTypes'

// ── Types ─────────────────────────────────────────────────────────────────

export type CanonicalProjection = {
  /** Customer-facing project status derived from strongest available source */
  status: ProjectStatus
  /** Payment state derived from job (or project fallback) */
  paymentState: PaymentState
  /** Whether canonical funded truth exists for this context */
  fundingConfirmed: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Payment states that are stale/pre-funded — must yield to funded truth. */
const STALE_PRE_FUNDED_STATES: ReadonlySet<PaymentState> = new Set([
  'none',
  'deposit_required',
])

/**
 * Resolves the effective payment state for a job, applying funded dominance.
 *
 * When canonical funded truth exists (FundingRequest = funded OR EscrowPlan
 * = funded_in_escrow/partially_released/fully_released) and the downstream
 * job.paymentState is still a stale pre-funded value, the canonical payment
 * record's state is used instead.  This ensures that a funded context never
 * projects as payment-outstanding on any customer/provider surface.
 *
 * Pure function — no mutations.
 */
function resolveEffectivePaymentState(
  jobId: string,
  downstreamPaymentState: PaymentState,
  fundingConfirmed: boolean
): PaymentState {
  if (!fundingConfirmed) return downstreamPaymentState
  if (!STALE_PRE_FUNDED_STATES.has(downstreamPaymentState)) return downstreamPaymentState

  // Funded truth exists but downstream is stale — read canonical payment record
  const payment = getPaymentForJob(jobId)
  if (payment && !STALE_PRE_FUNDED_STATES.has(payment.state)) {
    return payment.state
  }

  // Funding confirmed but the payment record is missing or still pre-funded.
  // If the payment repository has not finished loading we cannot distinguish
  // "record genuinely absent" from "record not yet arrived" — asserting
  // deposit_paid before hydration completes would produce a false-positive
  // funded state on list screens and the customer home surface.
  // Once the repository is hydrated the missing-record edge case is real (rare:
  // FundingRequest/EscrowPlan advanced ahead of the Payment record), and
  // deposit_paid is the correct minimum funded floor.
  if (!isPaymentRepositoryHydrated()) return downstreamPaymentState
  return 'deposit_paid'
}

// ── Resolver ──────────────────────────────────────────────────────────────

/**
 * Derives the canonical customer-facing status and payment state for a project.
 *
 * When a linked job exists, job state dominates stale project-level fields.
 * This prevents the common failure where project.status remains 'request'
 * after the job has already moved to accepted/funded/in_progress.
 *
 * Funded dominance: when canonical funded truth exists, stale pre-funded
 * payment states (none, deposit_required) are overridden by the canonical
 * payment record or a minimum funded floor.
 */
export function deriveCanonicalProjection(project: Project): CanonicalProjection {
  // No linked job → project-level fields are the only truth available
  if (!project.sourceJobId) {
    return {
      status: project.status,
      paymentState: project.paymentState,
      fundingConfirmed: false,
    }
  }

  const job = getJobById(project.sourceJobId)
  if (!job) {
    // Job not loaded yet — fall back to project-level fields
    return {
      status: project.status,
      paymentState: project.paymentState,
      fundingConfirmed: false,
    }
  }

  const fundingConfirmed = isFundingConfirmedForJob(project.sourceJobId)
  const paymentState = resolveEffectivePaymentState(
    project.sourceJobId,
    job.paymentState,
    fundingConfirmed
  )

  return {
    status: deriveProjectStatusFromJob(job),
    paymentState,
    fundingConfirmed,
  }
}
