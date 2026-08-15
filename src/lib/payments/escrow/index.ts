/**
 * Escrow Payment Plan — Barrel Export
 *
 * Re-exports types, repository access, and service functions for the
 * escrow payment plan domain.
 */

export * from './escrowTypes.js'
export type { EscrowPlanRepository } from './escrowRepository.js'
export { InMemoryEscrowPlanRepository } from './InMemoryEscrowPlanRepository.js'
export { SupabaseEscrowPlanRepository } from './SupabaseEscrowPlanRepository.js'
export {
  getEscrowPlanRepository,
  setEscrowPlanRepository,
  initializeEscrowPlanRepository,
} from './escrowRegistry.js'
export {
  isTriggerSatisfied,
  isEffectivelyEligible,
  WORK_STARTED_SATISFIED,
  WORK_COMPLETED_SATISFIED,
} from './trancheTrigger.js'
export {
  ensureEscrowPlan,
  getEscrowPlanByOfferId,
  getEscrowPlanByJobId,
  getEscrowPlanById,
  getEscrowTranches,
  getEscrowPlanStatusLabel,
  getEscrowTrancheStatusLabel,
  deriveEscrowPlanSummary,
  calculateTrancheAmounts,
  initiateFunding,
  confirmFunding,
  failFunding,
  recordWorkStarted,
  recordWorkCompleted,
  releaseTranche,
  isEscrowPlanRepositoryHydrated,
  subscribeEscrowPlans,
} from './escrowService.js'
