/**
 * Escrow Payment Plan Repository — Interface
 *
 * Persistence contract for escrow payment plans and their tranches.
 * Implementations: InMemory (tests/dev), Supabase (production).
 */

import type { EscrowPaymentPlan, EscrowTranche } from './escrowTypes.js'

export interface EscrowPlanRepository {
  /** One-time async initialisation (e.g. fetch from Supabase). */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryEscrowPlanRepository this is always `true` (data is available
   * at construction time).
   */
  isHydrated(): boolean

  // ── Plans ──────────────────────────────────────────────────────────────

  /** Return all escrow plans. */
  getAllPlans(): EscrowPaymentPlan[]

  /** Find a plan by its unique ID. */
  getPlanById(planId: string): EscrowPaymentPlan | undefined

  /** Find a plan by the source offer ID (accepted quote). */
  getPlanByOfferId(offerId: string): EscrowPaymentPlan | undefined

  /** Find a plan by its linked job ID. */
  getPlanByJobId(jobId: string): EscrowPaymentPlan | undefined

  /** Persist a new plan. */
  addPlan(plan: EscrowPaymentPlan): Promise<void>

  /** Update an existing plan in-place. */
  updatePlan(planId: string, updater: (plan: EscrowPaymentPlan) => EscrowPaymentPlan): Promise<void>

  // ── Tranches ───────────────────────────────────────────────────────────

  /** Return all tranches for a given plan. */
  getTranchesForPlan(planId: string): EscrowTranche[]

  /** Persist a new tranche. */
  addTranche(tranche: EscrowTranche): Promise<void>

  /** Update an existing tranche in-place. */
  updateTranche(trancheId: string, updater: (tranche: EscrowTranche) => EscrowTranche): Promise<void>

  /** Subscribe to data changes (both plans and tranches). */
  subscribe(listener: () => void): () => void
}
