import type { Job } from './types'
import type { Payment } from '../payments/types'
import { formatEuro } from '../payments/selectors'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'
import { parseJobAmount } from './parseJobAmount'
import { getEscrowPlanByJobId, calculateTrancheAmounts } from '../payments/escrow'
import type { EscrowPlanStatus } from '../payments/escrow/escrowTypes'

// Re-export so existing barrel consumers are not broken.
export { parseJobAmount } from './parseJobAmount'

/**
 * Describes where a craftsman stands in the payment/deposit preparation path
 * after a proposal has been accepted.
 *
 * 'missing_amount'       – proposal accepted but no parseable agreed amount on
 *                          the job; the craftsman must set the amount first.
 * 'ready_to_confirm'     – amount present but the deposit card has not yet been
 *                          initialized with the agreed amount. Craftsman should
 *                          confirm/initialize the deposit setup.
 * 'deposit_initialized'  – payment card initialized with the correct agreed
 *                          amount; deposit is at `deposit_required` state
 *                          (awaiting customer deposit).
 * 'deposit_confirmed'    – customer deposit has been received; payment is in
 *                          `deposit_paid` or a later state.
 */
export type PaymentPrepPhase =
  | 'missing_amount'
  | 'ready_to_confirm'
  | 'deposit_initialized'
  | 'deposit_confirmed'

export type PaymentPrepViewModel = {
  /** Current payment preparation phase */
  phase: PaymentPrepPhase
  /** Short human-readable label */
  phaseLabel: string
  /** Guidance text explaining what should happen next */
  phaseDescription: string
  /** Agreed total amount parsed from the job, or null if unparseable */
  agreedAmount: number | null
  /** Pre-formatted agreed amount string (e.g. "640,00 €") */
  agreedAmountFormatted: string | null
  /** Deposit amount (25% of agreed total), or null if amount unknown */
  depositAmount: number | null
  /** Pre-formatted deposit amount string */
  depositAmountFormatted: string | null
  /** Final (remaining) amount (75% of agreed total), or null if amount unknown */
  finalAmount: number | null
  /** Pre-formatted final amount string */
  finalAmountFormatted: string | null
  /** Deposit percentage (always 25 when amounts are present) */
  depositPercent: number
  /**
   * Whether the craftsman should be prompted to confirm/initialize the deposit
   * card. False once the payment has been initialized with the agreed amount.
   */
  canConfirmSetup: boolean
  /**
   * Whether the craftsman can mark the deposit as received (for cash or
   * out-of-band payments).
   */
  canMarkDepositReceived: boolean
  /** Unix timestamp (ms) of proposal acceptance */
  acceptedAt: number
  /** Pre-formatted date string of proposal acceptance */
  acceptedLabel: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// DEPOSIT_PERCENT exposed only for display purposes (e.g. "Freigabe (25 %)").
// Amount calculations use calculateTrancheAmounts so the split stays in sync
// with the escrow layer's canonical formula.
const DEPOSIT_PERCENT = 25

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isDepositConfirmed(state: Payment['state']): boolean {
  return (
    state === 'deposit_paid' ||
    state === 'in_escrow' ||
    state === 'work_in_progress' ||
    state === 'release_pending' ||
    state === 'released' ||
    state === 'refunded'
  )
}

/** Escrow plan statuses that indicate funding is confirmed. */
const ESCROW_FUNDED_STATUSES: ReadonlySet<EscrowPlanStatus> = new Set([
  'funded_in_escrow',
  'partially_released',
  'fully_released',
])

function getPhaseLabel(phase: PaymentPrepPhase): string {
  switch (phase) {
    case 'missing_amount':
      return 'Betrag fehlt'
    case 'ready_to_confirm':
      return 'Zahlungskarte vorbereiten'
    case 'deposit_initialized':
      return 'Zahlung ausstehend'
    case 'deposit_confirmed':
      return 'Zahlung bestätigt'
  }
}

function getPhaseDescription(phase: PaymentPrepPhase): string {
  switch (phase) {
    case 'missing_amount':
      return 'Das Angebot wurde angenommen, aber kein Betrag ist hinterlegt. Betrag im Angebotsentwurf ergänzen, um die Zahlungskarte vorzubereiten.'
    case 'ready_to_confirm':
      return 'Vereinbarten Betrag bestätigen und Zahlungskarte initialisieren. Der Kunde zahlt den vollständigen Betrag vorab in das Stripe-Absicherung ein.'
    case 'deposit_initialized':
      return 'Die Zahlungskarte ist eingerichtet. Zahlung durch den Kunden steht noch aus.'
    case 'deposit_confirmed':
      return 'Die Zahlung ist bestätigt. Der Betrag ist über Stripe abgesichert.'
  }
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Derives a view-model describing the craftsman's deposit/payment preparation
 * readiness for a job whose proposal has been accepted.
 *
 * Returns null when:
 * - `proposalAcceptedAt` is not set (payment prep is not yet applicable), or
 * - `payment` is provided but its state indicates the deposit phase is complete.
 *
 * This is a pure read helper — it performs no state mutations.
 *
 * @param job      The job entity.
 * @param payment  The associated payment entity (if one has been created).
 */
export function derivePaymentPrepReadiness(
  job: Job,
  payment: Payment | undefined
): PaymentPrepViewModel | null {
  if (!job.proposalAcceptedAt) return null

  const acceptedAt = job.proposalAcceptedAt
  const acceptedLabel = formatTimestamp(acceptedAt)

  // Use the canonical amount resolver (escrow → offer → job) so this card
  // displays the same order value as the rest of the provider detail surface.
  const canonicalAmount = resolveCanonicalAmount(job.id)
  const agreedAmount = canonicalAmount.amount ?? parseJobAmount(job.amount)

  // ── No amount on job ────────────────────────────────────────────────────
  if (agreedAmount === null) {
    return {
      phase: 'missing_amount',
      phaseLabel: getPhaseLabel('missing_amount'),
      phaseDescription: getPhaseDescription('missing_amount'),
      agreedAmount: null,
      agreedAmountFormatted: null,
      depositAmount: null,
      depositAmountFormatted: null,
      finalAmount: null,
      finalAmountFormatted: null,
      depositPercent: DEPOSIT_PERCENT,
      canConfirmSetup: false,
      canMarkDepositReceived: false,
      acceptedAt,
      acceptedLabel,
    }
  }

  // When a payment entity already exists, use its server-persisted amounts
  // directly so the display stays authoritative. Fall back to calculateTrancheAmounts
  // only when no payment has been created yet (ready_to_confirm preview).
  const { depositAmount, finalAmount } = payment
    ? { depositAmount: payment.amounts.depositAmount, finalAmount: payment.amounts.finalAmount }
    : calculateTrancheAmounts(agreedAmount)

  // ── Escrow plan funded — canonical truth takes precedence ────────────────
  // The escrow payment plan is the canonical source for escrow funding state.
  // When the plan says funded_in_escrow (or beyond), the deposit phase is
  // confirmed regardless of the legacy Payment state machine position.
  // This prevents showing "ausstehend" when the escrow is already funded but
  // the Payment bridge hasn't run yet (e.g., between webhook confirmation and
  // the next workflow step).
  const escrowPlan = getEscrowPlanByJobId(job.id)
  if (escrowPlan && ESCROW_FUNDED_STATUSES.has(escrowPlan.status)) {
    return {
      phase: 'deposit_confirmed',
      phaseLabel: getPhaseLabel('deposit_confirmed'),
      phaseDescription: getPhaseDescription('deposit_confirmed'),
      agreedAmount,
      agreedAmountFormatted: formatEuro(agreedAmount),
      depositAmount,
      depositAmountFormatted: formatEuro(depositAmount),
      finalAmount,
      finalAmountFormatted: formatEuro(finalAmount),
      depositPercent: DEPOSIT_PERCENT,
      canConfirmSetup: false,
      canMarkDepositReceived: false,
      acceptedAt,
      acceptedLabel,
    }
  }

  // ── Deposit already confirmed (legacy Payment state) ─────────────────────
  if (payment && isDepositConfirmed(payment.state)) {
    return {
      phase: 'deposit_confirmed',
      phaseLabel: getPhaseLabel('deposit_confirmed'),
      phaseDescription: getPhaseDescription('deposit_confirmed'),
      agreedAmount,
      agreedAmountFormatted: formatEuro(agreedAmount),
      depositAmount,
      depositAmountFormatted: formatEuro(depositAmount),
      finalAmount,
      finalAmountFormatted: formatEuro(finalAmount),
      depositPercent: DEPOSIT_PERCENT,
      canConfirmSetup: false,
      canMarkDepositReceived: false,
      acceptedAt,
      acceptedLabel,
    }
  }

  // ── Payment initialized with the agreed amount ───────────────────────────
  // Consider the card "initialized" if a payment exists and its total matches
  // the agreed amount (within rounding tolerance).
  // NOTE: payment.amounts.totalAmount read here is an engine-internal
  // validity check, not display truth. It verifies whether the payment
  // entity was created with the correct amount — not what to show the user.
  const amountMatches =
    payment !== undefined &&
    Math.abs(payment.amounts.totalAmount - agreedAmount) < 1

  if (amountMatches) {
    return {
      phase: 'deposit_initialized',
      phaseLabel: getPhaseLabel('deposit_initialized'),
      phaseDescription: getPhaseDescription('deposit_initialized'),
      agreedAmount,
      agreedAmountFormatted: formatEuro(agreedAmount),
      depositAmount,
      depositAmountFormatted: formatEuro(depositAmount),
      finalAmount,
      finalAmountFormatted: formatEuro(finalAmount),
      depositPercent: DEPOSIT_PERCENT,
      canConfirmSetup: false,
      canMarkDepositReceived: true,
      acceptedAt,
      acceptedLabel,
    }
  }

  // ── Ready to confirm ─────────────────────────────────────────────────────
  return {
    phase: 'ready_to_confirm',
    phaseLabel: getPhaseLabel('ready_to_confirm'),
    phaseDescription: getPhaseDescription('ready_to_confirm'),
    agreedAmount,
    agreedAmountFormatted: formatEuro(agreedAmount),
    depositAmount,
    depositAmountFormatted: formatEuro(depositAmount),
    finalAmount,
    finalAmountFormatted: formatEuro(finalAmount),
    depositPercent: DEPOSIT_PERCENT,
    canConfirmSetup: true,
    canMarkDepositReceived: false,
    acceptedAt,
    acceptedLabel,
  }
}
