/**
 * Escrow Payment Plan — Service Layer
 *
 * Provides idempotent creation and query operations for escrow payment
 * plans and their release tranches.
 *
 * Key invariants:
 * - No plan without an accepted quote (sourceOfferId)
 * - No plan without a linked job (jobId)
 * - Exactly two tranches per plan: deposit_release (25%) + final_release (75%)
 * - Idempotent: re-calling ensureEscrowPlan with the same offerId returns the existing plan
 * - Amounts always derive from the accepted quote price
 * - 25/75 is RELEASE logic, not customer payment split logic
 * - Customer funds 100% upfront; tranches control release timing
 */

import type {
  EscrowPaymentPlan,
  EscrowTranche,
  EscrowPlanStatus,
  EscrowTrancheStatus,
  EscrowActor,
} from './escrowTypes.js'
import { getEscrowPlanRepository } from './escrowRegistry.js'
import { generateUUID } from '../../shared/generateUUID.js'
import type { ProviderPayoutAccount } from '../../payout/types.js'
import { isProviderPayoutReady } from '../../payout/providerPaymentReadiness.js'
import { resolveJobFeeRateStrict } from '../../shared/feeRate.js'

// ── Constants ─────────────────────────────────────────────────────────────

/** Deposit release: 25% of the total. */
const DEPOSIT_RELEASE_PERCENT = 25

/** Final release: 75% of the total. */
const FINAL_RELEASE_PERCENT = 75

// ── Amount Calculation (rounding-safe) ────────────────────────────────────

/**
 * Calculate tranche amounts ensuring they always sum exactly to the total.
 * The 25% tranche is calculated first and rounded; the 75% tranche gets
 * the remainder. This prevents cent drift.
 */
export function calculateTrancheAmounts(totalAmount: number): {
  depositAmount: number
  finalAmount: number
} {
  const depositAmount = Number(((totalAmount * DEPOSIT_RELEASE_PERCENT) / 100).toFixed(2))
  const finalAmount = Number((totalAmount - depositAmount).toFixed(2))
  return { depositAmount, finalAmount }
}

// ── Query Functions ───────────────────────────────────────────────────────

/**
 * Returns `true` once the escrow plan repository has completed its initial
 * data load.  Used by screens to distinguish "not loaded yet" from
 * "genuinely does not exist" without resorting to a timeout.
 */
export function isEscrowPlanRepositoryHydrated(): boolean {
  return getEscrowPlanRepository().isHydrated()
}

export function subscribeEscrowPlans(listener: () => void): () => void {
  return getEscrowPlanRepository().subscribe(listener)
}

/** Get an escrow plan by the accepted offer that created it. */
export function getEscrowPlanByOfferId(offerId: string): EscrowPaymentPlan | undefined {
  return getEscrowPlanRepository().getPlanByOfferId(offerId)
}

/** Get an escrow plan by its linked job ID. */
export function getEscrowPlanByJobId(jobId: string): EscrowPaymentPlan | undefined {
  return getEscrowPlanRepository().getPlanByJobId(jobId)
}

/** Get an escrow plan by its unique plan ID. */
export function getEscrowPlanById(planId: string): EscrowPaymentPlan | undefined {
  return getEscrowPlanRepository().getPlanById(planId)
}

/** Get the release tranches for a given plan. */
export function getEscrowTranches(planId: string): EscrowTranche[] {
  return getEscrowPlanRepository().getTranchesForPlan(planId)
}

// ── Escrow Plan Selectors ─────────────────────────────────────────────────

/** Human-readable label for a plan status. */
export function getEscrowPlanStatusLabel(status: EscrowPlanStatus): string {
  switch (status) {
    case 'awaiting_customer_funding': return 'Zahlung ausstehend'
    case 'funding_initiated': return 'Einzahlung gestartet'
    case 'funded_in_escrow': return 'Vollständig über Stripe abgesichert'
    case 'partially_released': return 'Teilweise freigegeben'
    case 'fully_released': return 'Vollständig freigegeben'
    case 'funding_failed': return 'Einzahlung fehlgeschlagen'
    case 'disputed': return 'Konflikt'
    case 'refunded': return 'Erstattet'
    case 'cancelled': return 'Storniert'
  }
}

/** Human-readable label for a tranche status. */
export function getEscrowTrancheStatusLabel(status: EscrowTrancheStatus): string {
  switch (status) {
    case 'pending_funding': return 'Einzahlung ausstehend'
    case 'funded': return 'Im Stripe-Absicherung'
    case 'locked': return 'Gesperrt'
    case 'eligible_for_release': return 'Freigabefähig'
    case 'release_pending': return 'Freigabe beantragt'
    case 'released': return 'Freigegeben'
    case 'blocked': return 'Blockiert'
    case 'disputed': return 'Im Konflikt'
    case 'refunded': return 'Erstattet'
    case 'cancelled': return 'Storniert'
  }
}

// ── Core Idempotent Creation ──────────────────────────────────────────────

/**
 * Ensures an escrow payment plan exists for the given accepted offer.
 *
 * Idempotent: if a plan already exists for sourceOfferId, returns the
 * existing plan and does NOT create duplicate plans or tranches.
 *
 * @param params.sourceOfferId  — ID of the accepted offer (source of truth)
 * @param params.jobId          — ID of the job created from acceptance
 * @param params.customerUserId — Supabase user_id of the customer
 * @param params.providerId     — providers.id DB UUID of the craftsman
 * @param params.totalAmount    — Total contract amount from the accepted quote
 *
 * @returns The existing or newly created escrow payment plan
 */
export async function ensureEscrowPlan(params: {
  sourceOfferId: string
  jobId: string
  customerUserId: string
  providerId: string
  totalAmount: number
}): Promise<EscrowPaymentPlan> {
  const repo = getEscrowPlanRepository()

  // Idempotent check: plan already exists for this offer
  const existing = repo.getPlanByOfferId(params.sourceOfferId)
  if (existing) return existing

  const now = Date.now()

  // Lock the fee rate at plan creation — this is the contract moment.
  // Storing it in the plan eliminates client-side fee derivation in
  // moneyFlowProjection and other display projections.
  //
  // Fail closed on unresolved attribution: the locked rate is immutable, so a
  // merchant_brought (5 %) job whose attribution has not yet finalized must
  // NOT get the display-safe 9 % default frozen into the plan. This mirrors the
  // server gate (api/_attributionGuard.ts / api/_feeRate.ts), which blocks all
  // money movement until attribution_status = 'finalized'. Plan creation
  // defers (throws) and is retried idempotently once attribution finalizes.
  const platformFeeRate = resolveJobFeeRateStrict(params.jobId)
  const platformFeeAmount = Number((params.totalAmount * platformFeeRate).toFixed(2))

  const plan: EscrowPaymentPlan = {
    id: generateUUID(),
    sourceOfferId: params.sourceOfferId,
    jobId: params.jobId,
    customerUserId: params.customerUserId,
    providerId: params.providerId,
    currency: 'EUR',
    totalAmount: params.totalAmount,
    platformFeeRate,
    platformFeeAmount,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'awaiting_customer_funding',
    createdAt: now,
    updatedAt: now,
  }

  await repo.addPlan(plan)

  // Create the two V1 tranches with rounding-safe amounts
  const { depositAmount, finalAmount } = calculateTrancheAmounts(params.totalAmount)

  const depositTranche: EscrowTranche = {
    id: generateUUID(),
    planId: plan.id,
    kind: 'deposit_release',
    percentage: DEPOSIT_RELEASE_PERCENT,
    amount: depositAmount,
    releaseTrigger: 'work_started',
    status: 'pending_funding',
    createdAt: now,
    updatedAt: now,
  }

  const finalTranche: EscrowTranche = {
    id: generateUUID(),
    planId: plan.id,
    kind: 'final_release',
    percentage: FINAL_RELEASE_PERCENT,
    amount: finalAmount,
    releaseTrigger: 'work_completed',
    status: 'pending_funding',
    createdAt: now,
    updatedAt: now,
  }

  await repo.addTranche(depositTranche)
  await repo.addTranche(finalTranche)

  return plan
}

// ── Funding State Transitions ─────────────────────────────────────────────

/**
 * Transition plan to funding_initiated when customer starts escrow payment.
 * Idempotent: no-op if already past awaiting_customer_funding.
 */
export async function initiateFunding(planId: string, params?: {
  externalFundingRef?: string
  fundingIdempotencyKey?: string
}): Promise<EscrowPaymentPlan | undefined> {
  const repo = getEscrowPlanRepository()
  const plan = repo.getPlanById(planId)
  if (!plan) return undefined

  // Idempotent: skip if already funded or beyond
  if (plan.status !== 'awaiting_customer_funding' && plan.status !== 'funding_failed') {
    return plan
  }

  const now = Date.now()
  await repo.updatePlan(planId, (p) => ({
    ...p,
    status: 'funding_initiated' as const,
    fundingInitiatedAt: now,
    externalFundingRef: params?.externalFundingRef ?? p.externalFundingRef,
    fundingIdempotencyKey: params?.fundingIdempotencyKey ?? p.fundingIdempotencyKey,
    updatedAt: now,
  }))
  return repo.getPlanById(planId)
}

/**
 * Confirm that full escrow funding has been received.
 * Transitions plan to funded_in_escrow and all tranches to funded.
 * Idempotent: no-op if already funded.
 */
export async function confirmFunding(planId: string, params?: {
  externalFundingRef?: string
}): Promise<EscrowPaymentPlan | undefined> {
  const repo = getEscrowPlanRepository()
  const plan = repo.getPlanById(planId)
  if (!plan) return undefined

  // Idempotent: already funded
  if (plan.status === 'funded_in_escrow' || plan.status === 'partially_released' || plan.status === 'fully_released') {
    return plan
  }

  const now = Date.now()
  await repo.updatePlan(planId, (p) => ({
    ...p,
    status: 'funded_in_escrow' as const,
    fundedAt: now,
    externalFundingRef: params?.externalFundingRef ?? p.externalFundingRef,
    updatedAt: now,
  }))

  // Transition all pending_funding tranches to funded
  const tranches = repo.getTranchesForPlan(planId)
  for (const t of tranches) {
    if (t.status === 'pending_funding') {
      await repo.updateTranche(t.id, (tr) => ({
        ...tr,
        status: 'funded' as const,
        updatedAt: now,
      }))
    }
  }

  return repo.getPlanById(planId)
}

/**
 * Mark funding as failed. Can be retried from this state.
 */
export async function failFunding(planId: string): Promise<EscrowPaymentPlan | undefined> {
  const repo = getEscrowPlanRepository()
  const plan = repo.getPlanById(planId)
  if (!plan) return undefined

  if (plan.status !== 'funding_initiated' && plan.status !== 'awaiting_customer_funding') {
    return plan
  }

  const now = Date.now()
  await repo.updatePlan(planId, (p) => ({
    ...p,
    status: 'funding_failed' as const,
    updatedAt: now,
  }))
  return repo.getPlanById(planId)
}

// ── Role-Safe Release Trigger Execution ───────────────────────────────────

/** Valid plan statuses for tranche release transitions. */
const RELEASE_ELIGIBLE_PLAN_STATUSES: ReadonlySet<EscrowPlanStatus> = new Set([
  'funded_in_escrow',
  'partially_released',
])

/**
 * Record that work has started.
 *
 * Actor rule: only 'provider' can trigger work_started.
 * Effect: deposit_release tranche becomes eligible_for_release.
 * Idempotent: no-op if tranche is already eligible or released.
 */
export async function recordWorkStarted(planId: string, actor: EscrowActor): Promise<{
  plan: EscrowPaymentPlan
  tranche: EscrowTranche
} | { error: string }> {
  if (actor !== 'provider') {
    return { error: 'Only the provider can record work_started.' }
  }

  const repo = getEscrowPlanRepository()
  const plan = repo.getPlanById(planId)
  if (!plan) return { error: 'Plan not found.' }

  if (!RELEASE_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
    return { error: `Cannot record work_started: plan status is '${plan.status}'.` }
  }

  const tranches = repo.getTranchesForPlan(planId)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')
  if (!depositTranche) return { error: 'Deposit release tranche not found.' }

  // Idempotent: already eligible or beyond
  if (depositTranche.status === 'eligible_for_release' || depositTranche.status === 'release_pending' || depositTranche.status === 'released') {
    return { plan, tranche: depositTranche }
  }

  if (depositTranche.status !== 'funded') {
    return { error: `Cannot mark deposit tranche eligible: status is '${depositTranche.status}'.` }
  }

  const now = Date.now()
  await repo.updateTranche(depositTranche.id, (t) => ({
    ...t,
    status: 'eligible_for_release' as const,
    eligibleAt: now,
    triggeredBy: actor,
    updatedAt: now,
  }))

  return {
    plan: repo.getPlanById(planId)!,
    tranche: repo.getTranchesForPlan(planId).find((t) => t.kind === 'deposit_release')!,
  }
}

/**
 * Record that work has been completed.
 *
 * Actor rule: only 'provider' can trigger work_completed.
 * Effect: final_release tranche becomes eligible_for_release.
 * Idempotent: no-op if tranche is already eligible or released.
 */
export async function recordWorkCompleted(planId: string, actor: EscrowActor): Promise<{
  plan: EscrowPaymentPlan
  tranche: EscrowTranche
} | { error: string }> {
  if (actor !== 'provider') {
    return { error: 'Only the provider can record work_completed.' }
  }

  const repo = getEscrowPlanRepository()
  const plan = repo.getPlanById(planId)
  if (!plan) return { error: 'Plan not found.' }

  if (!RELEASE_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
    return { error: `Cannot record work_completed: plan status is '${plan.status}'.` }
  }

  const tranches = repo.getTranchesForPlan(planId)
  const finalTranche = tranches.find((t) => t.kind === 'final_release')
  if (!finalTranche) return { error: 'Final release tranche not found.' }

  // Idempotent: already eligible or beyond
  if (finalTranche.status === 'eligible_for_release' || finalTranche.status === 'release_pending' || finalTranche.status === 'released') {
    return { plan, tranche: finalTranche }
  }

  if (finalTranche.status !== 'funded') {
    return { error: `Cannot mark final tranche eligible: status is '${finalTranche.status}'.` }
  }

  const now = Date.now()
  await repo.updateTranche(finalTranche.id, (t) => ({
    ...t,
    status: 'eligible_for_release' as const,
    eligibleAt: now,
    triggeredBy: actor,
    updatedAt: now,
  }))

  return {
    plan: repo.getPlanById(planId)!,
    tranche: repo.getTranchesForPlan(planId).find((t) => t.kind === 'final_release')!,
  }
}

/**
 * Release a tranche (transfer funds to provider).
 *
 * Actor rule: only 'customer' or 'system' can release.
 * Payout gating: if providerPayoutAccount is provided, release is blocked
 * when the provider is not payout-ready. This enforces the product rule
 * that payout/release REQUIRES completed Stripe Connect.
 *
 * Idempotent: no-op if already released.
 * Updates plan status to partially_released or fully_released as appropriate.
 */
export async function releaseTranche(trancheId: string, actor: EscrowActor, params?: {
  externalReleaseRef?: string
  providerPayoutAccount?: ProviderPayoutAccount | null
}): Promise<{
  plan: EscrowPaymentPlan
  tranche: EscrowTranche
} | { error: string }> {
  if (actor !== 'customer' && actor !== 'system') {
    return { error: 'Only the customer or system can release tranches.' }
  }

  // Payout readiness gating: block release if provider cannot receive payout
  if (params?.providerPayoutAccount !== undefined) {
    if (!isProviderPayoutReady(params.providerPayoutAccount)) {
      return { error: 'Release blocked: provider payout account is not ready. Stripe Connect onboarding must be completed before funds can be released.' }
    }
  }

  const repo = getEscrowPlanRepository()
  const allPlans = repo.getAllPlans()

  // Find the tranche and its plan
  let foundTranche: EscrowTranche | undefined
  let foundPlan: EscrowPaymentPlan | undefined
  for (const p of allPlans) {
    const tranches = repo.getTranchesForPlan(p.id)
    const t = tranches.find((tr) => tr.id === trancheId)
    if (t) {
      foundTranche = t
      foundPlan = p
      break
    }
  }

  if (!foundTranche || !foundPlan) return { error: 'Tranche not found.' }

  // Idempotent: already released
  if (foundTranche.status === 'released') {
    return { plan: foundPlan, tranche: foundTranche }
  }

  if (foundTranche.status !== 'eligible_for_release' && foundTranche.status !== 'release_pending') {
    return { error: `Cannot release tranche: status is '${foundTranche.status}'.` }
  }

  const now = Date.now()
  await repo.updateTranche(trancheId, (t) => ({
    ...t,
    status: 'released' as const,
    releasedAt: now,
    externalReleaseRef: params?.externalReleaseRef ?? t.externalReleaseRef,
    releasedBy: actor,
    updatedAt: now,
  }))

  // Check if all tranches are released to update plan status
  const updatedTranches = repo.getTranchesForPlan(foundPlan.id)
  const allReleased = updatedTranches.every((t) => t.status === 'released')
  const anyReleased = updatedTranches.some((t) => t.status === 'released')

  if (allReleased) {
    await repo.updatePlan(foundPlan.id, (p) => ({
      ...p,
      status: 'fully_released' as const,
      updatedAt: now,
    }))
  } else if (anyReleased) {
    await repo.updatePlan(foundPlan.id, (p) => ({
      ...p,
      status: 'partially_released' as const,
      updatedAt: now,
    }))
  }

  return {
    plan: repo.getPlanById(foundPlan.id)!,
    tranche: repo.getTranchesForPlan(foundPlan.id).find((t) => t.id === trancheId)!,
  }
}

/**
 * Derives the escrow plan summary for a given accepted offer.
 *
 * Returns null if no escrow plan exists for the offer.
 * Used by UI surfaces to display persisted payment plan state.
 */
export function deriveEscrowPlanSummary(offerId: string): {
  plan: EscrowPaymentPlan
  tranches: EscrowTranche[]
  depositTranche: EscrowTranche | undefined
  finalTranche: EscrowTranche | undefined
} | null {
  const plan = getEscrowPlanByOfferId(offerId)
  if (!plan) return null

  const tranches = getEscrowTranches(plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')
  const finalTranche = tranches.find((t) => t.kind === 'final_release')

  return { plan, tranches, depositTranche, finalTranche }
}
