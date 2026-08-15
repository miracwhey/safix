/**
 * Craftsman Operations — Real provider-side job operation commands.
 *
 * These are the canonical entry points for provider actions:
 *   1. requestFundingForJob(jobId)
 *   2. startJob(jobId)
 *   3. completeJob(jobId)
 *
 * Each command:
 * - Validates current state/guards
 * - Returns a typed result (success or error with reason)
 * - Delegates to existing workflow functions for persistence + side effects
 * - Is fully idempotent on retries
 */

import { getJobById, getJobs, linkJobToSourceOffer, parseJobAmount, type Job } from '../jobs'
import { findCanonicalOverride } from '../jobs/canonicalJobResolver'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
  ensureEscrowPlan,
  type EscrowPaymentPlan,
} from '../payments/escrow'
import {
  getFundingRequestByJobId,
} from '../payments/fundingRequest'
import { getOfferById, getAcceptedOfferByJobId } from '../offers/service'
import {
  requestFundingWorkflow,
  startJobWorkflow,
  markWorkCompleteWorkflow,
} from './jobWorkflow'
import { jobKindAllowsStandardExecution } from '../offers/commercialDocumentPolicy'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type OperationSuccess<T = Record<string, unknown>> = {
  ok: true
  data: T
}

export type OperationError = {
  ok: false
  code: CraftsmanOperationErrorCode
  message: string
}

export type OperationResult<T = Record<string, unknown>> =
  | OperationSuccess<T>
  | OperationError

export type CraftsmanOperationErrorCode =
  | 'JOB_NOT_FOUND'
  | 'NO_ACCEPTED_QUOTE'
  | 'NO_ESCROW_PLAN'
  | 'ESCROW_RECOVERY_FAILED'
  | 'SOURCE_OFFER_MISSING'
  | 'FUNDING_ALREADY_COMPLETED'
  | 'FUNDING_NOT_CONFIRMED'
  | 'JOB_ALREADY_STARTED'
  | 'JOB_NOT_STARTED'
  | 'JOB_ALREADY_COMPLETED'
  | 'JOB_IN_TERMINAL_STATE'
  | 'DISPUTE_BLOCKING'
  | 'INVALID_STATE_TRANSITION'
  /**
   * Paket 2: the job's documentType-derived kind does not allow standard
   * execution (payment/escrow/startJob/completeJob corridor).
   * estimate_tracking and diagnosis jobs are blocked from standard execution.
   */
  | 'JOB_KIND_DISALLOWS_EXECUTION'

// ---------------------------------------------------------------------------
// 1. requestFundingForJob
// ---------------------------------------------------------------------------

export type RequestFundingResult = {
  fundingRequestId: string
  status: string
  amount: number
}

/**
 * Provider requests escrow funding for a job.
 *
 * Guards:
 * - Job must exist
 * - Quote must be accepted (proposalAcceptedAt set)
 * - Escrow plan must exist or be recoverable from accepted offer
 * - No duplicate — returns existing funding request if already created
 * - Cannot request if job is in a terminal state
 *
 * Recovery: If the escrow plan is missing but the job has a valid accepted
 * offer with all required data, the plan is recovered exactly once via
 * ensureEscrowPlan (idempotent). This handles legacy jobs and reload
 * scenarios where the plan was not persisted or loaded.
 *
 * Idempotent: repeated calls return the existing funding request.
 */
export async function requestFundingForJob(
  jobId: string
): Promise<OperationResult<RequestFundingResult>> {
  const job = getJobById(jobId)
  if (!job) {
    return { ok: false, code: 'JOB_NOT_FOUND', message: 'Auftrag nicht gefunden.' }
  }

  // Canonical redirect: if this is a stale duplicate, redirect to the
  // canonical accepted job that is linked to the accepted offer.
  const canonicalOverride = findCanonicalOverride(jobId, getJobs())
  if (canonicalOverride) {
    return requestFundingForJob(canonicalOverride.id)
  }

  if (isTerminalState(job)) {
    return { ok: false, code: 'JOB_IN_TERMINAL_STATE', message: 'Auftrag ist bereits abgeschlossen oder storniert.' }
  }

  if (isDisputeBlocking(job)) {
    return { ok: false, code: 'DISPUTE_BLOCKING', message: 'Ein offener Streitfall blockiert diese Aktion.' }
  }

  if (!job.proposalAcceptedAt && job.status !== 'booked') {
    return { ok: false, code: 'NO_ACCEPTED_QUOTE', message: 'Es liegt kein angenommenes Angebot vor.' }
  }

  // Paket 2: jobKind guard — estimate_tracking and diagnosis jobs must NOT
  // enter the standard payment/escrow/execution corridor.
  // This check must run BEFORE the escrow plan lookup to prevent accidental
  // escrow plan creation via tryRecoverEscrowPlan on non-standard jobs.
  if (!jobKindAllowsStandardExecution(job.jobKind)) {
    const kindLabel = job.jobKind === 'diagnosis'
      ? 'Diagnose-Auftrag'
      : 'Schätzungs-Verfolgungsauftrag'
    return {
      ok: false,
      code: 'JOB_KIND_DISALLOWS_EXECUTION',
      message: `${kindLabel} — dieser Auftragstyp erlaubt keine Standard-Zahlung oder -Ausführung. Kein Zahlungskorridor verfügbar.`,
    }
  }

  // Canonical escrow plan lookup: by jobId first, then by sourceOfferId
  let escrowPlan = getEscrowPlanByJobId(jobId)
    ?? (job.sourceOfferId ? getEscrowPlanByOfferId(job.sourceOfferId) : undefined)

  // Recovery: if plan is missing but all canonical data is present, recover once
  if (!escrowPlan) {
    const recovered = await tryRecoverEscrowPlan(job)
    if (!recovered.ok) {
      return recovered
    }
    escrowPlan = recovered.plan
  }

  // Idempotent: if already funded, return existing state
  const existingFunding = getFundingRequestByJobId(jobId)
  if (existingFunding?.status === 'funded') {
    return {
      ok: true,
      data: {
        fundingRequestId: existingFunding.id,
        status: existingFunding.status,
        amount: existingFunding.amount,
      },
    }
  }

  // Delegate to existing workflow (handles all persistence + side effects)
  const result = await requestFundingWorkflow(jobId)
  if (!result) {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', message: 'Zahlungsaufforderung konnte nicht erstellt werden.' }
  }

  return { ok: true, data: result }
}

// ---------------------------------------------------------------------------
// 2. startJob
// ---------------------------------------------------------------------------

export type StartJobResult = {
  job: Job
  tranche25Eligible: boolean
}

/**
 * Provider starts work on a job.
 *
 * Guards:
 * - Job must exist
 * - Funding must be confirmed (funded_in_escrow)
 * - Job must not already be started (idempotent: returns existing state)
 * - No dispute blocking
 * - No terminal state
 *
 * Side effects:
 * - Job status → in_progress
 * - 25% deposit_release tranche → eligible_for_release
 * - Timeline event: work_started
 * - Calendar update if exists
 */
export async function startJob(
  jobId: string
): Promise<OperationResult<StartJobResult>> {
  const job = getJobById(jobId)
  if (!job) {
    return { ok: false, code: 'JOB_NOT_FOUND', message: 'Auftrag nicht gefunden.' }
  }

  // Idempotent: already started
  if (job.status === 'in_progress') {
    return {
      ok: true,
      data: { job, tranche25Eligible: true },
    }
  }

  if (isTerminalState(job)) {
    return { ok: false, code: 'JOB_IN_TERMINAL_STATE', message: 'Auftrag ist bereits abgeschlossen oder storniert.' }
  }

  if (isDisputeBlocking(job)) {
    return { ok: false, code: 'DISPUTE_BLOCKING', message: 'Ein offener Streitfall blockiert diese Aktion.' }
  }

  // Paket 2: jobKind guard — estimate_tracking and diagnosis jobs must NOT
  // enter the standard execution corridor via startJob.
  if (!jobKindAllowsStandardExecution(job.jobKind)) {
    const kindLabel = job.jobKind === 'diagnosis'
      ? 'Diagnose-Auftrag'
      : 'Schätzungs-Verfolgungsauftrag'
    return {
      ok: false,
      code: 'JOB_KIND_DISALLOWS_EXECUTION',
      message: `${kindLabel} — dieser Auftragstyp erlaubt keine Standard-Ausführung. Diagnose-Aufträge nutzen den Diagnose-Pfad.`,
    }
  }

  // Guard: funding must be confirmed before work can start
  const escrowPlan = getEscrowPlanByJobId(jobId)
  const fundingRequest = getFundingRequestByJobId(jobId)

  const isFunded = escrowPlan?.status === 'funded_in_escrow' || fundingRequest?.status === 'funded'
  if (!isFunded) {
    return { ok: false, code: 'FUNDING_NOT_CONFIRMED', message: 'Die Zahlung ist noch nicht bestätigt.' }
  }

  // Guard: can only start from new/booked/scheduled (not waiting_payment/completed)
  if (job.status !== 'new' && job.status !== 'booked' && job.status !== 'scheduled') {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', message: `Arbeit kann aus dem Status "${job.status}" nicht gestartet werden.` }
  }

  const updated = await startJobWorkflow(jobId)
  if (!updated) {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', message: 'Arbeit konnte nicht gestartet werden.' }
  }

  return {
    ok: true,
    data: { job: updated, tranche25Eligible: true },
  }
}

// ---------------------------------------------------------------------------
// 3. completeJob
// ---------------------------------------------------------------------------

export type CompleteJobResult = {
  job: Job
  tranche75Eligible: boolean
}

/**
 * Provider marks work as completed on a job.
 *
 * Guards:
 * - Job must exist
 * - Job must be in_progress (not new/scheduled/completed)
 * - Job must not already be completed (idempotent: returns existing state)
 * - No terminal state
 *
 * Side effects:
 * - workCompletedAt is stamped
 * - 75% final_release tranche → eligible_for_release
 * - Job status → waiting_payment
 * - Timeline event: work_completed
 * - Invoice creation
 */
export async function completeJob(
  jobId: string
): Promise<OperationResult<CompleteJobResult>> {
  const job = getJobById(jobId)
  if (!job) {
    return { ok: false, code: 'JOB_NOT_FOUND', message: 'Auftrag nicht gefunden.' }
  }

  // Idempotent: already completed
  if (job.workCompletedAt) {
    const currentJob = getJobById(jobId)
    return {
      ok: true,
      data: { job: currentJob ?? job, tranche75Eligible: true },
    }
  }

  if (isTerminalState(job)) {
    return { ok: false, code: 'JOB_IN_TERMINAL_STATE', message: 'Auftrag ist bereits abgeschlossen oder storniert.' }
  }

  // Paket 2: jobKind guard — estimate_tracking and diagnosis jobs must NOT
  // enter the standard completion corridor via completeJob.
  if (!jobKindAllowsStandardExecution(job.jobKind)) {
    const kindLabel = job.jobKind === 'diagnosis'
      ? 'Diagnose-Auftrag'
      : 'Schätzungs-Verfolgungsauftrag'
    return {
      ok: false,
      code: 'JOB_KIND_DISALLOWS_EXECUTION',
      message: `${kindLabel} — dieser Auftragstyp erlaubt keinen Standard-Abschluss.`,
    }
  }

  // Guard: work must be in progress to complete
  if (job.status !== 'in_progress') {
    return { ok: false, code: 'JOB_NOT_STARTED', message: 'Die Arbeit wurde noch nicht gestartet.' }
  }

  const updated = await markWorkCompleteWorkflow(jobId)
  if (!updated) {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', message: 'Arbeit konnte nicht abgeschlossen werden.' }
  }

  return {
    ok: true,
    data: { job: updated, tranche75Eligible: true },
  }
}

// ---------------------------------------------------------------------------
// Escrow plan recovery
// ---------------------------------------------------------------------------

/**
 * Attempts to recover an escrow plan for a valid accepted job.
 *
 * Recovery is strict: all canonical data must be present:
 * - accepted offer (source_offer_id)
 * - customer identity
 * - provider identity
 * - amount derivable from the accepted quote
 *
 * Returns a typed result: either the recovered plan or a precise error
 * explaining which required data is missing.
 *
 * Idempotent: delegates to ensureEscrowPlan which is itself idempotent.
 */
async function tryRecoverEscrowPlan(
  job: Job
): Promise<{ ok: true; plan: EscrowPaymentPlan } | OperationError> {
  // Guard: must have source offer linkage — attempt canonical recovery first
  let sourceOfferId = job.sourceOfferId
  if (!sourceOfferId) {
    const recovered = await tryRecoverSourceOffer(job)
    if (!recovered) {
      return { ok: false, code: 'SOURCE_OFFER_MISSING', message: 'Angebotszuordnung (source_offer_id) fehlt – Zahlungsplan kann nicht wiederhergestellt werden.' }
    }
    sourceOfferId = recovered
  }

  // Guard: must have customer identity
  if (!job.customerUserId) {
    return { ok: false, code: 'ESCROW_RECOVERY_FAILED', message: 'Kundenzuordnung fehlt – Zahlungsplan kann nicht erstellt werden.' }
  }

  // Guard: must have provider identity
  const providerId = job.providerId ?? job.craftsmanUserId
  if (!providerId) {
    return { ok: false, code: 'ESCROW_RECOVERY_FAILED', message: 'Handwerkerzuordnung fehlt – Zahlungsplan kann nicht erstellt werden.' }
  }

  // Guard: must have an amount — try offer first, then job.amount
  const offer = getOfferById(sourceOfferId)

  // Paket 2: never recover an escrow plan for a non-standard job.
  // If job.jobKind is set (Paket 2+), use it directly.
  // If job.jobKind is absent (legacy), check the source offer's documentType.
  // An estimate or diagnosis offer must not trigger escrow plan creation.
  if (!jobKindAllowsStandardExecution(job.jobKind)) {
    return {
      ok: false,
      code: 'JOB_KIND_DISALLOWS_EXECUTION',
      message: 'Escrow-Plan kann nicht wiederhergestellt werden: Job-Typ erlaubt keinen Standard-Zahlungskorridor.',
    }
  }
  if (job.jobKind == null && offer != null) {
    // Legacy job without jobKind — check the source offer's documentType
    const offerType = offer.documentType ?? 'binding_offer'
    if (offerType === 'estimate' || offerType === 'diagnosis') {
      return {
        ok: false,
        code: 'JOB_KIND_DISALLOWS_EXECUTION',
        message: `Escrow-Plan kann nicht wiederhergestellt werden: Quell-Angebot ist '${offerType}' — kein Zahlungskorridor.`,
      }
    }
  }

  const parsedAmount = parseJobAmount(offer?.price) ?? parseJobAmount(job.amount)
  if (parsedAmount === null || parsedAmount <= 0) {
    return { ok: false, code: 'ESCROW_RECOVERY_FAILED', message: 'Auftragswert fehlt oder ungültig – Zahlungsplan kann nicht erstellt werden.' }
  }

  // All canonical data present — recover the plan (idempotent)
  const plan = await ensureEscrowPlan({
    sourceOfferId,
    jobId: job.id,
    customerUserId: job.customerUserId,
    providerId,
    totalAmount: parsedAmount,
  })

  return { ok: true, plan }
}

/**
 * Attempts to recover the source offer linkage for a job that is missing
 * `sourceOfferId`.  Uses the strongest canonical reverse lookup:
 * `offers.createdJobId === job.id` with `status === 'accepted'`.
 *
 * If exactly one accepted offer matches, the linkage is persisted on the
 * job (idempotent) and the offer ID is returned.
 *
 * Returns `undefined` if no match or multiple matches (ambiguous).
 */
async function tryRecoverSourceOffer(job: Job): Promise<string | undefined> {
  const canonicalOffer = getAcceptedOfferByJobId(job.id)
  if (!canonicalOffer) return undefined

  // Persist the recovered linkage so future calls skip recovery
  await linkJobToSourceOffer(job.id, canonicalOffer.id)
  return canonicalOffer.id
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

function isTerminalState(job: Job): boolean {
  return job.status === 'completed' || job.status === 'cancelled'
}

function isDisputeBlocking(job: Job): boolean {
  return (
    job.disputeStatus === 'open' ||
    job.disputeStatus === 'under_review' ||
    job.disputeStatus === 'customer_waiting' ||
    job.disputeStatus === 'provider_waiting'
  )
}
