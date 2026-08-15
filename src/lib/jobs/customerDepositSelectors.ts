import type { Job } from './types'
import type { Payment } from '../payments/types'
import { formatEuro } from '../payments/selectors'
import { parseJobAmount } from './paymentPrepSelectors'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'
import { isFundingRequestTerminalDead } from '../payments/fundingRequest/fundingRequestStatus'

/**
 * Describes where the customer stands in the deposit/payment flow after the
 * craftsman has accepted a proposal and (optionally) prepared the payment card.
 *
 * 'not_prepared'      – Proposal accepted but the craftsman has not yet
 *                       initialized the deposit card.  No action needed from
 *                       the customer yet.
 * 'deposit_required'  – Deposit card is live; customer must pay the deposit
 *                       amount to unlock the project.
 * 'deposit_paid'      – Customer's deposit has been received; waiting for the
 *                       craftsman to lock escrow and start work.
 * 'beyond_deposit'    – Work is underway or the payment journey is past the
 *                       deposit stage (in_escrow, work_in_progress, etc.).
 * 'funding_expired'   – The funding request is terminal-dead (expired or
 *                       cancelled). It can no longer be paid; the craftsman
 *                       must send a new request. No customer action possible.
 */
export type CustomerDepositPhase =
  | 'not_prepared'
  | 'deposit_required'
  | 'deposit_paid'
  | 'beyond_deposit'
  | 'funding_expired'

export type CustomerDepositViewModel = {
  /** Current phase of the customer-facing deposit journey */
  phase: CustomerDepositPhase
  /** Short human-readable phase label */
  phaseLabel: string
  /** Guidance text for the customer at the current phase */
  phaseDescription: string
  /** Agreed total amount (canonical order value), or null if unparseable */
  agreedAmount: number | null
  /** Pre-formatted agreed amount (e.g. "640,00 €") */
  agreedAmountFormatted: string | null
  /** Customer funding amount (100 % of agreed total in full-upfront model), or null */
  depositAmount: number | null
  /** Pre-formatted deposit amount */
  depositAmountFormatted: string | null
  /** Remaining amount after funding (always 0 in full-upfront model), or null */
  remainingAmount: number | null
  /** Pre-formatted remaining amount */
  remainingAmountFormatted: string | null
  /** Customer funding percentage – 100 in full-upfront escrow model */
  depositPercent: number
  /**
   * True when the customer must take action (i.e. deposit is due and has not
   * yet been confirmed).
   */
  customerActionRequired: boolean
  /** Unix timestamp (ms) of proposal acceptance, or null */
  acceptedAt: number | null
  /** Pre-formatted date/time label for acceptance, or null */
  acceptedLabel: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Customer funds 100 % of the order value upfront into escrow. */
const FUNDING_PERCENT = 100

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getPhaseLabelCustomer(phase: CustomerDepositPhase): string {
  switch (phase) {
    case 'not_prepared':
      return 'Zahlung wird vorbereitet'
    case 'deposit_required':
      return 'Zahlung erforderlich'
    case 'deposit_paid':
      return 'Zahlung bestätigt'
    case 'beyond_deposit':
      return 'Betrag über Stripe abgesichert'
    case 'funding_expired':
      return 'Anfrage abgelaufen'
  }
}

function getPhaseDescriptionCustomer(phase: CustomerDepositPhase): string {
  switch (phase) {
    case 'not_prepared':
      return 'Dein Handwerker bereitet die Zahlungskarte vor. Sobald alles eingerichtet ist, wird die Zahlung angefordert.'
    case 'deposit_required':
      return 'Der vollständige Betrag wird vorab über Stripe abgesichert. Freigabe erfolgt nach Leistungsfortschritt (25 % bei Arbeitsbeginn, 75 % bei Fertigstellung).'
    case 'deposit_paid':
      return 'Deine Zahlung ist eingegangen. Der Betrag wird über Stripe abgesichert.'
    case 'beyond_deposit':
      return 'Der Betrag ist vollständig über Stripe abgesichert. Freigabe erfolgt nach Leistungsfortschritt.'
    case 'funding_expired':
      return 'Die Zahlungsanfrage ist abgelaufen. Dein Handwerker muss eine neue Anfrage senden, damit du den Auftrag absichern kannst.'
  }
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Derives a view-model for the customer-facing deposit action surface after
 * a proposal has been accepted.
 *
 * Returns null when:
 * - `proposalAcceptedAt` is not set (deposit step not yet applicable).
 *
 * This is a pure read helper — it performs no state mutations.
 *
 * @param job      The job entity (must have `proposalAcceptedAt` set).
 * @param payment  The associated payment entity (may be undefined).
 */
export function deriveCustomerDepositAction(
  job: Job,
  payment: Payment | undefined,
  fundingStatus?: string
): CustomerDepositViewModel | null {
  if (!job.proposalAcceptedAt) return null

  const acceptedAt = job.proposalAcceptedAt
  const acceptedLabel = formatTimestamp(acceptedAt)

  // Use the canonical amount resolver (escrow → offer → job) so this card
  // displays the same order value as every other surface.
  // Fallback chain:
  //   1. Canonical resolver (escrow → offer → job hierarchy)
  //   2. Raw job.amount (last resort before any payment is created)
  // payment.amounts is NOT used — it represents legacy 25/75 deposit model.
  const canonicalAmount = resolveCanonicalAmount(job.id)
  let agreedAmount: number | null = canonicalAmount.amount
  if (agreedAmount === null) {
    agreedAmount = parseJobAmount(job.amount)
  }

  const amountFields =
    agreedAmount !== null
      ? (() => {
          // Full-upfront escrow model: customer funds 100 % of the order value.
          // The 25/75 split applies to release tranches, NOT to what the customer
          // pays.  depositAmount = full agreed amount (escrow funding).
          // remainingAmount is 0 because the customer pays everything upfront.
          const depositAmount = agreedAmount
          const remainingAmount = 0
          return {
            agreedAmount,
            agreedAmountFormatted: formatEuro(agreedAmount),
            depositAmount,
            depositAmountFormatted: formatEuro(depositAmount),
            remainingAmount,
            remainingAmountFormatted: formatEuro(remainingAmount),
          }
        })()
      : {
          agreedAmount: null,
          agreedAmountFormatted: null,
          depositAmount: null,
          depositAmountFormatted: null,
          remainingAmount: null,
          remainingAmountFormatted: null,
        }

  // Determine phase from payment state
  const state = payment?.state

  if (
    state === 'in_escrow' ||
    state === 'work_in_progress' ||
    state === 'release_pending' ||
    state === 'released' ||
    state === 'disputed' ||
    state === 'refunded'
  ) {
    return {
      phase: 'beyond_deposit',
      phaseLabel: getPhaseLabelCustomer('beyond_deposit'),
      phaseDescription: getPhaseDescriptionCustomer('beyond_deposit'),
      ...amountFields,
      depositPercent: FUNDING_PERCENT,
      customerActionRequired: false,
      acceptedAt,
      acceptedLabel,
    }
  }

  if (state === 'deposit_paid') {
    return {
      phase: 'deposit_paid',
      phaseLabel: getPhaseLabelCustomer('deposit_paid'),
      phaseDescription: getPhaseDescriptionCustomer('deposit_paid'),
      ...amountFields,
      depositPercent: FUNDING_PERCENT,
      customerActionRequired: false,
      acceptedAt,
      acceptedLabel,
    }
  }

  if (state === 'deposit_required') {
    // Funded truth dominates: if funding is confirmed for this job,
    // treat the deposit as paid regardless of stale payment.state
    if (fundingStatus === 'funded') {
      return {
        phase: 'deposit_paid',
        phaseLabel: getPhaseLabelCustomer('deposit_paid'),
        phaseDescription: getPhaseDescriptionCustomer('deposit_paid'),
        ...amountFields,
        depositPercent: FUNDING_PERCENT,
        customerActionRequired: false,
        acceptedAt,
        acceptedLabel,
      }
    }
    // Terminal-dead funding (expired / cancelled): the request can no longer be
    // paid. Surface an honest 'funding_expired' phase with NO customer action —
    // NOT 'deposit_required' (would tell the customer to pay a dead request) and
    // NOT 'not_prepared' (would wrongly imply the craftsman never prepared it).
    if (isFundingRequestTerminalDead(fundingStatus)) {
      return {
        phase: 'funding_expired',
        phaseLabel: getPhaseLabelCustomer('funding_expired'),
        phaseDescription: getPhaseDescriptionCustomer('funding_expired'),
        ...amountFields,
        depositPercent: FUNDING_PERCENT,
        customerActionRequired: false,
        acceptedAt,
        acceptedLabel,
      }
    }
    return {
      phase: 'deposit_required',
      phaseLabel: getPhaseLabelCustomer('deposit_required'),
      phaseDescription: getPhaseDescriptionCustomer('deposit_required'),
      ...amountFields,
      depositPercent: FUNDING_PERCENT,
      customerActionRequired: true,
      acceptedAt,
      acceptedLabel,
    }
  }

  // No payment or unrecognized state → craftsman hasn't prepared the card yet
  return {
    phase: 'not_prepared',
    phaseLabel: getPhaseLabelCustomer('not_prepared'),
    phaseDescription: getPhaseDescriptionCustomer('not_prepared'),
    ...amountFields,
    depositPercent: FUNDING_PERCENT,
    customerActionRequired: false,
    acceptedAt,
    acceptedLabel,
  }
}
