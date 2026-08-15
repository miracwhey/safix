/**
 * Funding Request — Service Layer
 *
 * Provides idempotent creation and query operations for funding requests.
 *
 * Key invariants:
 * - No funding request without an accepted quote (sourceOfferId)
 * - No funding request without a linked escrow plan (escrowPlanId)
 * - Exactly one funding request per escrow plan (idempotent via escrowPlanId)
 * - Funding request is always tied to a job
 */

import type { FundingRequest, FundingRequestStatus } from './types.js'
import { getFundingRequestRepository } from './fundingRequestRegistry.js'
import { generateUUID } from '../../shared/generateUUID.js'

// Funding requests expire 14 days after creation if not funded.
export const FUNDING_REQUEST_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000

// ── Query Functions ───────────────────────────────────────────────────────

/**
 * Returns `true` once the funding request repository has completed its
 * initial data load.  Used by screens to distinguish "not loaded yet" from
 * "genuinely does not exist" without resorting to a timeout.
 */
export function isFundingRequestRepositoryHydrated(): boolean {
  return getFundingRequestRepository().isHydrated()
}

export function subscribeFundingRequests(listener: () => void): () => void {
  return getFundingRequestRepository().subscribe(listener)
}

/** Get a funding request by its unique ID. */
export function getFundingRequestById(id: string): FundingRequest | undefined {
  return getFundingRequestRepository().getById(id)
}

/** Get a funding request by the escrow plan it funds. */
export function getFundingRequestByPlanId(escrowPlanId: string): FundingRequest | undefined {
  return getFundingRequestRepository().getByEscrowPlanId(escrowPlanId)
}

/** Get a funding request by the job it is linked to. */
export function getFundingRequestByJobId(jobId: string): FundingRequest | undefined {
  return getFundingRequestRepository().getByJobId(jobId)
}

/** Get a funding request by its source offer. */
export function getFundingRequestByOfferId(offerId: string): FundingRequest | undefined {
  return getFundingRequestRepository().getByOfferId(offerId)
}

/** Get all funding requests. */
export function getAllFundingRequests(): FundingRequest[] {
  return getFundingRequestRepository().getAll()
}

// ── Selectors ─────────────────────────────────────────────────────────────

/** Human-readable label for a funding request status. */
export function getFundingRequestStatusLabel(status: FundingRequestStatus): string {
  switch (status) {
    case 'created': return 'Erstellt'
    case 'sent': return 'Gesendet'
    case 'funding_started': return 'Einzahlung gestartet'
    case 'funding_initiated': return 'Einzahlung eingeleitet'
    case 'funded': return 'Finanziert'
    case 'funding_failed': return 'Einzahlung fehlgeschlagen'
    case 'expired': return 'Abgelaufen'
    case 'cancelled': return 'Storniert'
  }
}

// ── Core Idempotent Creation ──────────────────────────────────────────────

/**
 * Ensures a funding request exists for the given escrow plan.
 *
 * Idempotent: if a funding request already exists for the escrow plan,
 * returns the existing one without creating a duplicate.
 *
 * @param params.sourceOfferId   — ID of the accepted offer
 * @param params.jobId           — ID of the linked job
 * @param params.escrowPlanId    — ID of the escrow payment plan
 * @param params.customerUserId  — Supabase user_id of the customer
 * @param params.providerUserId  — Supabase user_id of the provider
 * @param params.amount          — Amount to be funded
 * @param params.currency        — Currency code (default 'EUR')
 * @param params.conversationId  — Optional thread linkage
 *
 * @returns The existing or newly created funding request
 */
export async function ensureFundingRequest(params: {
  sourceOfferId: string
  jobId: string
  escrowPlanId: string
  customerUserId: string
  providerUserId: string
  providerId: string
  amount: number
  currency?: string
  conversationId?: string
}): Promise<FundingRequest> {
  const repo = getFundingRequestRepository()

  // Idempotent check: funding request already exists for this escrow plan
  const existing = repo.getByEscrowPlanId(params.escrowPlanId)
  if (existing) return existing

  // Fail clearly when required persisted identifiers are missing.
  // The live schema requires provider_id (UUID FK) — never create a malformed row.
  if (!params.providerId) {
    throw new Error(
      `ensureFundingRequest: providerId is required but was empty (jobId=${params.jobId})`
    )
  }

  const now = Date.now()

  const request: FundingRequest = {
    id: generateUUID(),
    sourceOfferId: params.sourceOfferId,
    jobId: params.jobId,
    escrowPlanId: params.escrowPlanId,
    customerUserId: params.customerUserId,
    providerId: params.providerId,
    providerUserId: params.providerUserId,
    type: 'full_escrow',
    status: 'created',
    amount: params.amount,
    currency: params.currency ?? 'EUR',
    createdBy: 'provider',
    conversationId: params.conversationId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + FUNDING_REQUEST_EXPIRY_MS,
  }

  await repo.add(request)
  return request
}

// ── Status Transitions ────────────────────────────────────────────────────

/**
 * Mark a funding request as sent to the customer.
 * Idempotent: no-op if already sent or beyond.
 */
export async function markFundingRequestSent(requestId: string, messageId?: string): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  // Idempotent: skip if already sent or beyond
  if (request.status !== 'created') return request

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'sent' as const,
    sentAt: now,
    messageId: messageId ?? r.messageId,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}

/**
 * Record that the customer has started the funding flow.
 * Idempotent: no-op if already started or beyond.
 */
export async function markFundingStarted(requestId: string): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  if (request.status !== 'sent' && request.status !== 'created') return request

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'funding_started' as const,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}

/**
 * Record that funding has been initiated with an external provider (e.g. Stripe).
 * Stores external reference and idempotency key.
 * Idempotent: no-op if already initiated or beyond.
 */
export async function markFundingInitiated(requestId: string, params?: {
  externalFundingRef?: string
  fundingIdempotencyKey?: string
}): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  // Idempotent: skip if already initiated or beyond
  if (request.status !== 'funding_started' && request.status !== 'sent' && request.status !== 'created') {
    return request
  }

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'funding_initiated' as const,
    externalFundingRef: params?.externalFundingRef ?? r.externalFundingRef,
    fundingIdempotencyKey: params?.fundingIdempotencyKey ?? r.fundingIdempotencyKey,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}

/**
 * Record that funding has been completed.
 * Idempotent: no-op if already funded.
 */
export async function markFundingCompleted(requestId: string): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  if (request.status === 'funded') return request

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'funded' as const,
    fundedAt: now,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}

/**
 * Record that a funding attempt has failed.
 * Can be retried from this state.
 * Idempotent: no-op if already funded.
 */
export async function markFundingFailed(requestId: string, failureReason?: string): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  // Cannot fail if already funded
  if (request.status === 'funded') return request

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'funding_failed' as const,
    failureReason: failureReason ?? r.failureReason,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}

/**
 * Cancel a funding request.
 * Idempotent: no-op if already cancelled or funded.
 */
export async function markFundingCancelled(requestId: string): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  // Cannot cancel if already funded
  if (request.status === 'funded' || request.status === 'cancelled') return request

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'cancelled' as const,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}

/**
 * Mark a funding request as expired.
 * Called by the server-side expiry cron and available for manual expiry.
 * Idempotent: no-op if already funded, cancelled, or expired.
 */
export async function markFundingRequestExpired(requestId: string): Promise<FundingRequest | undefined> {
  const repo = getFundingRequestRepository()
  const request = repo.getById(requestId)
  if (!request) return undefined

  // funding_initiated has a live Stripe PaymentIntent — never expire it automatically.
  // funded / cancelled / expired are terminal — no-op.
  if (
    request.status === 'funded' ||
    request.status === 'cancelled' ||
    request.status === 'expired' ||
    request.status === 'funding_initiated'
  ) {
    return request
  }

  const now = Date.now()
  await repo.update(requestId, (r) => ({
    ...r,
    status: 'expired' as const,
    updatedAt: now,
  }))
  return repo.getById(requestId)
}
