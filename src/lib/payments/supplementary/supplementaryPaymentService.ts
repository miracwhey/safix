/**
 * Supplementary Payment Request — Service Layer
 *
 * Query and mutation functions for SupplementaryPaymentRequest entities.
 *
 * Key invariants:
 * - At most one SupplementaryPaymentRequest per ChangeOrder (idempotent create).
 * - Only positive deltas create a request (negative deltas = credit, no request needed).
 * - Status transitions are one-directional and idempotent.
 *
 * Status machine:
 *   pending → funding_initiated → funded → released      (platform Stripe path)
 *   pending → acknowledged → funding_initiated → funded → released
 *   pending → acknowledged → paid                        (manual off-platform)
 *   pending | acknowledged → waived                      (craftsman waives)
 */

import type { SupplementaryPaymentRequest, SupplementaryPaymentStatus } from './types.js'
import { getSupplementaryPaymentRepository } from './supplementaryPaymentRegistry.js'
import { generateUUID } from '../../shared/generateUUID.js'
import { ensureTimelineEvent } from '../../timeline/timelineService.js'

// ── Hydration ─────────────────────────────────────────────────────────────────

export function isSupplementaryPaymentRepositoryHydrated(): boolean {
  return getSupplementaryPaymentRepository().isHydrated()
}

// ── Subscribe ──────────────────────────────────────────────────────────────────

export function subscribeSupplementaryPayments(listener: () => void): () => void {
  return getSupplementaryPaymentRepository().subscribe(listener)
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getSupplementaryPaymentById(id: string): SupplementaryPaymentRequest | undefined {
  return getSupplementaryPaymentRepository().getById(id)
}

export function getSupplementaryPaymentByChangeOrderId(
  changeOrderId: string
): SupplementaryPaymentRequest | undefined {
  return getSupplementaryPaymentRepository().getByChangeOrderId(changeOrderId)
}

export function getSupplementaryPaymentsByJobId(
  jobId: string
): SupplementaryPaymentRequest[] {
  return getSupplementaryPaymentRepository().getByJobId(jobId)
}

export function getAllSupplementaryPayments(): SupplementaryPaymentRequest[] {
  return getSupplementaryPaymentRepository().getAll()
}

// ── Human-readable labels ──────────────────────────────────────────────────────

export function getSupplementaryPaymentStatusLabel(status: SupplementaryPaymentStatus): string {
  switch (status) {
    case 'pending': return 'Offen'
    case 'acknowledged': return 'Bestätigt'
    case 'funding_initiated': return 'Zahlung gestartet'
    case 'funded': return 'Bezahlt (Plattform)'
    case 'released': return 'Ausgezahlt'
    case 'paid': return 'Bezahlt'
    case 'waived': return 'Erlassen'
  }
}

// ── Idempotent creation ───────────────────────────────────────────────────────

/**
 * Creates a supplementary payment request for a locked-payment ChangeOrder acceptance.
 *
 * Idempotent: if a request already exists for this ChangeOrder, returns the existing one.
 * Only creates a request for positive deltas (amountCents > 0).
 *
 * @returns The created or existing SupplementaryPaymentRequest, or null if skipped
 *          (non-positive amount or already exists in terminal state).
 */
export async function ensureSupplementaryPaymentRequest(params: {
  changeOrderId: string
  jobId: string
  originalPaymentId: string
  customerUserId: string
  craftsmanUserId: string
  amountCents: number
  currency?: string
}): Promise<SupplementaryPaymentRequest | null> {
  // Only create for positive deltas — negative deltas are credits, not debts
  if (params.amountCents <= 0) return null

  const repo = getSupplementaryPaymentRepository()

  // Idempotent: return existing if one already exists for this ChangeOrder
  const existing = repo.getByChangeOrderId(params.changeOrderId)
  if (existing) return existing

  const now = Date.now()
  const request: SupplementaryPaymentRequest = {
    id: generateUUID(),
    changeOrderId: params.changeOrderId,
    jobId: params.jobId,
    originalPaymentId: params.originalPaymentId,
    customerUserId: params.customerUserId,
    craftsmanUserId: params.craftsmanUserId,
    amountCents: params.amountCents,
    currency: params.currency ?? 'EUR',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }

  await repo.add(request)
  return request
}

// ── Status Transitions ────────────────────────────────────────────────────────

/**
 * Customer acknowledges the supplementary payment obligation.
 * Idempotent: no-op if already acknowledged or beyond.
 */
export async function acknowledgeSupplementaryPayment(
  id: string
): Promise<SupplementaryPaymentRequest | undefined> {
  const repo = getSupplementaryPaymentRepository()
  const request = repo.getById(id)
  if (!request) return undefined

  if (request.status !== 'pending') return request

  const now = Date.now()
  await repo.update(id, (r) => ({
    ...r,
    status: 'acknowledged' as const,
    acknowledgedAt: now,
    updatedAt: now,
  }))
  ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_acknowledged' })
  return repo.getById(id)
}

/**
 * Marks a supplementary payment as funding_initiated (Stripe PaymentIntent created).
 *
 * Valid from: pending, acknowledged, funding_initiated (idempotent resume).
 * Stores the Stripe PaymentIntent ID as externalRef.
 */
export async function initiateSupplementaryFunding(
  id: string,
  externalRef: string
): Promise<SupplementaryPaymentRequest | undefined> {
  const repo = getSupplementaryPaymentRepository()
  const request = repo.getById(id)
  if (!request) return undefined

  // Already in a terminal state — no-op
  if (request.status === 'funded' || request.status === 'paid' || request.status === 'waived') {
    return request
  }

  // Idempotent: if already funding_initiated with same externalRef, no-op
  if (request.status === 'funding_initiated' && request.externalRef === externalRef) {
    return request
  }

  const now = Date.now()
  await repo.update(id, (r) => ({
    ...r,
    status: 'funding_initiated' as const,
    externalRef,
    fundingInitiatedAt: now,
    updatedAt: now,
  }))
  ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_funding_initiated' })
  return repo.getById(id)
}

/**
 * Marks a supplementary payment as funded (Stripe payment completed via platform).
 *
 * Valid from: funding_initiated, pending, acknowledged (webhook may arrive before client update).
 * Idempotent: no-op if already funded, released, paid, or waived.
 */
export async function markSupplementaryFunded(
  id: string,
  externalRef?: string
): Promise<SupplementaryPaymentRequest | undefined> {
  const repo = getSupplementaryPaymentRepository()
  const request = repo.getById(id)
  if (!request) return undefined

  // Already at or past funded — no-op
  if (request.status === 'funded' || request.status === 'released' || request.status === 'paid' || request.status === 'waived') {
    return request
  }

  const now = Date.now()
  await repo.update(id, (r) => ({
    ...r,
    status: 'funded' as const,
    fundedAt: now,
    ...(externalRef != null && { externalRef }),
    updatedAt: now,
  }))
  ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_funded' })
  return repo.getById(id)
}

/**
 * Marks a supplementary payment as released (net amount transferred to craftsman).
 *
 * Valid from: funded only. Stores the Stripe Transfer ID as proof of fund movement.
 * Idempotent: no-op if already released, paid, or waived.
 */
export async function markSupplementaryReleased(
  id: string,
  externalPayoutRef: string
): Promise<SupplementaryPaymentRequest | undefined> {
  const repo = getSupplementaryPaymentRepository()
  const request = repo.getById(id)
  if (!request) return undefined

  // Already terminal — no-op
  if (request.status === 'released' || request.status === 'paid' || request.status === 'waived') {
    return request
  }

  // Only advance from funded
  if (request.status !== 'funded') return request

  const now = Date.now()
  await repo.update(id, (r) => ({
    ...r,
    status: 'released' as const,
    releasedAt: now,
    externalPayoutRef,
    updatedAt: now,
  }))
  ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_released' })
  return repo.getById(id)
}

/**
 * Craftsman confirms the additional payment has been received (manual/off-platform path).
 * Idempotent: no-op if already paid, funded, released, or waived.
 */
export async function markSupplementaryPaymentPaid(
  id: string
): Promise<SupplementaryPaymentRequest | undefined> {
  const repo = getSupplementaryPaymentRepository()
  const request = repo.getById(id)
  if (!request) return undefined

  if (request.status === 'paid' || request.status === 'funded' || request.status === 'released' || request.status === 'waived') return request

  const now = Date.now()
  await repo.update(id, (r) => ({
    ...r,
    status: 'paid' as const,
    paidAt: now,
    updatedAt: now,
  }))
  ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_paid' })
  return repo.getById(id)
}

/**
 * Craftsman waives the supplementary payment obligation.
 * Idempotent: no-op if already paid, funded, released, or waived.
 */
export async function waiiveSupplementaryPayment(
  id: string
): Promise<SupplementaryPaymentRequest | undefined> {
  const repo = getSupplementaryPaymentRepository()
  const request = repo.getById(id)
  if (!request) return undefined

  if (request.status === 'paid' || request.status === 'funded' || request.status === 'released' || request.status === 'waived') return request

  const now = Date.now()
  await repo.update(id, (r) => ({
    ...r,
    status: 'waived' as const,
    waivedAt: now,
    updatedAt: now,
  }))
  ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_waived' })
  return repo.getById(id)
}

// ── Timeline reconciliation ──────────────────────────────────────────────────

/**
 * Ensures timeline events exist for all supplementary status transitions
 * that the entity has already reached, based on its timestamps.
 *
 * Covers server-side transitions (funded via webhook, released via auto-release)
 * that bypass the client service layer.  Safe to call on every render/update —
 * ensureTimelineEvent is idempotent (hasEventOfType guard + hydration guard).
 */
export function reconcileSupplementaryTimelineEvents(
  request: SupplementaryPaymentRequest
): void {
  if (request.acknowledgedAt) {
    ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_acknowledged' })
  }
  if (request.fundingInitiatedAt) {
    ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_funding_initiated' })
  }
  if (request.fundedAt) {
    ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_funded' })
  }
  if (request.releasedAt) {
    ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_released' })
  }
  if (request.paidAt) {
    ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_paid' })
  }
  if (request.waivedAt) {
    ensureTimelineEvent({ jobId: request.jobId, type: 'supplementary_waived' })
  }
}

// ── Derived state helpers ─────────────────────────────────────────────────────

/** Returns true if the supplementary payment request is in a terminal state. */
export function isSupplementaryPaymentTerminal(status: SupplementaryPaymentStatus): boolean {
  return status === 'released' || status === 'paid' || status === 'waived'
}

/** Returns true if the customer can initiate Stripe funding for this request. */
export function canInitiateSupplementaryFunding(status: SupplementaryPaymentStatus): boolean {
  return status === 'pending' || status === 'acknowledged' || status === 'funding_initiated'
}
