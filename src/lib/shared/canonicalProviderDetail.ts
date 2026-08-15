/**
 * Canonical Provider Detail Model
 *
 * Composes canonical facts, provider phase, next action, and commercial
 * information into one coherent model for provider-facing detail surfaces.
 *
 * Provider screens MUST consume this model (or its underlying resolvers)
 * instead of assembling facts ad-hoc from raw job fields.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * COMPOSITION
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   facts       — resolveCanonicalProjectFacts()  (Block 1)
 *   amount      — resolveCanonicalAmount()        (Block 1)
 *   phase       — deriveProviderJobPhase()         (provider lifecycle)
 *   nextAction  — deriveProviderNextAction()       (provider next step)
 *   commercial  — escrow/funding context for provider trust & clarity
 *
 * This model does NOT introduce a second source of truth.
 * It is a read-only composition of existing canonical resolvers.
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  resolveCanonicalProjectFacts,
  type CanonicalProjectFacts,
} from './canonicalProjectFacts'
import { resolveCanonicalAmount, type CanonicalAmount } from './canonicalAmountResolver'
import {
  deriveProviderJobPhase,
  PROVIDER_PHASE_CONFIG,
  type ProviderPhaseViewModel,
  type ProviderPhaseConfig,
} from '../jobs/providerJobPhaseSelectors'
import {
  deriveProviderNextAction,
  type ProviderNextAction,
} from '../jobs/providerNextActionSelectors'
import { getJobById } from '../jobs/service'
import { getFundingRequestByJobId } from '../payments/fundingRequest'
import { getEscrowPlanByJobId } from '../payments/escrow'
import { formatEuro } from './formatters'

// ── Types ─────────────────────────────────────────────────────────────────

export type ProviderCommercialContext = {
  /** Canonical order value (from escrow → offer → job) */
  canonicalAmount: CanonicalAmount
  /** Escrow total when an escrow plan exists (euros), null otherwise */
  escrowAmount: number | null
  /** Escrow total formatted, empty string if no escrow */
  escrowAmountFormatted: string
  /** Whether escrow plan and canonical amount agree */
  amountsAligned: boolean
}

export type CanonicalProviderDetail = {
  /** Canonical factual fields (title, customer, location, dateLabel, amount, linkage) */
  facts: CanonicalProjectFacts
  /** Provider operational phase view model */
  phase: ProviderPhaseViewModel
  /** Provider phase display config (label, icon, badge, dot) */
  phaseConfig: ProviderPhaseConfig
  /** Provider next action (actionId, label, description, enabled) */
  nextAction: ProviderNextAction
  /** Commercial / payment context for the provider */
  commercial: ProviderCommercialContext
}

// ── Resolver ──────────────────────────────────────────────────────────────

/**
 * Resolves the full canonical provider detail model for a job.
 *
 * Returns null if the job does not exist or facts cannot be resolved.
 */
export function resolveCanonicalProviderDetail(jobId: string): CanonicalProviderDetail | null {
  const job = getJobById(jobId)
  if (!job) return null

  const facts = resolveCanonicalProjectFacts(jobId)
  if (!facts) return null

  const fundingRequest = getFundingRequestByJobId(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)

  const phase = deriveProviderJobPhase(job, fundingRequest?.status, escrowPlan?.status)
  const phaseConfig = PROVIDER_PHASE_CONFIG[phase.phase]
  const nextAction = deriveProviderNextAction(job, fundingRequest?.status, escrowPlan?.status)

  const canonicalAmount = resolveCanonicalAmount(jobId)
  const escrowAmount = escrowPlan && escrowPlan.totalAmount > 0 ? escrowPlan.totalAmount : null
  const escrowAmountFormatted = escrowAmount !== null ? formatEuro(escrowAmount) : ''

  // Amounts are aligned when escrow total matches canonical amount,
  // or when no escrow plan exists (canonical amount stands alone).
  const amountsAligned =
    escrowAmount === null ||
    canonicalAmount.amount === null ||
    escrowAmount === canonicalAmount.amount

  return {
    facts,
    phase,
    phaseConfig,
    nextAction,
    commercial: {
      canonicalAmount,
      escrowAmount,
      escrowAmountFormatted,
      amountsAligned,
    },
  }
}
